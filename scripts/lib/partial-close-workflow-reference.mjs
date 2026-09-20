import { verifyExecutionPositionReference } from './execution-position-reference.mjs'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { createMysqlPartialCloseWorkflowWriter } from '../../server/dist-v4/modules/execution/composition.js'
import { canonicalHash } from '../../server/dist-v4/modules/execution/domain/bridge-command.js'
import { sha256Canonical } from '../../server/dist-v4/modules/execution/domain/execution.js'

/** Full candidate tables/FKs; execution parents are explicitly minimal registration-query scaffolds. */
export async function verifyPartialCloseWorkflowReference(db, pool) {
  const [[identity]] = await db.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const checks = [], sha = value => createHash('sha256').update(value).digest('hex')
  await db.query(`CREATE TABLE execution_intents (id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    user_id INT NOT NULL,trading_account_id BIGINT UNSIGNED NOT NULL,action_kind VARCHAR(32) NOT NULL,status VARCHAR(32) NOT NULL,expires_at_utc DATETIME(3) NOT NULL) ENGINE=InnoDB`)
  await db.query(`CREATE TABLE execution_intent_payloads (execution_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    action_json JSON NOT NULL,action_sha256 CHAR(64) NOT NULL) ENGINE=InnoDB`)
  await db.query(`CREATE TABLE bridge_commands_v4 (id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    execution_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,user_id INT NOT NULL,trading_account_id BIGINT UNSIGNED NOT NULL,
    status VARCHAR(32) NOT NULL,action VARCHAR(64) NOT NULL,terminal_instance_id VARCHAR(128) NOT NULL,
    broker_server VARCHAR(128) NOT NULL,account_login VARCHAR(64) NOT NULL,request_sha256 CHAR(64) NOT NULL,deadline_at_utc DATETIME(3) NOT NULL,connection_epoch BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB`)
  await db.query(`CREATE TABLE bridge_command_payloads_v4 (bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    request_envelope_json JSON NOT NULL) ENGINE=InnoDB`)
  const sql = await readFile(new URL('../../server/db/migrations/inplace/056_partial_close_workflows.sql', import.meta.url), 'utf8')
  for (const statement of splitSqlStatements(sql)) await db.query(statement)
  const ddls = []
  for (const table of ['partial_close_workflows_v4','partial_close_workflow_events_v4']) {
    const [[row]] = await db.query(`SHOW CREATE TABLE ${table}`)
    ddls.push({ table, ddl: row['Create Table'] })
  }
  const target = { userId: '7', accountId: '5', terminalInstanceId: 'terminal-1', brokerServer: 'Broker', login: '42',
    positionIdentifier: '100', ticket: '101', symbol: 'XAUUSD', side: 'buy' }
  const plan = { workflowId: randomUUID(), parentIntentId: randomUUID(), parentCommandId: randomUUID(), target,
    initialVolume: '0.10', closeVolume: '0.08', initialRevision: 5, expiresAt: Date.now()+600000, protection: { stopLoss: '2400' } }
  const action = { kind: 'close_position', parameters: { ticket: '101', volume: '0.08' }, expectedState: { positionsRevision: 5 } }
  const request = { v: 4, type: 'command.request', correlation_id: plan.parentIntentId,
    route: { terminal_instance_id: 'terminal-1', account_ref: { broker_server: 'Broker', login: '42' }, connection_epoch: 1 },
    payload: { command_id: plan.parentCommandId, action: 'position.close', params: { ticket: '101', volume: '0.080' },
      expected_state: { ticket: '101', symbol: 'XAUUSD', direction: 'buy', volume: '0.100' } } }
  await db.execute('INSERT INTO execution_intents VALUES (?,7,5,?,?,?)',[plan.parentIntentId,'close_position','prepared',new Date(plan.expiresAt)])
  await db.execute('INSERT INTO execution_intent_payloads VALUES (?,?,?)',[plan.parentIntentId,JSON.stringify(action),sha256Canonical(action)])
  await db.execute('INSERT INTO bridge_commands_v4 VALUES (?,?,7,5,?,?,?,?,?,?,?,1)',[plan.parentCommandId,plan.parentIntentId,'queued','position.close','terminal-1','Broker','42',canonicalHash(request.payload),new Date(plan.expiresAt)])
  await db.execute('INSERT INTO bridge_command_payloads_v4 VALUES (?,?)',[plan.parentCommandId,JSON.stringify(request)])
  const targetEvidence = await verifyExecutionPositionReference(db,plan)
  const reader = { async read() { return { target: { ...target }, revision: 5, volume: '0.1000' } } }
  const writer = createMysqlPartialCloseWorkflowWriter(db, reader)
  const counts = async () => {
    const [[row]] = await db.query(`SELECT (SELECT COUNT(*) FROM partial_close_workflows_v4) workflows,
      (SELECT COUNT(*) FROM partial_close_workflow_events_v4) events`)
    return [Number(row.workflows),Number(row.events)]
  }
  const reject = async (source, pattern, port = reader) => {
    await db.beginTransaction()
    try { await assert.rejects(createMysqlPartialCloseWorkflowWriter(db,port).register(source),pattern) }
    finally { await db.rollback() }
    assert.deepEqual(await counts(),[0,0])
  }
  for (const patch of [{ parentCommandId: randomUUID() }, { target: { ...target, userId: '8' } },
    { initialRevision: 4 }, { closeVolume: '0.07' }, { target: { ...target, brokerServer: 'broker' } },
    { target: { ...target, ticket: '102' } }, { initialVolume: '0.11' }]) {
    await reject({ ...plan, ...patch },/partial_close_parent_mismatch/)
  }
  await reject(plan,/partial_close_registration_target_mismatch/,{ async read(){return null} })
  await reject(plan,/partial_close_registration_target_mismatch/,{ async read(){return { target:{...target,positionIdentifier:'999'},revision:5,volume:'0.1'} } })
  checks.push('parent-command-intent-route-volume-revision-and-stable-target-scope')
  await db.execute("UPDATE bridge_commands_v4 SET status='dispatched' WHERE id=?",[plan.parentCommandId])
  await reject(plan,/partial_close_registration_too_late/)
  await db.execute("UPDATE bridge_commands_v4 SET status='queued' WHERE id=?",[plan.parentCommandId])
  await reject({...plan,expiresAt:Date.now()-1000},/partial_close_registration_too_late/)
  await db.execute("UPDATE execution_intents SET status='expired' WHERE id=?",[plan.parentIntentId])
  await reject(plan,/partial_close_registration_too_late/)
  await db.execute("UPDATE execution_intents SET status='prepared' WHERE id=?",[plan.parentIntentId])
  checks.push('new-registration-rejected-after-dispatch-or-intent-or-plan-expiry')
  await db.beginTransaction()
  const created = await writer.register(plan)
  assert.equal(created.replayed,false)
  assert.deepEqual(await counts(),[1,1])
  await db.rollback()
  assert.deepEqual(await counts(),[0,0])
  checks.push('caller-rollback-removes-plan-and-audit-together')
  const broken = new Proxy(db,{get(client,key){
    if(key==='execute')return async (...args)=>{
      if(String(args[0]).includes('INSERT INTO partial_close_workflow_events_v4'))throw Error('injected_event_failure')
      return client.execute(...args)
    }
    const value=client[key];return typeof value==='function'?value.bind(client):value
  }})
  await db.beginTransaction()
  await assert.rejects(createMysqlPartialCloseWorkflowWriter(broken,reader).register(plan),/injected_event_failure/)
  await db.rollback()
  assert.deepEqual(await counts(),[0,0])
  checks.push('event-write-failure-rolls-back-registration')
  // Two real sessions serialize on the parent. The second sees the first committed registration.
  const second = await pool.getConnection()
  try {
    await second.query("SET SESSION time_zone='+00:00'")
    await db.beginTransaction();await second.beginTransaction()
    assert.equal((await writer.register(plan)).replayed,false)
    const waiting=createMysqlPartialCloseWorkflowWriter(second,reader).register(plan)
    await assert.rejects((async()=>{await db.commit();throw Error('injected_postcommit_ack_loss')})(),/injected_postcommit_ack_loss/)
    assert.equal((await waiting).replayed,true)
    await second.commit()
  } finally { await second.rollback();second.release() }
  assert.deepEqual(await counts(),[1,1])
  checks.push('concurrent-identical-registration-produces-one-plan-and-one-event')
  await db.execute("UPDATE bridge_commands_v4 SET status='succeeded' WHERE id=?",[plan.parentCommandId])
  await db.beginTransaction()
  assert.equal((await writer.register(plan)).replayed,true)
  await db.commit()
  await db.beginTransaction()
  await assert.rejects(writer.register({...plan,protection:{stopLoss:'2401'}}),/partial_close_registration_conflict/)
  await db.rollback()
  await db.beginTransaction()
  await assert.rejects(writer.register({...plan,workflowId:randomUUID()}),/partial_close_registration_conflict/)
  await db.rollback()
  assert.deepEqual(await counts(),[1,1])
  checks.push('lost-registration-ack-replay-after-parent-completion-and-changed-body-conflict')
  await db.beginTransaction()
  await db.execute("UPDATE partial_close_workflows_v4 SET plan_json=JSON_SET(plan_json,'$.closeVolume','0.07') WHERE id=?",[plan.workflowId])
  await assert.rejects(writer.register(plan),/partial_close_registration_conflict/)
  await db.rollback()
  await db.beginTransaction()
  await db.execute('DELETE FROM partial_close_workflow_events_v4 WHERE workflow_id=?',[plan.workflowId])
  await assert.rejects(writer.register(plan),/partial_close_registration_audit_mismatch/)
  await db.rollback()
  checks.push('stored-plan-hash-corruption-and-missing-registration-audit-rejected')
  await assert.rejects(db.execute(`INSERT INTO partial_close_workflow_events_v4 VALUES (?,2,'bad',JSON_OBJECT(),?,UTC_TIMESTAMP(3))`,[randomUUID(),'a'.repeat(64)]),{code:'ER_NO_REFERENCED_ROW_2'})
  checks.push('candidate-audit-foreign-key-enforced')
  return { passed:true,checks,targetEvidence,migrationSha256:sha(sql),tables:ddls,parentTables:'minimal-query-scaffolds',
    targetReader:'injected-transaction-port',runtimeWired:false,existingDatabaseWrites:0 }
}
