import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createMysqlInstrumentCollectionTasks } from '../server/dist-v4/modules/trading/infrastructure/mysql-instrument-collection-tasks.js'
import { createMysqlInstrumentCollectionRecovery } from '../server/dist-v4/modules/trading/infrastructure/mysql-instrument-collection-recovery.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
const report = { passed: false, scope: 'temporary_table_sequential_lease_transitions', persistentWrites: 0, checks: [], sources: {} }
let connection
try {
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone tz,@@version version')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(identity.tz, '+00:00')
  report.identity = identity
  // Temporary tables cannot have foreign keys. Keep all other columns and CHECKs from the proposed migration.
  const migrationPath = 'server/db/migrations/inplace/045_instrument_collection_requests.sql'
  const migration = await readFile(new URL(`../${migrationPath}`, import.meta.url), 'utf8')
  const ddl = migration.replace('CREATE TABLE instrument_collection_requests_v4', 'CREATE TEMPORARY TABLE instrument_collection_requests_v4')
    .replace(/^\s*CONSTRAINT fk_instrument_request_(?:user|account) FOREIGN KEY[^\n]*\n/gm, '\n')
  assert.ok(ddl.includes('CREATE TEMPORARY TABLE')); assert.ok(!ddl.includes('FOREIGN KEY'))
  await connection.query(ddl)
  const borrowed = { getConnection: async () => ({ execute: connection.execute.bind(connection),
    beginTransaction: connection.beginTransaction.bind(connection), commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection), release() {} }), execute: connection.execute.bind(connection) }
  const tasks = createMysqlInstrumentCollectionTasks(borrowed)
  const id = '11111111-1111-4111-8111-111111111111'
  await connection.execute(`INSERT INTO instrument_collection_requests_v4
    (id,user_id,trading_account_id,symbol,request_bucket,requested_at_utc,updated_at_utc)
    VALUES (?,7,11,'US 500.a',1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [id])
  const first = await tasks.claim(id)
  assert.equal(first.state, 'claimed')
  assert.equal((await tasks.claim(id)).state, 'busy')
  report.checks.push('pending_claim_and_active_lease_exclusion')
  assert.equal(await tasks.complete({ ...first.claim, symbol: 'US 500.A' }, 1), false)
  assert.equal(await tasks.complete({ ...first.claim, userId: 8 }, 1), false)
  assert.equal(await tasks.release({ ...first.claim, accountId: '12' }, 'route_unavailable'), false)
  report.checks.push('exact_symbol_user_and_account_scope_fenced')
  await connection.query("UPDATE instrument_collection_requests_v4 SET lease_expires_at_utc=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND")
  assert.equal(await tasks.complete(first.claim, 1), false)
  assert.equal(await tasks.release(first.claim, 'route_unavailable'), false)
  const second = await tasks.claim(id)
  assert.equal(second.state, 'claimed'); assert.notEqual(second.claim.leaseToken, first.claim.leaseToken)
  assert.equal(await tasks.complete(first.claim, 1), false)
  assert.equal(await tasks.release(first.claim, 'route_unavailable'), false)
  report.checks.push('expired_and_replaced_lease_cannot_complete_or_release')
  assert.equal(await tasks.release(second.claim, 'route_unavailable'), true)
  const third = await tasks.claim(id)
  assert.equal(third.state, 'claimed')
  assert.equal(await tasks.complete(third.claim, 12), true)
  assert.equal(await tasks.complete(third.claim, 13), false)
  assert.equal(await tasks.release(third.claim, 'route_unavailable'), false)
  assert.equal((await tasks.claim(id)).state, 'terminal')
  const [[row]] = await connection.query('SELECT status,attempts,result_revision,lease_token,lease_expires_at_utc,error_code FROM instrument_collection_requests_v4')
  assert.equal(row.status, 'succeeded'); assert.equal(Number(row.attempts), 3); assert.equal(Number(row.result_revision), 12)
  assert.equal(row.lease_token, null); assert.equal(row.lease_expires_at_utc, null); assert.equal(row.error_code, null)
  report.checks.push('release_reclaim_and_terminal_result_immutable')
  await assert.rejects(connection.query("UPDATE instrument_collection_requests_v4 SET status='running'"), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
  report.checks.push('migration_check_rejects_running_without_lease')
  const exhaustedId = '22222222-2222-4222-8222-222222222222'
  await connection.execute(`INSERT INTO instrument_collection_requests_v4
    (id,user_id,trading_account_id,symbol,request_bucket,attempts,requested_at_utc,updated_at_utc)
    VALUES (?,7,11,'XAUUSD',1,4,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [exhaustedId])
  const fifth = await tasks.claim(exhaustedId)
  assert.equal(fifth.state, 'claimed')
  assert.equal((await tasks.claim(exhaustedId)).state, 'busy')
  await connection.execute('UPDATE instrument_collection_requests_v4 SET lease_expires_at_utc=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE id=?', [exhaustedId])
  assert.equal((await tasks.claim(exhaustedId)).state, 'terminal')
  const [[failed]] = await connection.execute('SELECT status,error_code,attempts FROM instrument_collection_requests_v4 WHERE id=?', [exhaustedId])
  assert.equal(failed.status, 'failed'); assert.equal(Number(failed.attempts), 5)
  assert.equal(failed.error_code, 'instrument_collection_attempts_exhausted')
  assert.equal(await tasks.complete(fifth.claim, 1), false)
  report.checks.push('fifth_active_attempt_preserved_then_expired_attempt_terminalized')
  await connection.query(`CREATE TEMPORARY TABLE outbox_events (event_id VARCHAR(36) PRIMARY KEY,
    aggregate_type VARCHAR(64),aggregate_id VARCHAR(36),event_type VARCHAR(128),payload_json JSON,status VARCHAR(16),
    attempts INT,available_at_utc DATETIME(3),created_at_utc DATETIME(3)) ENGINE=InnoDB`)
  const recoveryId = '33333333-3333-4333-8333-333333333333'
  await connection.execute(`INSERT INTO instrument_collection_requests_v4
    (id,user_id,trading_account_id,symbol,request_bucket,requested_at_utc,updated_at_utc)
    VALUES (?,7,11,'EURUSD',1,UTC_TIMESTAMP(3)-INTERVAL 4 MINUTE,UTC_TIMESTAMP(3)-INTERVAL 4 MINUTE)`, [recoveryId])
  const recovery = createMysqlInstrumentCollectionRecovery(borrowed)
  assert.equal(await recovery.schedule(10), 1)
  assert.equal(await recovery.schedule(10), 0)
  await connection.execute('UPDATE instrument_collection_requests_v4 SET updated_at_utc=UTC_TIMESTAMP(3)-INTERVAL 4 MINUTE WHERE id=?', [recoveryId])
  assert.equal(await recovery.schedule(10), 0) // Pending outbox already guarantees delivery.
  await connection.query("UPDATE outbox_events SET status='published'")
  assert.equal(await recovery.schedule(10), 1) // New event identity can wake a queue whose old job is exhausted.
  const [events] = await connection.query('SELECT event_id,payload_json FROM outbox_events')
  assert.equal(events.length, 2); assert.notEqual(events[0].event_id, events[1].event_id)
  for (const event of events) assert.deepEqual(typeof event.payload_json === 'string' ? JSON.parse(event.payload_json) : event.payload_json, { request_id: recoveryId })
  report.checks.push('recovery_cooldown_pending_outbox_exclusion_and_fresh_event_identity')
  for (const path of [migrationPath, 'server/src/modules/trading/infrastructure/mysql-instrument-collection-tasks.ts',
    'server/dist-v4/modules/trading/infrastructure/mysql-instrument-collection-tasks.js',
    'server/src/modules/trading/infrastructure/mysql-instrument-collection-recovery.ts',
    'server/dist-v4/modules/trading/infrastructure/mysql-instrument-collection-recovery.js']) {
    report.sources[path] = createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex')
  }
  report.passed = true
} catch (error) {
  report.errorCode = error?.code ?? error?.name ?? 'verification_failed'; process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  await pool.end()
  report.finishedAt = new Date().toISOString()
  await output.writeFile(`${JSON.stringify(report, null, 2)}\n`); await output.close()
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errorCode: report.errorCode }))
}
