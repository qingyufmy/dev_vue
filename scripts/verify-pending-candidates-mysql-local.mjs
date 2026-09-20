import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { sha256Canonical } from '../server/dist-v4/modules/execution/domain/execution.js'
import { readPendingDispatchCandidates } from '../server/dist-v4/modules/execution/infrastructure/mysql-pending-dispatch-candidates.js'
import { readPendingDispatchOrigin } from '../server/dist-v4/modules/execution/infrastructure/mysql-pending-dispatch-origin.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
const report = { passed: false, scope: 'real_mysql_connection_temporary_tables_not_full_schema_or_concurrency', persistentWrites: 0, checks: [], sources: {} }
let connection
try {
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone tz')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(identity.tz, '+00:00')
  report.identity = identity
  const tables = {
    bridge_commands_v4: 'id VARCHAR(36) PRIMARY KEY,execution_intent_id VARCHAR(36),user_id INT,trading_account_id BIGINT,status VARCHAR(24),action VARCHAR(32),terminal_instance_id VARCHAR(64),connection_epoch BIGINT,broker_server VARCHAR(64),account_login VARCHAR(64),result_sha256 CHAR(64)',
    execution_intents: 'id VARCHAR(36) PRIMARY KEY,user_id INT,trading_account_id BIGINT,operation_id VARCHAR(36),action_kind VARCHAR(32),source_type VARCHAR(32),source_id VARCHAR(36),trade_decision_id VARCHAR(36),risk_decision_id VARCHAR(36)',
    execution_intent_payloads: 'execution_intent_id VARCHAR(36) PRIMARY KEY,action_json JSON,action_sha256 CHAR(64)',
    execution_distribution_targets: 'id VARCHAR(36) PRIMARY KEY,target_user_id INT,trading_account_id BIGINT,child_operation_id VARCHAR(36),distribution_id VARCHAR(36)',
    execution_distributions: 'id VARCHAR(36) PRIMARY KEY,kind VARCHAR(32),strategy_id BIGINT',
  }
  for (const [table, definition] of Object.entries(tables)) await connection.query(`CREATE TEMPORARY TABLE ${table} (${definition}) ENGINE=InnoDB`)
  await connection.query("INSERT INTO execution_intents VALUES ('i1',7,42,'op1','pending_order','strategy_distribution','target1',NULL,NULL)")
  await connection.query("INSERT INTO bridge_commands_v4 VALUES ('c1','i1',7,42,'succeeded','order.place','t1',8,'Broker-Demo','123',NULL)")
  const action = { kind: 'pending_order', parameters: { symbol: 'XAUUSD.a', type: 'buy_limit', price: '2500.000000000000000001' } }
  await connection.execute('INSERT INTO execution_intent_payloads VALUES (?,?,?)', ['i1', JSON.stringify(action), sha256Canonical(action)])
  await connection.query("INSERT INTO execution_distributions VALUES ('dist1','manual_order',21)")
  await connection.query("INSERT INTO execution_distribution_targets VALUES ('target1',7,42,'op1','dist1')")
  const input = { userId: 7, accountId: '42', route: { terminalInstanceId: 't1', brokerServer: 'Broker-Demo', login: '123', connectionEpoch: '9', ownershipRevision: '2' } }
  await connection.beginTransaction()
  const candidates = await readPendingDispatchCandidates(connection, input)
  assert.equal(candidates.length, 1); assert.equal(candidates[0].price, action.parameters.price); assert.equal(candidates[0].status, 'succeeded')
  const decisions = { read: async () => { throw new Error('unexpected_ai_port') } }
  assert.deepEqual(await readPendingDispatchOrigin(connection, decisions, { ...input, candidate: candidates[0] }), { userId: 7, accountId: '42', strategyId: '21' })
  report.checks.push('successful_candidate_and_distribution_lineage_from_real_sql')
  assert.deepEqual(await readPendingDispatchCandidates(connection, { ...input, route: { ...input.route, brokerServer: 'broker-demo' } }), [])
  await connection.query("UPDATE bridge_commands_v4 SET connection_epoch=10")
  assert.deepEqual(await readPendingDispatchCandidates(connection, input), [])
  await connection.query("UPDATE bridge_commands_v4 SET connection_epoch=8,status='queued'")
  assert.deepEqual(await readPendingDispatchCandidates(connection, input), [])
  report.checks.push('binary_route_future_epoch_and_queued_excluded')
  await connection.query("UPDATE bridge_commands_v4 SET status='uncertain'")
  assert.equal((await readPendingDispatchCandidates(connection, input))[0].status, 'uncertain')
  await connection.query("UPDATE execution_distribution_targets SET child_operation_id='other'")
  await assert.rejects(readPendingDispatchOrigin(connection, decisions, { ...input, candidate: candidates[0] }), { code: 'execution_dedup_origin_invalid' })
  report.checks.push('uncertain_retained_and_wrong_child_operation_rejected')
  await connection.query('DELETE FROM execution_intent_payloads')
  await assert.rejects(readPendingDispatchCandidates(connection, input), { code: 'execution_dedup_candidate_invalid' })
  report.checks.push('missing_payload_rejected_instead_of_join_filtered')
  await connection.rollback()
  for (const path of ['modules/execution/infrastructure/mysql-pending-dispatch-candidates.js', 'modules/execution/infrastructure/mysql-pending-dispatch-origin.js']) {
    report.sources[path] = createHash('sha256').update(await readFile(new URL(`../server/dist-v4/${path}`, import.meta.url))).digest('hex')
  }
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name ?? 'probe_failed'; process.exitCode = 1 }
finally {
  if (connection) connection.destroy()
  await pool.end()
  report.finishedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errorCode: report.errorCode }))
}
