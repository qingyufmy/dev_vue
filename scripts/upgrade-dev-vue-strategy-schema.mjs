import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { foundationNames } from './lib/inplace-foundation-upgrade.mjs'
import { accountBuildNames } from './lib/inplace-account-build.mjs'
import { sourceEvidenceTable } from './lib/inplace-source-evidence-upgrade.mjs'
import { validateColumnEvidence, readOriginalRows, verifyOriginalSchema } from './lib/inplace-column-evidence.mjs'
import { loadStrategyUpgrade, strategyStore, executeStrategyUpgrade, strategyTableNames } from './lib/inplace-strategy-upgrade.mjs'

const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--plan', '--apply'].includes(mode), 'inplace_strategy_arguments')
  const apply = mode === '--apply'
  const backup = await json('docs/migration/dev-vue-inplace-backup-20260906.json')
  const columns = await json('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json')
  validateColumnEvidence(backup, columns)
  const plan = await loadStrategyUpgrade(root)
  const stepChecksums = plan.steps.map(({ id, checksum, beforeHash, afterHash }) => ({ id, checksum, beforeHash, afterHash }))
  const proof = await json('docs/migration/dev-vue-strategy-schema-rehearsal-20260906.json')
  check(proof.kind === 'dev_vue_strategy_schema_rehearsal' && proof.status === 'verified' && proof.database === backup.target
    && proof.serverUuid === backup.serverUuid && proof.backupSnapshotId === backup.sourceSnapshotId && proof.repeatNoop === true
    && proof.ddlExecutions === 3 && JSON.stringify(proof.steps) === JSON.stringify(stepChecksums)
    && JSON.stringify(proof.rootStatements) === JSON.stringify(plan.originals), 'inplace_strategy_rehearsal_invalid')
  for (const file of proof.toolManifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..'), 'inplace_strategy_tool_path')
    check(sha256(await readFile(new URL(file.path, root))) === file.sha256, 'inplace_strategy_tools_changed')
  }
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'inplace_strategy_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'inplace_strategy_instance')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('SET SESSION lock_wait_timeout=10')
  check(await verifyInplaceJournal(connection), 'inplace_strategy_journal')
  const excluded = [...foundationNames, ...accountBuildNames, sourceEvidenceTable, ...strategyTableNames]
  let ddlExecutions = 0
  const result = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    const store = strategyStore(connection, mysqlColumnStore(connection, true), plan)
    const preview = await executeStrategyUpgrade(store, plan)
    await verifyOriginalSchema(connection, backup.schemaSha256, excluded)
    const original = await readOriginalRows(connection, columns.originalColumns)
    check(JSON.stringify(original) === JSON.stringify(columns.parity), 'inplace_strategy_original_changed')
    for (const step of plan.steps) for (const match of step.sql.matchAll(/CONSTRAINT `([a-z][a-z0-9_]*)`/g)) {
      const [rows] = await connection.execute('SELECT TABLE_NAME name FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME=?', [match[1]])
      check(rows.every(row => row.name === step.table), 'inplace_strategy_constraint_collision')
    }
    if (!apply) return preview
    const execute = store.execute
    store.execute = async sql => { await execute(sql); ddlExecutions++ }
    const applied = await executeStrategyUpgrade(store, plan, { apply: true })
    const repeated = await executeStrategyUpgrade(store, plan, { apply: true })
    check(repeated.steps.every(step => step.status === 'completed'), 'inplace_strategy_repeat_failed')
    await verifyOriginalSchema(connection, backup.schemaSha256, excluded)
    check(JSON.stringify(await readOriginalRows(connection, columns.originalColumns)) === JSON.stringify(original), 'inplace_strategy_original_changed')
    for (const table of strategyTableNames) {
      const [[row]] = await connection.query(`SELECT COUNT(*) n FROM \`${table}\``)
      check(String(row.n) === '0', 'inplace_strategy_unexpected_rows')
    }
    return applied
  })
  const [[counts]] = await connection.query('SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()) table_count,(SELECT COUNT(*) FROM database_upgrade_steps_v4 WHERE status=\'completed\') completed_steps')
  const report = { kind: 'dev_vue_strategy_schema_upgrade', status: apply ? 'verified' : 'planned', database: 'dev_vue', serverUuid: identity.uuid,
    backupSnapshotId: backup.sourceSnapshotId, completedAtUtc: new Date().toISOString(), result, stepChecksums, ddlExecutions, counts,
    originalTablesVerified: columns.parity.length, originalRowsVerified: columns.parity.reduce((sum, row) => sum + BigInt(row.rows), 0n).toString(),
    repeatNoop: apply, noBusinessRowsSeeded: true, sourceRenamed: false, fullNormalizationComplete: false }
  if (apply) await writeFile(new URL(`docs/migration/dev-vue-strategy-schema-${ddlExecutions ? 'apply' : 'repeat'}-20260906.json`, root), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(report))
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? (/^inplace_[a-z_]+$/.test(error.message) ? error.message : 'inplace_strategy_upgrade_failed') }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
