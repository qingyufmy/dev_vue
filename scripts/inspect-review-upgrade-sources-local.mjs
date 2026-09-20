import { mysqlColumnStore, verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { loadHistoryRuntimeUpgrade } from './lib/history-runtime-upgrade.mjs'
import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'

const reviewSql = await readFile(new URL('../server/db/migrations/20260904_012_review_memory_core.sql', import.meta.url), 'utf8')
const names = [...reviewSql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z0-9_]+)/g)].map(match => match[1])
names.push('review_write_receipts_v4')
const parents = ['users','trading_accounts','trading_account_ownerships','strategies','strategy_versions','strategy_subscriptions','ai_model_profiles','outbox_events']
const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'review-upgrade-source-inventory/v1', inspected: false, writes: 0 }
let connection
try {
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, dateStrings: true, timezone: 'Z' })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  report.identity = identity
  const [tables] = await connection.execute(`SELECT TABLE_NAME name,TABLE_TYPE kind,ENGINE engine FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND (TABLE_NAME REGEXP 'review|memory|migration' OR TABLE_NAME IN (${parents.map(() => '?').join(',')})) ORDER BY TABLE_NAME`, parents)
  report.present = tables.filter(table => names.includes(table.name))
  report.missing = names.filter(name => !tables.some(table => table.name === name))
  report.sources = tables.filter(table => !names.includes(table.name) && !parents.includes(table.name))
  report.definitions = {}; report.counts = {}
  for (const table of tables) {
    assert.match(table.name, /^[a-z0-9_]+$/)
    assert.equal(table.kind, 'BASE TABLE')
    const [[definition]] = await connection.query(`SHOW CREATE TABLE \`${table.name}\``)
    report.definitions[table.name] = definition['Create Table']
    if (!parents.includes(table.name)) {
      const [[count]] = await connection.query(`SELECT COUNT(*) quantity FROM \`${table.name}\``)
      report.counts[table.name] = count.quantity
    }
  }
  assert.ok(await verifyInplaceJournal(connection))
  const history = await mysqlColumnStore(connection, true).history()
  const reference = JSON.parse(await readFile(new URL('../docs/architecture/history-runtime-reference-20260909.json', import.meta.url), 'utf8'))
  const plan = await loadHistoryRuntimeUpgrade(new URL('../', import.meta.url), reference)
  const actual = new Map(history.map(row => [row.id, row]))
  const mismatched = plan.steps.filter(step => actual.get(step.id)?.checksum !== step.checksum || actual.get(step.id)?.status !== 'completed').map(step => step.id)
  report.upgradeJournal = { table: 'database_upgrade_steps_v4', count: history.length, expectedCount: plan.steps.length,
    exactMatch: mismatched.length === 0 && history.length === plan.steps.length, mismatched }
  assert.equal(report.upgradeJournal.exactMatch, true)
  await connection.rollback()
  report.inspected = true
} catch (error) { report.errorCode = error?.code ?? error?.name ?? 'inventory_failed'; process.exitCode = 1 }
finally {
  if (connection) await connection.end()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ inspected: report.inspected, present: report.present?.map(table => table.name), missing: report.missing, writes: 0 }))
}
