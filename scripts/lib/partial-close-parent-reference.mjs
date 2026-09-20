import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MysqlBridgeCommandRepository, createMysqlPartialCloseWorkflowWriter } from '../../server/dist-v4/modules/execution/composition.js'
import { createBridgeCommand, bridgeResultHash } from '../../server/dist-v4/modules/execution/domain/bridge-command.js'
import { sha256Canonical } from '../../server/dist-v4/modules/execution/domain/execution.js'
import {verifyPartialCloseParentDispatchReference} from './partial-close-parent-dispatch-reference.mjs'
import {verifyParentDispatchTransaction} from './partial-close-parent-dispatch-transaction-reference.mjs'
import {verifyParentResultTransaction} from './partial-close-parent-result-transaction-reference.mjs'
import {verifyParentProgressChain} from './partial-close-parent-progress-chain-reference.mjs'

/** Real InnoDB parent/plan/audit/outbox transactions; supporting authority tables are explicit query scaffolds. */
export async function verifyPartialCloseParentReference(db, pool, options = {}) {
  const [[identity]] = await db.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const checks = []
  const raw = db
  db = new Proxy(raw, { get(client,key) {
    if (key === 'query' || key === 'execute') return async (sql,...args) => {
      try { return await client[key](sql,...args) } catch (error) { error.referenceStatement = String(sql).slice(0,160); throw error }
    }
    const value=client[key]; return typeof value === 'function' ? value.bind(client) : value
  } })
  await db.query(`ALTER TABLE trading_accounts ADD broker_server VARCHAR(128) NOT NULL DEFAULT 'Broker', ADD account_login VARCHAR(64) NOT NULL DEFAULT '42'`)
  await db.query(`ALTER TABLE execution_intents ADD operation_id CHAR(36) NULL, ADD source_type VARCHAR(32) NULL, ADD source_id VARCHAR(128) NULL, ADD revision INT NOT NULL DEFAULT 1`)
  await db.query(`ALTER TABLE bridge_commands_v4
    ADD command_sequence INT NOT NULL DEFAULT 1, ADD terminal_profile_id VARCHAR(128) NOT NULL DEFAULT 'profile_12345678',
    ADD idempotency_key VARCHAR(191) NULL, ADD issued_at_utc DATETIME(3) NULL,
    ADD dispatched_at_utc DATETIME(3) NULL, ADD accepted_at_utc DATETIME(3) NULL, ADD completed_at_utc DATETIME(3) NULL,
    ADD error_code VARCHAR(128) NULL, ADD terminal_code VARCHAR(128) NULL, ADD result_sha256 CHAR(64) NULL,
    ADD result_message_id VARCHAR(191) NULL, ADD revision INT NOT NULL DEFAULT 1,
    ADD created_at_utc DATETIME(3) NULL, ADD updated_at_utc DATETIME(3) NULL,
    ADD UNIQUE KEY uk_parent_sequence (execution_intent_id,command_sequence)`)
  await db.query(`ALTER TABLE bridge_command_payloads_v4 ADD params_json JSON NULL, ADD expected_state_json JSON NULL, ADD payload_bytes INT NULL`)
  const create = async (name, fields) => db.query(`CREATE TABLE ${name} (${fields}) ENGINE=InnoDB`)
  await create('terminal_profiles', 'id VARCHAR(128) PRIMARY KEY,user_id INT,deleted_at_utc DATETIME(3)')
  await create('terminal_account_bindings', 'trading_account_id BIGINT,terminal_profile_id VARCHAR(128),terminal_instance_id VARCHAR(128),unbound_at_utc DATETIME(3)')
  await create('bridge_connection_sessions', 'id VARCHAR(128),trading_account_id BIGINT,user_id INT,terminal_profile_id VARCHAR(128),terminal_instance_id VARCHAR(128),connection_epoch_v4 BIGINT,disconnected_at_utc DATETIME(3)')
  await create('account_runtime_snapshots', 'trading_account_id BIGINT PRIMARY KEY,trade_permission TINYINT')
  await create('bridge_trade_state_snapshots_v4', 'trading_account_id BIGINT,entity_kind VARCHAR(32),ticket VARCHAR(64),terminal_instance_id VARCHAR(128),connection_epoch BIGINT,projection_revision BIGINT,state_json JSON,state_sha256 CHAR(64)')
  await create('bridge_command_events_v4', 'id BIGINT AUTO_INCREMENT PRIMARY KEY,bridge_command_id VARCHAR(191),event_type VARCHAR(64),from_status VARCHAR(32),to_status VARCHAR(32),reason_code VARCHAR(128),from_revision INT,to_revision INT,evidence_sha256 CHAR(64),occurred_at_utc DATETIME(3)')
  const [[outbox]] = await db.query('SHOW CREATE TABLE outbox_events')
  assert.match(outbox['Create Table'], /ENGINE=InnoDB/)
  await db.query('UPDATE trading_account_ownerships SET revoked_at_utc=NULL WHERE id=1 AND user_id=7 AND trading_account_id=5')
  await db.query("INSERT INTO terminal_profiles VALUES ('profile_12345678',7,NULL)")
  await db.query("INSERT INTO terminal_account_bindings VALUES (5,'profile_12345678','terminal_12345678',NULL)")
  await db.query("INSERT INTO bridge_connection_sessions VALUES ('session',5,7,'profile_12345678','terminal_12345678',1,NULL)")
  await db.query('INSERT INTO account_runtime_snapshots VALUES (5,1)')
  const expected = { ticket: '101', symbol: 'XAUUSD', direction: 'buy', volume: '0.10', order_type: 'market', magic: 0,
    open_price: '2450', stop_limit_price: null, stop_loss: null, take_profit: null, expiration_utc_msc: null }
  await db.execute("INSERT INTO bridge_trade_state_snapshots_v4 VALUES (5,'position','101','terminal_12345678',1,5,?,?)", [JSON.stringify(expected), sha256Canonical(expected)])
  const prepare = async () => {
    const now = new Date(), expires = new Date(now.getTime() + 300000), intentId = randomUUID()
    const action = { actionId: 'close', kind: 'close_position', parameters: { ticket: '101', volume: '0.08',
      after_close_protection: { stop_loss: '2400' }, after_close_target: { position_identifier: '100', initial_volume: '0.10', positions_revision: 5 } }, expectedState: { positionsRevision: 5 } }
    await db.execute('INSERT INTO execution_intents (id,user_id,trading_account_id,action_kind,status,expires_at_utc) VALUES (?,7,5,?,?,?)', [intentId,'close_position','prepared',expires])
    await db.execute('INSERT INTO execution_intent_payloads VALUES (?,?,?)', [intentId,JSON.stringify(action),sha256Canonical(action)])
    const command = createBridgeCommand({ executionIntentId: intentId, commandSequence: 1, userId: 7, accountId: '5', terminalProfileId: 'profile_12345678',
      route: { terminalInstanceId: 'terminal_12345678', brokerServer: 'Broker', login: '42', connectionEpoch: 1 }, action: 'position.close',
      params: { ticket: '101', volume: '0.08', deviation: 20 }, expectedState: expected, deadlineAt: expires.toISOString() }, now)
    return { action, command }
  }
  const counts = async command => {
    const result = []
    for (const [table, column, id] of [['bridge_commands_v4','id',command.id],['bridge_command_payloads_v4','bridge_command_id',command.id],
      ['partial_close_workflows_v4','parent_command_id',command.id], ['bridge_command_events_v4','bridge_command_id',command.id],['outbox_events','aggregate_id',command.id]]) {
      const [[row]] = await db.execute(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`, [id]); result.push(Number(row.n))
    }
    const [[events]] = await db.execute('SELECT COUNT(*) n FROM partial_close_workflow_events_v4 e JOIN partial_close_workflows_v4 w ON w.id=e.workflow_id WHERE w.parent_command_id=?',[command.id])
    result.push(Number(events.n)); return result
  }
  const repository = ({ failAt = null, loseAck = false, enabled = true } = {}) => {
    let discarded = 0, rollbackAfterCommit = 0, committed = false
    const wrapped = new Proxy(pool, { get(target,key) {
      if (key === 'getConnection') return async () => {
        const connection = await target.getConnection(); await connection.query("SET SESSION time_zone='+00:00'")
        return new Proxy(connection, { get(client, method) {
          if (method === 'execute') return async (sql,...args) => {
            if (failAt && String(sql).includes(`INSERT INTO ${failAt}`)) throw Error('injected_parent_write_failure')
            return client.execute(sql,...args)
          }
          if (method === 'commit') return async () => { await client.commit(); committed = true; if (loseAck) { loseAck = false; throw Error('injected_commit_ack_loss') } }
          if (method === 'rollback') return async () => { if (committed) rollbackAfterCommit++; return client.rollback() }
          if (method === 'destroy') return () => { discarded++; client.destroy() }
          const value = client[method]; return typeof value === 'function' ? value.bind(client) : value
        } })
      }
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
    } })
    const unused = () => { throw Error('unexpected_risk_or_clock') }
    const capture = async () => async (connection,plan) => {
      await createMysqlPartialCloseWorkflowWriter(connection, { async read() { return { target: { ...plan.target }, revision: 5, volume: '0.10' } } }).register(plan)
    }
    return { repo: new MysqlBridgeCommandRepository(wrapped,unused,unused,enabled ? capture : undefined), state: () => ({discarded,rollbackAfterCommit}) }
  }
  for (const failAt of ['partial_close_workflow_events_v4','bridge_command_events_v4','outbox_events']) {
    const f = await prepare()
    await assert.rejects(repository({failAt}).repo.create(f.command), /injected_parent_write_failure/)
    assert.deepEqual(await counts(f.command),[0,0,0,0,0,0])
  }
  checks.push('real-parent-payload-plan-audits-outbox-rollback-on-three-write-failures')
  const unavailable = await prepare()
  await assert.rejects(repository({enabled:false}).repo.create(unavailable.command), {code:'partial_close_workflow_unavailable'})
  assert.deepEqual(await counts(unavailable.command),[0,0,0,0,0,0])
  checks.push('unavailable-capability-persists-no-parent-command')
  const f = await prepare(), uncertain = repository({loseAck:true})
  await assert.rejects(uncertain.repo.create(f.command), {code:'bridge_command_commit_unknown'})
  assert.deepEqual(uncertain.state(),{discarded:1,rollbackAfterCommit:0})
  assert.deepEqual(await counts(f.command),[1,1,1,1,1,1])
  const [[times]] = await db.execute("SELECT DATE_FORMAT(issued_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') issued,DATE_FORMAT(deadline_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') deadline FROM bridge_commands_v4 WHERE id=?",[f.command.id])
  assert.equal(times.issued.slice(0,23)+'Z',f.command.issuedAt)
  assert.equal(times.deadline.slice(0,23)+'Z',f.command.deadlineAt)
  checks.push('parent-command-UTC-calendar-and-milliseconds-preserved-in-real-DATETIME')
  const resumed = await repository().repo.create(f.command)
  assert.equal(resumed.id,f.command.id)
  assert.deepEqual(await counts(f.command),[1,1,1,1,1,1])
  checks.push('commit-ack-loss-discards-connection-and-replays-one-durable-parent-plan-and-outbox')
  await assert.rejects(repository().repo.markDispatched(f.command.id,1,new Date().toISOString()), {code:'partial_close_workflow_dispatch_unavailable'})
  checks.push('durable-queued-parent-cannot-bypass-unfinished-child-workflow')
  const changed = structuredClone(f.action); changed.parameters.after_close_protection.stop_loss = '2401'
  await db.execute('UPDATE execution_intent_payloads SET action_json=?,action_sha256=? WHERE execution_intent_id=?',[JSON.stringify(changed),sha256Canonical(changed),f.command.executionIntentId])
  await assert.rejects(repository().repo.create(f.command), /partial_close_registration_conflict/)
  assert.deepEqual(await counts(f.command),[1,1,1,1,1,1])
  await db.execute('UPDATE execution_intent_payloads SET action_json=?,action_sha256=? WHERE execution_intent_id=?',[JSON.stringify(f.action),sha256Canonical(f.action),f.command.executionIntentId])
  checks.push('changed-protection-on-parent-replay-conflicts-with-durable-plan')
  const dispatchReceipt=await verifyPartialCloseParentDispatchReference(db,f.command,f.action)
  let dispatchTransaction, resultTransaction, progressChain
  if(options.dispatchTransaction){
    dispatchTransaction=await verifyParentDispatchTransaction(db,pool,f.command,f.action)
    const payload={command_id:f.command.id,action:'position.close',status:'succeeded',completed_at_utc_msc:Date.now(),
      result:{raw_result:{order:201,deal:301,position:101},evidence:{order_tickets:['201'],deal_tickets:['301'],position_tickets:['101']}},error_code:null,terminal_code:10009}
    const envelope={v:4,message_id:randomUUID(),type:'command.result',sent_at_utc_msc:payload.completed_at_utc_msc,
      correlation_id:f.command.request.message_id,route:f.command.request.route,payload}
    resultTransaction=await verifyParentResultTransaction(db,pool,f.command,payload,bridgeResultHash(envelope))
    progressChain=await verifyParentProgressChain(db,pool,f.command)
  }
  return {passed:true,checks,dispatchReceipt,dispatchTransaction,resultTransaction,progressChain,storage:'real-InnoDB-permanent-tables',schema:'candidate-056-and-explicit-parent-query-scaffolds',targetReader:'injected',runtimeWired:false,existingDatabaseWrites:0}
}
