import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createProjectionReservationAbsorber } from '../server/dist-v4/modules/execution/composition.js'

const destination = process.argv[2]
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const output = await open(destination, 'wx', 0o600)
let pool, connection, phase = 'connect'
const checks = []
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_DATABASE, 'dev_vue'); assert.equal(env.MYSQL_HOST, '192.168.1.254')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone,@@version version')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(identity.timezone, '+00:00')
  phase = 'temporary-tables'
  // Every adapter table is shadowed before any INSERT/UPDATE. Failure aborts immediately.
  // These minimal InnoDB fixtures test driver/engine transactions, not the business schema or FK graph.
  const tables = {
    risk_reservations_v4: 'id VARCHAR(64) PRIMARY KEY,revision INT,status VARCHAR(32),trading_account_id VARCHAR(64),execution_intent_id VARCHAR(64),released_at_utc DATETIME(3),release_reason VARCHAR(64),updated_at_utc DATETIME(3)',
    execution_intents: 'id VARCHAR(64) PRIMARY KEY,status VARCHAR(32)',
    execution_intent_payloads: 'execution_intent_id VARCHAR(64) PRIMARY KEY,action_json JSON',
    bridge_commands_v4: 'id VARCHAR(64) PRIMARY KEY,execution_intent_id VARCHAR(64),status VARCHAR(32),result_sha256 VARCHAR(64),action VARCHAR(64)',
    bridge_command_payloads_v4: 'bridge_command_id VARCHAR(64) PRIMARY KEY,params_json JSON,expected_state_json JSON',
    bridge_command_results_v4: 'bridge_command_id VARCHAR(64) PRIMARY KEY,result_sha256 VARCHAR(64),conflict INT,result_json JSON,completed_at_utc DATETIME(3)',
    risk_reservation_events_v4: 'risk_reservation_id VARCHAR(64),event_type VARCHAR(64),from_status VARCHAR(32),to_status VARCHAR(32),reason_code VARCHAR(64),from_revision INT,to_revision INT,occurred_at_utc DATETIME(3),UNIQUE KEY once_only(risk_reservation_id,event_type,from_revision)',
    aurum_projection_transaction_probe: 'id INT PRIMARY KEY,revision INT',
  }
  for (const [table, definition] of Object.entries(tables)) await connection.query(`CREATE TEMPORARY TABLE \`${table}\` (${definition}) ENGINE=InnoDB`)
  phase = 'seed-temporary-data'
  await connection.query("INSERT INTO risk_reservations_v4 (id,revision,status,trading_account_id,execution_intent_id) VALUES ('r',2,'committed','a','i')")
  await connection.query("INSERT INTO execution_intents VALUES ('i','succeeded')")
  await connection.execute('INSERT INTO execution_intent_payloads VALUES (?,?)', ['i', JSON.stringify({ expectedState: { positionsRevision: 1 } })])
  await connection.query("INSERT INTO bridge_commands_v4 VALUES ('c','i','succeeded','digest','position.close')")
  await connection.execute('INSERT INTO bridge_command_payloads_v4 VALUES (?,?,NULL)', ['c', JSON.stringify({ ticket: '123' })])
  await connection.query("INSERT INTO bridge_command_results_v4 VALUES ('c','digest',0,JSON_OBJECT(),'2026-09-09 00:00:00')")
  await connection.query('INSERT INTO aurum_projection_transaction_probe VALUES (1,0)')
  const absorber = createProjectionReservationAbsorber(connection)
  const input = { accountId: 'a', entityKind: 'position', projectionRevision: 2, observedAt: '2026-09-09T00:01:00.000Z', states: [], now: '2026-09-09T00:01:01.000Z' }
  phase = 'stale-evidence'
  await connection.beginTransaction()
  assert.deepEqual(await absorber.absorb({ ...input, projectionRevision: 1 }), [])
  assert.deepEqual(await absorber.absorb({ ...input, observedAt: '2026-09-08T23:59:59.000Z' }), [])
  await connection.rollback()
  checks.push('stale-revision-and-pre-result-time-rejected')
  phase = 'commit'
  await connection.beginTransaction()
  await connection.query('UPDATE aurum_projection_transaction_probe SET revision=1 WHERE id=1')
  assert.deepEqual(await absorber.absorb(input), ['r'])
  await connection.commit()
  const [[committed]] = await connection.query("SELECT status,revision,released_at_utc,updated_at_utc FROM risk_reservations_v4 WHERE id='r'")
  assert.equal(committed.status, 'absorbed'); assert.equal(committed.revision, 3)
  assert.equal(committed.released_at_utc.toISOString(), input.now)
  assert.equal(committed.updated_at_utc.toISOString(), input.now)
  const [[events]] = await connection.query('SELECT COUNT(*) n FROM risk_reservation_events_v4')
  assert.equal(Number(events.n), 1)
  const [[event]] = await connection.query('SELECT occurred_at_utc FROM risk_reservation_events_v4')
  assert.equal(event.occurred_at_utc.toISOString(), input.now)
  checks.push('reservation-and-audit-committed')
  phase = 'duplicate'
  assert.deepEqual(await absorber.absorb(input), [])
  checks.push('already-absorbed-replay-noop')
  phase = 'audit-failure-rollback'
  await connection.query("UPDATE risk_reservations_v4 SET status='committed',revision=2 WHERE id='r'")
  await connection.beginTransaction()
  await connection.query('UPDATE aurum_projection_transaction_probe SET revision=2 WHERE id=1')
  // The first event is retained: the real duplicate-key failure occurs after the reservation update.
  await assert.rejects(absorber.absorb(input), error => error.code === 'ER_DUP_ENTRY')
  await connection.rollback()
  const [[rolledBack]] = await connection.query("SELECT status,revision FROM risk_reservations_v4 WHERE id='r'")
  const [[projection]] = await connection.query('SELECT revision FROM aurum_projection_transaction_probe WHERE id=1')
  assert.equal(rolledBack.status, 'committed'); assert.equal(rolledBack.revision, 2); assert.equal(projection.revision, 1)
  checks.push('audit-failure-rolls-back-reservation-and-peer-write')
  await output.writeFile(JSON.stringify({ kind: 'projection-absorption-mysql/v1', observedAt: new Date().toISOString(), identity, checks,
    permanentBusinessWrites: 0, scope: 'Actual compiled execution adapter, MySQL driver and InnoDB transactions on connection-private minimal temporary tables. Does not verify actual business schema/FKs, full projection writer, concurrent locks, unknown commits, browser or terminal behavior.' }, null, 2) + '\n')
  console.log(JSON.stringify({ checks: checks.length, permanentBusinessWrites: 0 }))
} catch (error) {
  await output.writeFile(JSON.stringify({ failed: true, phase, code: typeof error?.code === 'string' ? error.code : 'verification_failed' }) + '\n')
  console.error('projection_absorption_mysql_failed'); process.exitCode = 1
} finally {
  // Destroy rather than return a session containing table shadows to the pool.
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  if (pool) await pool.end()
  await output.sync(); await output.close()
}
