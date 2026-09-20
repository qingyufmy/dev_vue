import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254')
assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
let connection
const report = { passed: false, existingDatabaseWrites: 0, scope: 'Read-only schema catalog and migration journal; not row-level migration acceptance.' }
try {
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', connectTimeout: 5000 })
  const [[identity]] = await connection.query('SELECT DATABASE() databaseName,@@server_uuid serverUuid,@@innodb_force_recovery recovery')
  assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  report.identity = identity
  const [tables] = await connection.execute('SELECT TABLE_NAME name,TABLE_TYPE type,ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', ['dev_vue'])
  const [columns] = await connection.execute('SELECT TABLE_NAME tableName,COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION', ['dev_vue'])
  const [steps] = await connection.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id')
  const inventory = JSON.parse(await readFile(new URL('../docs/architecture/sql-write-inventory-20260911.json', import.meta.url)))
  const targets = [...new Set([...inventory.tables.map(table => table.table), 'open_position_snapshots', 'pending_order_snapshots', 'ai_analysis_runs', 'ai_trader_runs'])].sort()
  const physical = new Set(tables.map(table => table.name))
  report.tables = tables; report.columns = columns; report.steps = steps
  report.counts = { tables: tables.length, columns: columns.length, completedSteps: steps.filter(step => step.status === 'completed').length, writeTargets: targets.length }
  report.missingWriteTargets = targets.filter(name => !physical.has(name))
  report.incompleteSteps = steps.filter(step => step.status !== 'completed').map(step => step.id)
  report.tablesWithoutDetectedV4Writer = tables.filter(table => !targets.includes(table.name)).map(table => table.name)
  report.passed = report.missingWriteTargets.length === 0 && report.incompleteSteps.length === 0
  if (!report.passed) process.exitCode = 1
} catch (error) {
  report.errorCode = error.code ?? error.name; process.exitCode = 1
} finally {
  if (connection) await connection.end()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, counts: report.counts, missingWriteTargets: report.missingWriteTargets,
    incompleteSteps: report.incompleteSteps, errorCode: report.errorCode, existingDatabaseWrites: 0 }))
}
