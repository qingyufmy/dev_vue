import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'review-transition-inventory/v1', passed: false, writes: 0, cases: [], tables: [] }
let db
try {
  db = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true })
  const [[identity]] = await db.query('SELECT @@server_uuid uuid')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  for (const table of ['trade_review_cases', 'manual_trade_review_cases', 'period_review_cases']) {
    const [groups] = await db.query(`SELECT user_id,status,evidence_status,COUNT(*) n,SUM(current_version_id IS NOT NULL) with_version,
      SUM(approved_version_id IS NOT NULL) with_approval FROM ${table} GROUP BY user_id,status,evidence_status ORDER BY user_id,status,evidence_status`)
    report.cases.push({ table, groups })
  }
  for (const table of ['trade_review_versions', 'manual_trade_review_versions', 'manual_trade_review_sources', 'manual_trade_review_jobs',
    'manual_trade_review_stage_runs', 'manual_trade_review_counterfactual_points', 'period_review_versions', 'period_review_sources',
    'period_review_jobs', 'period_review_job_events', 'period_review_derivation_jobs', 'period_review_monthly_checkpoints',
    'period_review_user_states', 'review_cases_v4', 'review_versions_v4']) {
    const [[row]] = await db.query('SELECT COUNT(*) n FROM ' + table)
    report.tables.push({ table, rows: Number(row.n) })
  }
  const [lineage] = await db.query(`SELECT c.strategy_id,c.strategy_version,COUNT(*) cases,
    SUM(EXISTS(SELECT 1 FROM strategy_versions v WHERE v.legacy_source_table='auto_prompt_types'
      AND v.legacy_id=CONCAT(c.strategy_id,':trader:v',c.strategy_version))) mapped_trader_versions
    FROM period_review_cases c GROUP BY c.strategy_id,c.strategy_version ORDER BY c.strategy_id,c.strategy_version`)
  report.periodStrategyLineage = lineage
  const [[owners]] = await db.query(`SELECT COUNT(*) historical_owner_cases FROM period_review_cases c
    WHERE NOT EXISTS(SELECT 1 FROM trading_account_ownerships o WHERE o.trading_account_id=c.trading_account_id
      AND o.user_id=c.user_id AND o.role='owner' AND o.revoked_at_utc IS NULL)`)
  report.periodCasesWithoutCurrentOwnership = Number(owners.historical_owner_cases)
  const [[type]] = await db.execute("SELECT COLUMN_TYPE kind FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='review_cases_v4' AND COLUMN_NAME='kind'")
  report.targetKind = type.kind
  const [versions] = await db.query('SELECT content_json FROM period_review_versions ORDER BY id')
  const shapes = new Map()
  for (const row of versions) {
    const content = JSON.parse(row.content_json)
    assert.ok(content && typeof content === 'object' && !Array.isArray(content))
    const keys = Object.keys(content).sort().join(',')
    shapes.set(keys, (shapes.get(keys) ?? 0) + 1)
  }
  report.periodContentShapes = [...shapes].map(([keys, count]) => ({ keys: keys.split(','), count }))
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name; process.exitCode = 1 }
finally {
  if (db) { await db.rollback(); await db.end() }
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, errorCode: report.errorCode, cases: report.cases.reduce((sum, table) => sum + table.groups.reduce((n, group) => n + Number(group.n), 0), 0), periodStrategyLineage: report.periodStrategyLineage }))
}
