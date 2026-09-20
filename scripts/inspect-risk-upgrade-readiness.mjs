import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { readRiskStructureTable } from './lib/mysql-risk-structure-state.mjs'
import { riskStructureTables } from './lib/risk-structure-source.mjs'

const targets = ['risk_policy_sets_v4', 'risk_policy_versions_v4', 'risk_policy_change_items_v4',
  'account_risk_states', 'account_risk_summaries', 'risk_state_events', 'risk_decisions_v4',
  'risk_decision_payloads_v4', 'risk_manual_releases', 'global_risk_controls']
const sources = ['risk_policy_sets', 'risk_policy_versions', 'risk_policy_change_items', 'risk_profiles',
  'risk_account_state', 'risk_decisions', 'risk_rule_rollouts', 'global_risk_control']
const dependencies = ['users', 'trading_accounts', 'trading_account_ownerships', 'trade_decisions',
  'trade_decision_payloads', 'ai_trader_runs', 'market_analyses', 'strategy_subscriptions',
  'outbox_events', 'account_runtime_snapshots', 'trading_projection_revisions', 'market_quotes', 'market_instrument_snapshots']
const names = [...new Set([...targets, ...sources, ...dependencies])]
const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254')
assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
let connection
try {
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue')
  assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const marks = names.map(() => '?').join(',')
  const [tables] = await connection.execute(`SELECT TABLE_NAME name,ENGINE engine FROM information_schema.tables
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks}) ORDER BY TABLE_NAME`, names)
  const [columns] = await connection.execute(`SELECT TABLE_NAME tableName,COLUMN_NAME name,COLUMN_TYPE type,
    IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,EXTRA extra FROM information_schema.columns
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks}) ORDER BY TABLE_NAME,ORDINAL_POSITION`, names)
  const [keys] = await connection.execute(`SELECT TABLE_NAME tableName,CONSTRAINT_NAME constraintName,
    COLUMN_NAME columnName,REFERENCED_TABLE_NAME referencedTable,REFERENCED_COLUMN_NAME referencedColumn
    FROM information_schema.key_column_usage WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks})
    ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`, names)
  const present = new Set(tables.map(row => row.name))
  const counts = {}
  // Identifiers come only from the fixed list above. Dependency payloads are never read.
  for (const name of [...targets, ...sources].filter(name => present.has(name))) {
    const [[row]] = await connection.query(`SELECT COUNT(*) n FROM \`${name}\``)
    counts[name] = String(row.n)
  }
  const controls = {}
  for (const [table, column] of [['global_risk_control', 'global_kill_switch'], ['global_risk_controls', 'kill_switch']]) {
    if (!present.has(table) || !columns.some(row => row.tableName === table && row.name === column)) continue
    const [rows] = await connection.query(`SELECT \`${column}\` enabled,COUNT(*) n FROM \`${table}\` GROUP BY \`${column}\``)
    controls[table] = rows.map(row => ({ enabled: row.enabled, count: String(row.n) }))
  }
  const structureStates = {}
  for (const table of riskStructureTables) structureStates[table] = await readRiskStructureTable(connection, table)
  await connection.rollback()
  const sourceMigrations = []
  for (const file of ['20260903_007_deterministic_risk_review.sql', '20260903_008_manual_risk_release.sql']) {
    const bytes = await readFile(new URL(`../server/db/migrations/${file}`, import.meta.url))
    sourceMigrations.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  const report = { kind: 'risk-upgrade-readiness/v1', inspected: true, observedAt: new Date().toISOString(), identity,
    missingTargets: targets.filter(name => !present.has(name)), missingSources: sources.filter(name => !present.has(name)),
    missingDependencies: dependencies.filter(name => !present.has(name)), counts, controls, tables, columns, keys, sourceMigrations, structureStates,
    scope: 'Read-only metadata and aggregate counts. No DDL, DML, payload, policy reason or credentials exported. Counts share an InnoDB snapshot; metadata is not a schema lock. Not upgrade approval, full data mapping, or runtime acceptance.' }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ inspected: true, missingTargets: report.missingTargets, missingDependencies: report.missingDependencies, counts, controls }))
} catch (error) {
  await output.writeFile(JSON.stringify({ inspected: false, code: 'risk_upgrade_readiness_failed', driverCode: error.code }) + '\n')
  console.log(JSON.stringify({ inspected: false, code: 'risk_upgrade_readiness_failed', driverCode: error.code }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  await pool.end()
  await output.sync()
  await output.close()
}
