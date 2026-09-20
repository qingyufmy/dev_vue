import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { readPendingOrigins } from '../server/dist-v4/modules/execution/infrastructure/mysql-pending-origin-reader.js'
import { createMysqlTradeDecisionOriginReader } from '../server/dist-v4/modules/inference/infrastructure/mysql-trade-decision-origin-reader.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254')
assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
const report = { passed: false, scope: 'connection_local_temporary_tables_sql_semantics', persistentWrites: 0, checks: [], sources: {} }
let connection
try {
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone tz,@@version version')
  assert.equal(identity.db, 'dev_vue')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.tz, '+00:00')
  report.identity = identity
  // Every write below targets a connection-local temporary table created successfully first.
  const definitions = {
    execution_intents: 'id VARCHAR(36) PRIMARY KEY,operation_id VARCHAR(36),user_id INT,trading_account_id BIGINT,source_type VARCHAR(40),source_id VARCHAR(36),risk_decision_id VARCHAR(36),trade_decision_id VARCHAR(36),action_kind VARCHAR(40),status VARCHAR(20)',
    execution_outcomes: 'execution_intent_id VARCHAR(36),trading_account_id BIGINT,result_sha256 VARCHAR(64),distribution_target_id VARCHAR(36),result_json JSON,status VARCHAR(20)',
    bridge_commands_v4: 'execution_intent_id VARCHAR(36),user_id INT,trading_account_id BIGINT,result_sha256 VARCHAR(64),status VARCHAR(20),action VARCHAR(40),terminal_instance_id VARCHAR(128),connection_epoch BIGINT,broker_server VARCHAR(128),account_login VARCHAR(64)',
    execution_distribution_targets: 'id VARCHAR(36),distribution_id VARCHAR(36),target_user_id INT,trading_account_id BIGINT,child_operation_id VARCHAR(36)',
    execution_distributions: 'id VARCHAR(36),strategy_id BIGINT,kind VARCHAR(40)',
    trade_decisions: 'id VARCHAR(36),trader_run_id VARCHAR(36),risk_decision_id VARCHAR(36),user_id INT,trading_account_id BIGINT,strategy_id BIGINT,strategy_version_id BIGINT,market_analysis_id VARCHAR(36),input_snapshot_id VARCHAR(36),status VARCHAR(20)',
    ai_trader_runs: 'id VARCHAR(36),user_id INT,trading_account_id BIGINT,strategy_id BIGINT,strategy_version_id BIGINT,market_analysis_id VARCHAR(36),input_snapshot_id VARCHAR(36),status VARCHAR(20)',
  }
  for (const [name, columns] of Object.entries(definitions)) {
    await connection.query(`CREATE TEMPORARY TABLE ${name} (${columns}) ENGINE=InnoDB`)
  }
  await connection.beginTransaction()
  await connection.query("INSERT INTO execution_intents VALUES ('intent-1','operation-1',7,11,'risk_decision','risk-1','risk-1','decision-1','pending_order','succeeded')")
  await connection.execute("INSERT INTO execution_outcomes VALUES ('intent-1',11,'hash-1',NULL,?,'succeeded')", [JSON.stringify({ position_ticket: '81', order_ticket: '91' })])
  await connection.query("INSERT INTO bridge_commands_v4 VALUES ('intent-1',7,11,'hash-1','succeeded','order.place','terminal-1',2,'Broker-Demo','123')")
  await connection.query("INSERT INTO trade_decisions VALUES ('decision-1','run-1','risk-1',7,11,21,31,'analysis-1','snapshot-1','accepted')")
  await connection.query("INSERT INTO ai_trader_runs VALUES ('run-1',7,11,21,31,'analysis-1','snapshot-1','succeeded')")
  const decisions = createMysqlTradeDecisionOriginReader(connection)
  const scope = { userId: 7, accountId: '11', terminalInstanceId: 'terminal-1', brokerServer: 'Broker-Demo', login: '123', connectionEpoch: '3', tickets: ['91'] }
  const read = (patch = {}) => readPendingOrigins(connection, decisions, { ...scope, ...patch })
  assert.equal((await read()).get('91')?.strategyId, '21')
  report.checks.push('raw_order_ticket_and_historical_epoch_with_real_inference_join')
  for (const patch of [{ userId: 8 }, { accountId: '12' }, { terminalInstanceId: 'other' }, { connectionEpoch: '1' },
    { brokerServer: 'broker-demo' }, { login: '0123' }, { tickets: ['81'] }]) {
    assert.equal((await read(patch)).size, 0)
  }
  report.checks.push('user_account_terminal_epoch_exact_broker_login_and_position_ticket_isolation')
  await connection.query("UPDATE ai_trader_runs SET strategy_version_id=32")
  await assert.rejects(read(), /execution_dedup_origin_invalid/)
  await connection.query("UPDATE ai_trader_runs SET strategy_version_id=31")
  report.checks.push('mismatched_inference_version_rejected')
  await connection.query("UPDATE execution_outcomes SET status='failed'")
  assert.equal((await read()).size, 0)
  await connection.query("UPDATE execution_outcomes SET status='succeeded'")
  await connection.query("UPDATE bridge_commands_v4 SET result_sha256='other'")
  assert.equal((await read()).size, 0)
  await connection.query("UPDATE bridge_commands_v4 SET result_sha256='hash-1'")
  report.checks.push('failure_and_result_hash_mismatch_not_owned')
  await connection.query("INSERT INTO execution_distribution_targets VALUES ('target-1','distribution-1',7,11,'operation-1')")
  await connection.query("INSERT INTO execution_distributions VALUES ('distribution-1',22,'manual_order')")
  await connection.query("UPDATE execution_intents SET source_type='strategy_distribution',source_id='target-1',risk_decision_id=NULL,trade_decision_id=NULL")
  await connection.query("UPDATE execution_outcomes SET distribution_target_id='target-1'")
  assert.equal((await read()).get('91')?.strategyId, '22')
  await connection.query("UPDATE execution_distribution_targets SET target_user_id=8")
  await assert.rejects(read(), /execution_dedup_origin_invalid/)
  report.checks.push('distribution_target_ownership_and_operation_join')
  await connection.rollback()
  for (const path of ['server/src/modules/execution/infrastructure/mysql-pending-origin-reader.ts',
    'server/src/modules/inference/infrastructure/mysql-trade-decision-origin-reader.ts',
    'server/dist-v4/modules/execution/infrastructure/mysql-pending-origin-reader.js',
    'server/dist-v4/modules/inference/infrastructure/mysql-trade-decision-origin-reader.js']) {
    report.sources[path] = createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex')
  }
  report.passed = true
} catch (error) {
  report.errorCode = error?.code ?? error?.name ?? 'verification_failed'
  process.exitCode = 1
} finally {
  // Destroy, rather than release, so temporary table shadowing cannot survive in a reused connection.
  if (connection) connection.destroy()
  await pool.end()
  report.finishedAt = new Date().toISOString()
  await output.writeFile(`${JSON.stringify(report, null, 2)}\n`)
  await output.close()
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errorCode: report.errorCode }))
}
