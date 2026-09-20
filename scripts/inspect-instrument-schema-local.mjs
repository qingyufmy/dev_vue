import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { loadInstrumentCollectionMigration, inspectInstrumentCollectionPrerequisites } from './lib/inplace-instrument-collection-schema.mjs'
import { assertMysqlInstrumentCollectionSchemaReady } from '../server/dist-v4/modules/trading/infrastructure/mysql-schema-readiness.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const root = new URL('../', import.meta.url)
const plan = await loadInstrumentCollectionMigration(root)
const env = parse(await readFile(new URL('server/.env', root)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
const report = { kind: 'instrument-schema-prerequisites/v1', passed: false, databaseWrites: 0,
  registrySteps: plan.steps.length, step: { id: plan.step.id, checksum: plan.step.checksum, sourceSha256: plan.step.sourceSha256 } }
let connection
try {
  await assertMysqlInstrumentCollectionSchemaReady(pool)
  report.runtimeSchemaReady = true
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone tz')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(identity.tz, '+00:00')
  report.identity = identity
  const [tables] = await connection.query(`SELECT TABLE_NAME name,ENGINE engine FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('users','trading_accounts','instrument_collection_requests_v4')`)
  const [columns] = await connection.query(`SELECT TABLE_NAME tableName,COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('users','trading_accounts') AND COLUMN_NAME='id'`)
  const [keys] = await connection.query(`SELECT TABLE_NAME tableName,INDEX_NAME indexName,COLUMN_NAME columnName,NON_UNIQUE nonUnique
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('users','trading_accounts') AND INDEX_NAME='PRIMARY'`)
  report.evidence = { tables, columns, keys }
  report.result = inspectInstrumentCollectionPrerequisites(report.evidence)
  report.passed = report.result.ready
  if (!report.passed) process.exitCode = 1
} catch (error) {
  report.errorCode = error?.code ?? error?.name ?? 'inspection_failed'; process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  await pool.end()
  report.observedAt = new Date().toISOString()
  await output.writeFile(`${JSON.stringify(report, null, 2)}\n`); await output.close()
  console.log(JSON.stringify({ passed: report.passed, result: report.result, errorCode: report.errorCode }))
}
