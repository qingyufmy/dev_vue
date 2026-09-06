import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { foundationNames } from './lib/inplace-foundation-upgrade.mjs'
import { accountBuildNames } from './lib/inplace-account-build.mjs'
import { sourceEvidenceTable } from './lib/inplace-source-evidence-upgrade.mjs'
import { validateColumnEvidence, readOriginalRows, verifyOriginalSchema } from './lib/inplace-column-evidence.mjs'
import { strategyTableNames } from './lib/inplace-strategy-upgrade.mjs'
import { loadSubscriptionBuild, subscriptionBuildStore, executeSubscriptionBuild, subscriptionBuildNames } from './lib/inplace-subscription-build.mjs'

const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode, base, output] = process.argv.slice(2)
  check(mode === '--rehearse' && process.argv.length === 5 && process.platform === 'linux' && process.getuid() === 0, 'inplace_subscription_arguments')
  const backup = await json(`${base}/artifacts/receipt.json`), columns = await json(`${base}/column-rehearsal/receipt.json`)
  validateColumnEvidence(backup, columns)
  const database = backup.target
  check(database === 'dev_vue_m1_source_20260906_01', 'inplace_subscription_database')
  const fd = Number(process.env.V4_BACKUP_CREDENTIAL_FD)
  check(Number.isInteger(fd) && fd >= 3, 'inplace_subscription_credential')
  const config = await json(`/proc/self/fd/${fd}`)
  const { default: mysql } = await import(pathToFileURL(process.env.V4_BACKUP_MYSQL2_MODULE).href)
  const plan = await loadSubscriptionBuild(root)
  const toolManifest = await json(new URL('../tools.json', root))
  for (const tool of toolManifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(tool.path) && !tool.path.split('/').includes('..'), 'inplace_subscription_tool_path')
    check(sha256(await readFile(new URL(tool.path, root))) === tool.sha256, 'inplace_subscription_tool_changed')
  }
  const connect = async () => {
    const c = await mysql.createConnection({ ...config, database, timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
    try {
      const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid')
      check(identity.db === database && identity.uuid === backup.serverUuid, 'inplace_subscription_instance')
      await c.query("SET SESSION time_zone='+00:00'")
      await c.query('SET SESSION autocommit=1')
      await c.query('SET SESSION lock_wait_timeout=10')
      check(await verifyInplaceJournal(c), 'inplace_subscription_journal')
      return c
    } catch (error) { c.destroy(); throw error }
  }
  const excluded = [...foundationNames, ...accountBuildNames, sourceEvidenceTable, ...strategyTableNames, ...subscriptionBuildNames]
  let ddlExecutions = 0
  const faults = [], runs = []
  const run = async injectId => withInplaceUpgradeLock(connection, database, async () => {
    const store = subscriptionBuildStore(connection, mysqlColumnStore(connection, true), plan)
    await executeSubscriptionBuild(store, plan)
    await verifyOriginalSchema(connection, backup.schemaSha256, excluded)
    const original = await readOriginalRows(connection, columns.originalColumns)
    check(JSON.stringify(original) === JSON.stringify(columns.parity), 'inplace_subscription_original_changed')
    for (const step of plan.steps) for (const match of step.sql.matchAll(/CONSTRAINT `([a-z][a-z0-9_]*)`/g)) {
      const [rows] = await connection.execute('SELECT TABLE_NAME name FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME=?', [match[1]])
      check(rows.every(row => row.name === step.table), 'inplace_subscription_constraint_collision')
    }
    const execute = store.execute
    store.execute = async sql => {
      await execute(sql); ddlExecutions++
      if (sql === plan.steps.find(step => step.id === injectId)?.sql) {
        faults.push(injectId); connection.destroy(); throw new Error('inplace_subscription_injected_loss')
      }
    }
    return executeSubscriptionBuild(store, plan, { apply: true })
  })
  connection = await connect()
  const history = await mysqlColumnStore(connection, true).history()
  const resumedFirst = history.find(row => row.id === plan.steps[0].id)?.status === 'started'
  if (resumedFirst) {
    check(!history.some(row => plan.steps.slice(1).some(step => step.id === row.id)), 'inplace_subscription_resume_prefix')
    const store = subscriptionBuildStore(connection, mysqlColumnStore(connection, true), plan)
    check(await store.tableHash(plan.steps[0].table) === plan.steps[0].afterHash, 'inplace_subscription_resume_schema')
    ddlExecutions = 1; faults.push(plan.steps[0].id)
  }
  for (const index of resumedFirst ? [2] : [0, 2]) {
    await run(plan.steps[index].id).catch(error => { if (error.message !== 'inplace_subscription_injected_loss') throw error })
    check(faults.at(-1) === plan.steps[index].id, 'inplace_subscription_fault_missing')
    connection = await connect()
  }
  runs.push(await run(null))
  check(runs[0].steps[2].status === 'reconciled', 'inplace_subscription_recovery_missing')
  runs.push(await run(null))
  check(ddlExecutions === 3 && runs[1].steps.every(step => step.status === 'completed'), 'inplace_subscription_repeat_failed')
  for (const table of subscriptionBuildNames) {
    const [[row]] = await connection.query(`SELECT COUNT(*) n FROM \`${table}\``)
    check(String(row.n) === '0', 'inplace_subscription_unexpected_rows')
  }
  await verifyOriginalSchema(connection, backup.schemaSha256, excluded)
  check(JSON.stringify(await readOriginalRows(connection, columns.originalColumns)) === JSON.stringify(columns.parity), 'inplace_subscription_original_changed')
  const report = { kind: 'dev_vue_subscription_schema_rehearsal', status: 'verified', database, serverUuid: backup.serverUuid,
    backupSnapshotId: backup.sourceSnapshotId, completedAtUtc: new Date().toISOString(), faults, ddlExecutions, resumedFirst, runs,
    steps: plan.steps.map(({ id, checksum, beforeHash, afterHash }) => ({ id, checksum, beforeHash, afterHash })),
    toolManifest, originalTablesVerified: columns.parity.length,
    originalRowsVerified: columns.parity.reduce((sum, row) => sum + BigInt(row.rows), 0n).toString(),
    noBusinessRowsSeeded: true, sourceDatabaseWritten: false, repeatNoop: true, fullNormalizationComplete: false }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ status: report.status, database, ddlExecutions, faults, originalRowsVerified: report.originalRowsVerified }))
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? (/^inplace_[a-z_]+$/.test(error.message) ? error.message : 'inplace_subscription_rehearsal_failed') }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
