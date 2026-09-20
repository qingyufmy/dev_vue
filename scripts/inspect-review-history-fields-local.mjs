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
  const tables = ['trade_review_cases','trade_review_versions','manual_trade_review_cases','manual_trade_review_versions','manual_trade_review_sources','manual_trade_review_jobs','manual_trade_review_stage_runs','manual_trade_review_counterfactual_points','period_review_cases','period_review_versions','period_review_sources','period_review_jobs','period_review_job_events','period_review_derivation_jobs','period_review_monthly_checkpoints','period_review_user_states']
  report.schemas = {}
  for (const table of tables) {
    const [columns] = await db.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[table])
    report.schemas[table] = columns
  }
  report.caseFields = {}
  for (const table of tables.filter(name=>name.endsWith('_cases'))) {
    const selected = report.schemas[table].map(row=>row.name).filter(name=> /^(id|user_id|trading_account_id|status|evidence_status|strategy_id|strategy_version|current_version_id|approved_version_id|period_start_ms|period_end_ms|created_at|updated_at|approved_at|approved_by|terminal_timezone_offset_minutes|period_key|period_type|symbol)$/.test(name))
    const [rows] = await db.query('SELECT '+selected.map(name=>'CAST(`'+name+'` AS CHAR) `'+name+'`').join(',')+' FROM '+table+' ORDER BY id')
    report.caseFields[table] = rows
  }
  report.versionFields = {}
  for (const table of tables.filter(name=>name.endsWith('_versions'))) {
    const selected = report.schemas[table].map(row=>row.name).filter(name=>!/(json|text|content|note)/.test(name))
    const [rows] = await db.query('SELECT '+selected.map(name=>'CAST(`'+name+'` AS CHAR) `'+name+'`').join(',')+',SHA2(content_json,256) raw_sha256,OCTET_LENGTH(content_json) raw_bytes FROM '+table+' ORDER BY id')
    report.versionFields[table] = rows
  }
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name; process.exitCode = 1 }
finally {
  if (db) { await db.rollback(); await db.end() }
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({passed:report.passed,errorCode:report.errorCode,tables:Object.keys(report.schemas??{}).length}))
}
