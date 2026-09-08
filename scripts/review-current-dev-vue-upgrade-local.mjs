import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { readAccountBackfillV2Identity } from './lib/mysql-account-backfill-v2.mjs'
import { mysqlColumnStore } from './lib/mysql-inplace-column-store.mjs'
import { loadTradingContextChanges } from './lib/inplace-trading-context-changes.mjs'

// Current-database observation only. This cannot prepare or execute a migration.
const root = new URL('../', import.meta.url)
const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--read-only' && isAbsolute(destination ?? '') && process.argv.length === 4)
let connection
try {
  const env = parse(await readFile(new URL('server/.env', root)))
  assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  const plan = await loadTradingContextChanges(root)
  const frozen = JSON.parse(await readFile(new URL('docs/architecture/context-changes-plan-20260908.json', root)))
  for (const tool of frozen.tools) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256)
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'dev_vue', timezone: 'Z', dateStrings: true,
    jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version,@@session.time_zone timeZone')
  assert.equal(identity.db, 'dev_vue')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const schemaIdentity = await readAccountBackfillV2Identity(connection)
  const journal = mysqlColumnStore(connection, true)
  const history = await journal.history()
  assert.equal(history.length, 147)
  const byId = new Map(history.map(row => [row.id, row]))
  for (const step of plan.steps.slice(0, 147)) {
    const row = byId.get(step.id)
    assert.ok(row?.status === 'completed' && row.checksum === step.checksum)
  }
  const metadata = async () => {
    const [tables] = await connection.query('SELECT TABLE_NAME name,TABLE_TYPE kind,ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
    return tables
  }
  const tables = await metadata()
  const counts = []
  for (const name of ['users', 'trading_accounts', 'mt5_account_ownership_history', 'trading_accounts_v4_build',
    'trading_account_ownerships_v4_build', 'trading_account_ownership_intervals_v4_build', 'user_trading_account_settings_v4_build']) {
    const [[row]] = await connection.query(`SELECT COUNT(*) count FROM \`${name}\``)
    counts.push({ table: name, rows: String(row.count) })
  }
  assert.deepEqual(await journal.history(), history)
  assert.deepEqual(await metadata(), tables)
  await connection.rollback()
  const report = { kind: 'current-dev-vue-upgrade-observation/v1', observedAt: new Date().toISOString(), identity,
    schemaIdentity, completedSteps: history.length, targetSteps: plan.steps.length, historySha256: hash(history),
    registrySha256: hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))),
    frozenMigrationFilesVerified: frozen.tools.length, tables, counts,
    pendingSteps: plan.steps.slice(history.length).map(({ id, checksum, table }) => ({ id, checksum, table })),
    contextReceiptTablePresent: tables.some(table => table.name === 'trading_context_changes_v4'),
    migrationReady: false, runtimeReady: false, databaseWrites: 0,
    limits: 'Read-only consistent data snapshot and repeated metadata; not a backup, writer quiescence, full row reconciliation, or executable upgrade proof. Current-database backfill and promotion evidence must be prepared separately.',
    tool: { path: 'scripts/review-current-dev-vue-upgrade-local.mjs', sha256: sha256(await readFile(new URL('scripts/review-current-dev-vue-upgrade-local.mjs', root))) } }
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ identity, completedSteps: report.completedSteps, targetSteps: report.targetSteps,
    pendingSteps: report.pendingSteps, tableCount: tables.length, counts, migrationReady: false, databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ failed: true, code: /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'current_dev_vue_upgrade_observation_failed' }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
