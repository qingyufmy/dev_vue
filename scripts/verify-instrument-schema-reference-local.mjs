import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadInstrumentCollectionMigration } from './lib/inplace-instrument-collection-schema.mjs'
import { createMysqlInstrumentCollectionTasks } from '../server/dist-v4/modules/trading/infrastructure/mysql-instrument-collection-tasks.js'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--temporary-reference-only' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
const database = 'dev_vue_instrument_reference_' + randomUUID().replaceAll('-', '')
assert.match(database, /^dev_vue_instrument_reference_[0-9a-f]{32}$/)
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'instrument-schema-reference/v1', passed: false, existingDatabaseWrites: 0, referenceDatabaseRemoved: false, checks: [] }
let connection, pool, created = false
try {
  const plan = await loadInstrumentCollectionMigration(new URL('../', import.meta.url))
  report.migrationSha256 = plan.step.sourceSha256
  connection = await mysql.createConnection({ ...credential, timezone: 'Z', multipleStatements: false })
  const [[server]] = await connection.query('SELECT @@server_uuid uuid,@@version version')
  assert.equal(server.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  report.serverUuid = server.uuid; report.serverVersion = server.version
  await connection.query(`CREATE DATABASE \`${database}\``); created = true
  await connection.query(`USE \`${database}\``)
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('CREATE TABLE users (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB')
  await connection.query('CREATE TABLE trading_accounts (id BIGINT UNSIGNED NOT NULL PRIMARY KEY) ENGINE=InnoDB')
  await connection.query(plan.step.sql)
  const [[definition]] = await connection.query('SHOW CREATE TABLE instrument_collection_requests_v4')
  report.canonicalDdl = definition['Create Table']
  await connection.query('INSERT INTO users VALUES (7)')
  await connection.query('INSERT INTO trading_accounts VALUES (11)')
  const insert = (id, user, account, symbol = 'XAUUSD') => connection.execute(`INSERT INTO instrument_collection_requests_v4
    (id,user_id,trading_account_id,symbol,request_bucket,requested_at_utc,updated_at_utc)
    VALUES (?,?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [id, user, account, symbol])
  await assert.rejects(insert(randomUUID(), 8, 11), { code: 'ER_NO_REFERENCED_ROW_2' })
  await assert.rejects(insert(randomUUID(), 7, 12), { code: 'ER_NO_REFERENCED_ROW_2' })
  report.checks.push('real_user_and_account_foreign_keys')
  const id = randomUUID()
  await insert(id, 7, 11)
  await assert.rejects(insert(randomUUID(), 7, 11), { code: 'ER_DUP_ENTRY' })
  await insert(randomUUID(), 7, 11, 'xauusd')
  report.checks.push('scope_uniqueness_and_case_sensitive_symbol')
  await assert.rejects(connection.execute("UPDATE instrument_collection_requests_v4 SET status='running' WHERE id=?", [id]), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
  await assert.rejects(connection.execute("UPDATE instrument_collection_requests_v4 SET status='succeeded',completed_at_utc=UTC_TIMESTAMP(3),result_revision=0 WHERE id=?", [id]), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
  report.checks.push('lease_and_success_constraints')
  pool = mysql.createPool({ ...credential, database, timezone: 'Z', connectionLimit: 3, multipleStatements: false })
  const acquire = pool.getConnection.bind(pool)
  pool.getConnection = async () => { const c = await acquire(); await c.query("SET SESSION time_zone='+00:00'"); return c }
  const tasks = createMysqlInstrumentCollectionTasks(pool)
  const results = await Promise.all([tasks.claim(id), tasks.claim(id)])
  assert.deepEqual(results.map(row => row.state).sort(), ['busy', 'claimed'])
  const oldClaim = results.find(row => row.state === 'claimed').claim
  await connection.execute('UPDATE instrument_collection_requests_v4 SET lease_expires_at_utc=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE id=?', [id])
  const replacement = await tasks.claim(id)
  assert.equal(replacement.state, 'claimed')
  assert.equal(await tasks.complete(oldClaim, 1), false)
  assert.equal(await tasks.complete(replacement.claim, 2), true)
  assert.equal((await tasks.claim(id)).state, 'terminal')
  report.checks.push('concurrent_claim_and_stale_completion_fencing')
  report.passed = true
} catch (error) {
  report.errorCode = error?.code ?? error?.name ?? 'reference_failed'; process.exitCode = 1
} finally {
  if (pool) await pool.end()
  if (connection) {
    try { if (created) { await connection.query(`DROP DATABASE \`${database}\``); report.referenceDatabaseRemoved = true } }
    catch { report.passed = false; report.cleanupFailed = true; process.exitCode = 1 }
    await connection.end()
  }
  report.observedAt = new Date().toISOString()
  await output.writeFile(`${JSON.stringify(report, null, 2)}\n`); await output.close()
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, referenceDatabaseRemoved: report.referenceDatabaseRemoved, errorCode: report.errorCode }))
}
