import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const names = ['users', 'strategies', 'strategy_versions', 'strategy_subscriptions', 'subscription_schedules',
  'subscription_execution_preferences_v4', 'strategy_write_receipts_v4', 'database_upgrade_steps_v4',
  'strategy_subscriptions_v4_build', 'subscription_schedules_v4_build', 'subscription_execution_preferences_v4_build',
  'trading_accounts', 'auto_prompt_types']
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'strategy-receipt-schema-inventory/v1', inspected: false, writes: 0 }
let connection
try {
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@version version')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  report.identity = identity
  const [tables] = await connection.execute(`SELECT TABLE_NAME name,TABLE_TYPE kind,ENGINE engine FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${names.map(() => '?').join(',')}) ORDER BY TABLE_NAME`, names)
  report.present = tables; report.missing = names.filter(name => !tables.some(row => row.name === name))
  report.definitions = {}; report.rows = {}
  for (const table of tables) {
    assert.ok(names.includes(table.name) && table.kind === 'BASE TABLE')
    const [[definition]] = await connection.query(`SHOW CREATE TABLE \`${table.name}\``)
    const [[count]] = await connection.query(`SELECT CAST(COUNT(*) AS CHAR) count FROM \`${table.name}\``)
    report.definitions[table.name] = definition['Create Table']; report.rows[table.name] = count.count
  }
  const [history] = await connection.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id')
  report.history = history; report.inspected = true
} catch (error) { report.errorCode = error?.code ?? error?.name ?? 'inventory_failed'; process.exitCode = 1 }
finally {
  if (connection) await connection.end()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ inspected: report.inspected, identity: report.identity, missing: report.missing,
    rows: report.rows, historyCount: report.history?.length, errorCode: report.errorCode, writes: 0 }))
}
