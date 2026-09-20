import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'

const names = ['trade_history_sync_states_v4', 'terminal_history_orders_v4', 'terminal_history_deals_v4',
  'account_trade_records_v4', 'account_trade_record_deals_v4', 'account_trade_attributions_v4',
  'account_trade_daily_summaries_v4', 'trade_history_migration_checkpoints_v4', 'terminal_history_order_provenance_v4']
const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'trade-history-schema-inventory/v1', inspected: false, writes: 0 }
let connection
try {
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  report.identity = identity
  const [tables] = await connection.execute(`SELECT TABLE_NAME name,TABLE_TYPE kind,ENGINE engine FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${names.map(() => '?').join(',')}) ORDER BY TABLE_NAME`, names)
  report.present = tables
  report.missing = names.filter(name => !tables.some(table => table.name === name))
  report.definitions = {}
  for (const table of tables) {
    assert.ok(names.includes(table.name) && table.kind === 'BASE TABLE')
    const [[definition]] = await connection.query(`SHOW CREATE TABLE \`${table.name}\``)
    report.definitions[table.name] = definition['Create Table']
  }
  report.inspected = true
} catch (error) { report.errorCode = error?.code ?? error?.name ?? 'inventory_failed'; process.exitCode = 1 }
finally {
  if (connection) await connection.end()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ inspected: report.inspected, present: report.present?.map(table => table.name), missing: report.missing, writes: 0 }))
}
