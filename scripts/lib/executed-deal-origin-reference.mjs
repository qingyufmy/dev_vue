export const executedDealReferenceTables = {
      execution_intents: 'id VARCHAR(64),user_id INT,trading_account_id BIGINT,source_type VARCHAR(64),source_id VARCHAR(64),trade_decision_id VARCHAR(64),risk_decision_id VARCHAR(64),status VARCHAR(32),action_kind VARCHAR(32)',
      bridge_commands_v4: 'id VARCHAR(64),execution_intent_id VARCHAR(64),user_id INT,trading_account_id BIGINT,action VARCHAR(32),status VARCHAR(32),result_message_id VARCHAR(64),result_sha256 CHAR(64),request_sha256 CHAR(64),terminal_instance_id VARCHAR(128),broker_server VARCHAR(128),account_login VARCHAR(128),connection_epoch BIGINT,issued_at_utc DATETIME(3),completed_at_utc DATETIME(3)',
      bridge_command_payloads_v4: 'bridge_command_id VARCHAR(64),request_envelope_json JSON',
      bridge_command_results_v4: 'bridge_command_id VARCHAR(64),message_id VARCHAR(64),result_sha256 CHAR(64),action VARCHAR(32),completed_at_utc DATETIME(3),result_json JSON,terminal_code VARCHAR(32),status VARCHAR(32),conflict INT,error_code VARCHAR(64)',
    }
import assert from 'node:assert/strict'
import { canonicalHash } from '../../server/dist-v4/modules/execution/domain/bridge-command.js'
import { createMysqlExecutedDealOriginReader } from '../../server/dist-v4/modules/execution/composition.js'

/** Temporary tables on one isolated-reference connection; decision port is explicitly synthetic. */
export async function verifyExecutedDealOrigin(pool) {
  const c = await pool.getConnection()
  const created = []
  try {
    const [[identity]] = await c.query('SELECT DATABASE() db')
    assert.match(identity.db, /^dev_vue_history_ref_[a-f0-9]{32}$/)
    const definitions = executedDealReferenceTables
    for (const [name, fields] of Object.entries(definitions)) { await c.query(`CREATE TEMPORARY TABLE ${name} (${fields})`); created.push(name) }
    const result = { order: '201', deal: '101', position: '301' }
    const request = { v: 4, type: 'command.request', correlation_id: 'intent', route: { terminal_instance_id: 'terminal', account_ref: { broker_server: 'broker', login: '001' }, connection_epoch: 2 },
      payload: { command_id: 'command', action: 'position.close', issued_at_utc_msc: 1000, params: { ticket: '301' } } }
    const hash = canonicalHash({ command_id: 'command', action: 'position.close', status: 'succeeded', completed_at_utc_msc: 2000, result, error_code: null, terminal_code: 10009 })
    await c.query("INSERT INTO execution_intents VALUES ('intent',7,5,'risk_decision','risk','decision','risk','succeeded','close_position')")
    await c.execute("INSERT INTO bridge_commands_v4 VALUES ('command','intent',7,5,'position.close','succeeded','message',?,?,'terminal','broker','001',2,'1970-01-01 00:00:01','1970-01-01 00:00:02')", [hash, canonicalHash(request.payload)])
    await c.execute("INSERT INTO bridge_command_payloads_v4 VALUES ('command',?)", [JSON.stringify(request)])
    await c.execute("INSERT INTO bridge_command_results_v4 VALUES ('command','message',?,'position.close','1970-01-01 00:00:02',?,'10009','succeeded',0,NULL)", [hash, JSON.stringify(result)])
    const reader = createMysqlExecutedDealOriginReader(c, { async read() { return { userId: 7, accountId: '5', decisionId: 'decision', strategyId: '9', strategyVersionId: '10' } } })
    const scope = { userId: 7, accountId: '5', terminalInstanceId: 'terminal', brokerServer: 'broker', login: '001', connectionEpoch: 3,
      deals: [{ ticket: '101', orderTicket: '201', positionId: '301', occurredAtUtcMsc: 1500 }] }
    assert.equal((await reader.read(scope))[0].strategyVersionId, '10')
    for (const change of [{ userId: 8 }, { accountId: '6' }, { terminalInstanceId: 'other' }, { brokerServer: 'Broker' }, { login: '1' }, { connectionEpoch: 1 }]) {
      assert.deepEqual(await reader.read({ ...scope, ...change }), [])
    }
    await c.query('UPDATE bridge_command_results_v4 SET conflict=1')
    assert.deepEqual(await reader.read(scope), [])
    await c.query('UPDATE bridge_command_results_v4 SET conflict=0')
    await c.query("UPDATE execution_intents SET source_type='user_command'")
    assert.deepEqual(await reader.read(scope), [])
    await c.query("UPDATE execution_intents SET source_type='risk_decision'")
    await c.execute('UPDATE bridge_command_results_v4 SET result_json=?', [JSON.stringify({ ...result, deal: '102' })])
    await assert.rejects(reader.read(scope), /executed_deal_receipt_corrupt/)
    return { passed: true, sql: 'actual-mysql-temporary-tables', decisionPort: 'synthetic', checks: ['exact-receipt-to-strategy-version', 'account-route-case-and-epoch-isolation', 'conflict-and-manual-origin-excluded', 'raw-result-hash-tampering-rejected'] }
  } finally {
    try { for (const name of created.reverse()) await c.query(`DROP TEMPORARY TABLE ${name}`) } finally { c.release() }
  }
}
