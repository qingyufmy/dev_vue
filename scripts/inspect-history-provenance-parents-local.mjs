import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'history-provenance-parent-prerequisites/v1', passed: false, writes: 0 }
let connection
try {
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z' })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  report.identity = identity
  const [rows] = await connection.query(`SELECT c.TABLE_NAME tableName,c.COLUMN_TYPE columnType,c.COLLATION_NAME collationName,
    c.IS_NULLABLE nullable,t.ENGINE engine,c.COLUMN_KEY columnKey
    FROM information_schema.COLUMNS c INNER JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
    WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME IN ('users','trading_accounts','terminal_history_orders_v4') AND c.COLUMN_NAME='id' ORDER BY c.TABLE_NAME`)
  report.parents = rows
  assert.equal(rows.length, 3)
  const expected = { users: 'int', trading_accounts: 'bigint unsigned', terminal_history_orders_v4: 'char(36)' }
  for (const row of rows) {
    assert.equal(row.columnType, expected[row.tableName]); assert.equal(row.engine, 'InnoDB')
    assert.equal(row.nullable, 'NO'); assert.equal(row.columnKey, 'PRI')
    if (row.tableName === 'terminal_history_orders_v4') assert.equal(row.collationName, 'ascii_bin')
  }
  report.parents = rows; report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name ?? 'parent_check_failed'; process.exitCode = 1 }
finally {
  if (connection) await connection.end()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, errorCode: report.errorCode, writes: 0 }))
}
