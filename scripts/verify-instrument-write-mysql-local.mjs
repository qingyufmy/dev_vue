import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { writeInstrumentProjection } from '../server/dist-v4/modules/trading/infrastructure/mysql-trading-repository.js'
import { createMysqlInstrumentSnapshotReader } from '../server/dist-v4/modules/trading/infrastructure/mysql-instrument-snapshot-reader.js'
import { verifyInstrumentPipelineFixture } from './lib/verify-instrument-pipeline-fixture.mjs'
import { developmentRedisConnection } from './lib/development-redis.mjs'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
const report = { passed: false, scope: 'temporary_table_real_transaction_semantics', persistentWrites: 0, checks: [], sources: {} }
let connection
try {
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone tz,@@version version')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(identity.tz, '+00:00')
  report.identity = identity
  const definitions = {
    instrument_collection_requests_v4: 'id VARCHAR(36) PRIMARY KEY,user_id INT,trading_account_id BIGINT,symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,status VARCHAR(16),lease_token VARCHAR(36),lease_expires_at_utc DATETIME(3)',
    trading_accounts: 'id BIGINT PRIMARY KEY,deleted_at_utc DATETIME(3),ownership_revision BIGINT,platform VARCHAR(8),broker_server VARCHAR(128),account_login VARCHAR(64)',
    trading_account_ownerships: 'trading_account_id BIGINT,user_id INT,role VARCHAR(16),revoked_at_utc DATETIME(3),interval_id VARCHAR(36),revision BIGINT,granted_at_utc DATETIME(3)',
    trading_account_ownership_intervals: 'id VARCHAR(36),user_id INT,trading_account_id BIGINT,role VARCHAR(16),ended_at_utc DATETIME(3),started_at_utc DATETIME(3)',
    users: 'id INT PRIMARY KEY,deletion_status VARCHAR(16),deleted_at DATETIME(3),role VARCHAR(16),plan VARCHAR(16),plan_expires_at DATETIME(3)',
    terminal_profiles: 'id VARCHAR(36),user_id INT,installation_id VARCHAR(36),deleted_at_utc DATETIME(3),platform VARCHAR(8)',
    bridge_refresh_sessions: 'id VARCHAR(36),user_id INT,installation_id VARCHAR(36),profile_id VARCHAR(36),generation BIGINT,credential_version INT,revoked_at DATETIME(3)',
    terminal_account_bindings: 'trading_account_id BIGINT,terminal_profile_id VARCHAR(36),terminal_instance_id VARCHAR(128),unbound_at_utc DATETIME(3)',
    bridge_connection_sessions: 'id VARCHAR(36),user_id INT,trading_account_id BIGINT,terminal_profile_id VARCHAR(36),terminal_instance_id VARCHAR(128),connection_epoch_v4 BIGINT,disconnected_at_utc DATETIME(3),connection_epoch VARCHAR(128),last_seen_at_utc DATETIME(3)',
    market_instrument_snapshots: 'trading_account_id BIGINT,symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,payload_json JSON,observed_at_utc DATETIME(3),revision BIGINT UNSIGNED,PRIMARY KEY(trading_account_id,symbol)',
  }
  for (const [name, columns] of Object.entries(definitions)) await connection.query(`CREATE TEMPORARY TABLE ${name} (${columns}) ENGINE=InnoDB`)
  await connection.query("INSERT INTO trading_accounts VALUES (11,NULL,4,'mt5','Broker','123')")
  await connection.query("INSERT INTO users VALUES (7,'active',NULL,'user','pro',NULL)")
  await connection.query("INSERT INTO trading_account_ownerships VALUES (11,7,'owner',NULL,'interval-1',4,'2026-01-01')")
  await connection.query("INSERT INTO trading_account_ownership_intervals VALUES ('interval-1',7,11,'owner',NULL,'2026-01-01')")
  await connection.query("INSERT INTO terminal_profiles VALUES ('profile-1',7,'installation-1',NULL,'mt5')")
  await connection.query("INSERT INTO bridge_refresh_sessions VALUES ('credential-1',7,'installation-1','profile-1',2,4,NULL)")
  await connection.query("INSERT INTO terminal_account_bindings VALUES (11,'profile-1','terminal-1',NULL)")
  await connection.query("INSERT INTO bridge_connection_sessions VALUES ('session-1',7,11,'profile-1','terminal-1',3,NULL,'v4:connection-1',UTC_TIMESTAMP(3))")
  // Borrow this connection so all production SQL sees only the temporary fixture tables.
  const borrowed = { getConnection: async () => ({ execute: connection.execute.bind(connection),
    beginTransaction: connection.beginTransaction.bind(connection), commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection), release() {} }) }
  const observedMs = Date.now() - 10000
  const input = { route: { userId: 7, accountId: '11', terminalProfileId: 'profile-1', terminalInstanceId: 'terminal-1',
    connectionEpoch: 3, connectionId: 'connection-1', installationId: 'installation-1', credentialGeneration: 2, ownershipRevision: '4',
    brokerServer: 'Broker', login: '123' }, symbol: 'XAUUSD', observedAt: new Date(observedMs).toISOString(), sourceRevision: 'source-1', expectedRevision: 0,
    raw: { symbol: 'XAUUSD', point: '0.01', tick_size: '0.01', tick_value: '1.000000000000000001', volume_min: '0.01', volume_max: '10', volume_step: '0.01', trade_mode: 4 } }
  const write = patch => writeInstrumentProjection(borrowed, { ...input, ...patch })
  assert.deepEqual(await write(), { applied: true, revision: 1 })
  assert.deepEqual(await write(), { applied: false, revision: 1 })
  report.checks.push('commit_and_identical_replay_without_revision_growth')
  await connection.query("INSERT INTO instrument_collection_requests_v4 VALUES ('request-1',7,11,'XAUUSD','running','token-1',UTC_TIMESTAMP(3)+INTERVAL 90 SECOND)")
  const collectionLease = { requestId: 'request-1', leaseToken: 'token-1' }
  assert.deepEqual(await write({ collectionLease }), { applied: false, revision: 1 })
  await assert.rejects(write({ collectionLease: { ...collectionLease, leaseToken: 'old-token' } }), /instrument_collection_lease_lost/)
  await connection.query('UPDATE instrument_collection_requests_v4 SET lease_expires_at_utc=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND')
  await assert.rejects(write({ collectionLease }), /instrument_collection_lease_lost/)
  const [[unchanged]] = await connection.query('SELECT revision FROM market_instrument_snapshots')
  assert.equal(Number(unchanged.revision), 1)
  report.checks.push('collection_lease_checked_even_for_identical_replay')
  await assert.rejects(write({ sourceRevision: 'source-2', observedAt: new Date(observedMs + 1000).toISOString() }), /revision_conflict/)
  await assert.rejects(write({ expectedRevision: 1, sourceRevision: 'source-2', observedAt: new Date(observedMs - 1000).toISOString() }), /instrument_projection_observation_stale/)
  report.checks.push('version_conflict_and_stale_observation_rollback')
  await connection.query('UPDATE bridge_refresh_sessions SET revoked_at=UTC_TIMESTAMP(3)')
  await assert.rejects(write(), /trading_context_invalid/)
  await connection.query('UPDATE bridge_refresh_sessions SET revoked_at=NULL')
  await assert.rejects(write({ route: { ...input.route, login: '0123' } }), /trading_context_invalid/)
  report.checks.push('revoked_replay_and_account_identity_rejected')
  const [[row]] = await connection.query('SELECT payload_json,revision,DATE_FORMAT(observed_at_utc,\'%Y-%m-%dT%H:%i:%s.%fZ\') observed FROM market_instrument_snapshots')
  const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json
  assert.equal(payload.tickValue, '1.000000000000000001')
  assert.equal(payload.raw.tick_value, input.raw.tick_value)
  assert.equal(payload.sourceEvidence.ownershipRevision, '4')
  assert.equal(Number(row.revision), 1); assert.equal(row.observed, input.observedAt.replace('Z', '000Z'))
  report.checks.push('exact_decimal_raw_evidence_and_utc_preserved')
  const reader = createMysqlInstrumentSnapshotReader(connection)
  assert.equal((await reader.read('11', 'XAUUSD'))?.revision, 1)
  await connection.query('UPDATE bridge_connection_sessions SET connection_epoch_v4=4')
  assert.equal(await reader.read('11', 'XAUUSD'), null)
  assert.equal(await reader.readRevision('11', 'XAUUSD'), 1)
  await connection.query('UPDATE bridge_connection_sessions SET connection_epoch_v4=3')
  await connection.query('UPDATE trading_accounts SET ownership_revision=5')
  assert.equal(await reader.read('11', 'XAUUSD'), null)
  await connection.query('UPDATE trading_accounts SET ownership_revision=4')
  await connection.query('UPDATE market_instrument_snapshots SET observed_at_utc=UTC_TIMESTAMP(3)-INTERVAL 301 SECOND')
  assert.equal(await reader.read('11', 'XAUUSD'), null)
  assert.equal(await reader.readRevision('11', 'XAUUSD'), 1)
  report.checks.push('current_read_rejects_epoch_ownership_and_age_but_refresh_keeps_cas_version')
  const redis = await developmentRedisConnection()
  report.redis = { host: redis.host, port: redis.port, db: redis.db }
  report.checks.push(await verifyInstrumentPipelineFixture(connection, borrowed, input))
  report.pipelineBoundary = 'Real MySQL temporary tables, outbox dispatcher, Redis queue, query transport and loopback WebSocket; fixture authorization/route and simulated terminal peer; no real device or trading terminal traffic.'
  for (const path of ['scripts/lib/development-redis.mjs', 'scripts/lib/verify-instrument-pipeline-fixture.mjs', 'server/dist-v4/queue/bridge-instrument-processor.js',
    'server/dist-v4/modules/bridge/application/bridge-instrument-worker.js',
    'server/dist-v4/modules/bridge/application/bridge-instrument-collector.js',
    'server/src/modules/trading/infrastructure/mysql-trading-repository.ts',
    'server/src/modules/trading/domain/instrument-projection.ts', 'server/dist-v4/modules/trading/infrastructure/mysql-trading-repository.js',
    'server/src/modules/trading/infrastructure/mysql-instrument-snapshot-reader.ts', 'server/dist-v4/modules/trading/infrastructure/mysql-instrument-snapshot-reader.js']) {
    report.sources[path] = createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex')
  }
  report.passed = true
} catch (error) {
  report.failureLocations = error?.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 3)
  if (error?.code === 'ERR_ASSERTION') report.assertion = { actual: error.actual, expected: error.expected }
  if (error?.clockEvidence) report.clockEvidence = error.clockEvidence
  report.errorCode = error?.code ?? error?.name ?? 'verification_failed'; process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  await pool.end()
  report.finishedAt = new Date().toISOString()
  await output.writeFile(`${JSON.stringify(report, null, 2)}\n`); await output.close()
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errorCode: report.errorCode }))
}
