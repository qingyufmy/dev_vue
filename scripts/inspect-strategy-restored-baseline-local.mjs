import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadStrategyBackfillSchema, inspectStrategyBackfillSchema } from './lib/strategy-backfill-schema-preflight.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const [mode, database, destination] = process.argv.slice(2)
assert.ok(mode === '--read-only' && /^dev_vue_m1_source_\d{8}_\d{2}$/.test(database ?? '') && isAbsolute(destination ?? '') && process.argv.length === 5)
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
const output = await open(destination, 'wx', 0o600)
let connection
const report = { kind: 'strategy-restored-baseline-preflight/v1', inspected: false, databaseWrites: 0, applyReady: false }
try {
  connection = await mysql.createConnection({ ...credentials, database, timezone: 'Z', dateStrings: true, supportBigNumbers: true,
    bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  report.schema = await inspectStrategyBackfillSchema(connection, await loadStrategyBackfillSchema(new URL('../', import.meta.url)), database)
  report.inspected = true
  await connection.rollback()
} catch (error) {
  report.errorCode = error?.code ?? error?.name ?? 'restored_preflight_failed'
  process.exitCode = 1
} finally {
  if (connection) await connection.end()
  report.observedAt = new Date().toISOString()
  report.toolSha256 = sha256(await readFile(new URL('./inspect-strategy-restored-baseline-local.mjs', import.meta.url)))
  report.limits = 'Structural admission only; backup restoration parity, role conversion, data backfill and runtime acceptance remain separate.'
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ inspected: report.inspected, schemaReady: report.schema?.schemaReady,
    mismatchedTables: report.schema?.tables.filter(table => !table.matches).map(table => table.name), errorCode: report.errorCode, databaseWrites: 0, applyReady: false }))
}
