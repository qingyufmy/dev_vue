import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { foundationNames } from './lib/inplace-foundation-upgrade.mjs'
import { accountBuildNames } from './lib/inplace-account-build.mjs'
import { sourceEvidenceTable } from './lib/inplace-source-evidence-upgrade.mjs'
import { validateColumnEvidence, readOriginalRows, verifyOriginalSchema } from './lib/inplace-column-evidence.mjs'
import { loadStrategyUpgrade, strategyStore, executeStrategyUpgrade, strategyTableNames } from './lib/inplace-strategy-upgrade.mjs'

const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode, base, output] = process.argv.slice(2)
  check(mode === '--rehearse' && process.argv.length === 5 && process.platform === 'linux' && process.getuid() === 0, 'inplace_strategy_arguments')
  const backup = await json(`${base}/artifacts/receipt.json`), columns = await json(`${base}/column-rehearsal/receipt.json`)
  validateColumnEvidence(backup, columns)
  const database = backup.target
  check(database === 'dev_vue_m1_source_20260906_01', 'inplace_strategy_database')
  const fd = Number(process.env.V4_BACKUP_CREDENTIAL_FD)
  check(Number.isInteger(fd) && fd >= 3, 'inplace_strategy_credential')
  const config = await json(`/proc/self/fd/${fd}`)
  const { default: mysql } = await import(pathToFileURL(process.env.V4_BACKUP_MYSQL2_MODULE).href)
  const plan = await loadStrategyUpgrade(root)
  const toolManifest = await json(`${base}/strategy-rehearsal/tools.json`)
  for (const tool of toolManifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(tool.path) && !tool.path.split('/').includes('..'), 'inplace_strategy_tool_path')
    check(sha256(await readFile(new URL(tool.path, root))) === tool.sha256, 'inplace_strategy_tool_changed')
  }
  const connect = async () => {
    const c = await mysql.createConnection({ ...config, database, timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
    try {
      const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid')
      check(identity.db === database && identity.uuid === backup.serverUuid, 'inplace_strategy_instance')
      await c.query("SET SESSION time_zone='+00:00'")
      await c.query('SET SESSION autocommit=1')
      await c.query('SET SESSION lock_wait_timeout=10')
      check(await verifyInplaceJournal(c), 'inplace_strategy_journal')
      return c
    } catch (error) { c.destroy(); throw error }
  }
  const excluded = [...foundationNames, ...accountBuildNames, sourceEvidenceTable, ...strategyTableNames]
  let ddlExecutions = 0
  const faults = [], runs = []
  const run = async injectId => withInplaceUpgradeLock(connection, database, async () => {
    const store = strategyStore(connection, mysqlColumnStore(connection, true), plan)
    await executeStrategyUpgrade(store, plan)
    await verifyOriginalSchema(connection, backup.schemaSha256, excluded)
    const original = await readOriginalRows(connection, columns.originalColumns)
    check(JSON.stringify(original) === JSON.stringify(columns.parity), 'inplace_strategy_original_changed')
    for (const step of plan.steps) for (const match of step.sql.matchAll(/CONSTRAINT `([a-z][a-z0-9_]*)`/g)) {
      const [rows] = await connection.execute('SELECT TABLE_NAME name FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME=?', [match[1]])
      check(rows.every(row => row.name === step.table), 'inplace_strategy_constraint_collision')
    }
    const execute = store.execute
    store.execute = async sql => {
      await execute(sql); ddlExecutions++
      if (sql === plan.steps.find(step => step.id === injectId)?.sql) {
        faults.push(injectId); connection.destroy(); throw new Error('inplace_strategy_injected_loss')
      }
    }
    return executeStrategyUpgrade(store, plan, { apply: true })
  })
  connection = await connect()
  for (const index of [0, 2]) {
    await run(plan.steps[index].id).catch(error => { if (error.message !== 'inplace_strategy_injected_loss') throw error })
    check(faults.at(-1) === plan.steps[index].id, 'inplace_strategy_fault_missing')
    connection = await connect()
  }
  runs.push(await run(null))
  check(runs[0].steps[2].status === 'reconciled', 'inplace_strategy_recovery_missing')
  runs.push(await run(null))
  check(ddlExecutions === 3 && runs[1].steps.every(step => step.status === 'completed'), 'inplace_strategy_repeat_failed')
  for (const table of strategyTableNames) {
    const [[row]] = await connection.query(`SELECT COUNT(*) n FROM \`${table}\``)
    check(String(row.n) === '0', 'inplace_strategy_unexpected_rows')
  }
  const report = { kind: 'dev_vue_strategy_schema_rehearsal', status: 'verified', database, serverUuid: backup.serverUuid,
    backupSnapshotId: backup.sourceSnapshotId, completedAtUtc: new Date().toISOString(), faults, ddlExecutions, runs,
    steps: plan.steps.map(({ id, checksum, beforeHash, afterHash }) => ({ id, checksum, beforeHash, afterHash })),
    rootStatements: plan.originals, toolManifest, originalTablesVerified: columns.parity.length,
    originalRowsVerified: columns.parity.reduce((sum, row) => sum + BigInt(row.rows), 0n).toString(),
    noBusinessRowsSeeded: true, sourceDatabaseWritten: false, repeatNoop: true, fullNormalizationComplete: false }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ status: report.status, database, ddlExecutions, faults, originalRowsVerified: report.originalRowsVerified }))
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? (/^inplace_[a-z_]+$/.test(error.message) ? error.message : 'inplace_strategy_rehearsal_failed') }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
