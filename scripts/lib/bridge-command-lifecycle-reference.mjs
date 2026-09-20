import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MysqlBridgeCommandRepository } from '../../server/dist-v4/modules/execution/composition.js'
import { createBridgeCommand, bridgeResultHash } from '../../server/dist-v4/modules/execution/domain/bridge-command.js'
import { sha256Canonical } from '../../server/dist-v4/modules/execution/domain/execution.js'

/** Local repository calls, no gateway transport. Permanent InnoDB query scaffolds in a random reference database. */
export async function verifyBridgeCommandLifecycleReference(db, pool) {
  const [[identity]] = await db.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const checks = [], create = (name, columns) => db.query(`CREATE TABLE ${name} (${columns}) ENGINE=InnoDB`)
  await db.query('ALTER TABLE execution_intents ADD error_code VARCHAR(128),ADD updated_at_utc DATETIME(3),ADD completed_at_utc DATETIME(3)')
  await create('execution_intent_events','id BIGINT AUTO_INCREMENT PRIMARY KEY,execution_intent_id CHAR(36),event_type VARCHAR(64),from_status VARCHAR(32),to_status VARCHAR(32),reason_code VARCHAR(128),from_revision INT,to_revision INT,payload_json JSON,occurred_at_utc DATETIME(3)')
  await create('operations','id CHAR(36) PRIMARY KEY,status VARCHAR(32),revision INT,result_summary_json JSON,updated_at_utc DATETIME(3),completed_at_utc DATETIME(3)')
  await create('operation_events','id BIGINT AUTO_INCREMENT PRIMARY KEY,operation_id CHAR(36),event_type VARCHAR(64),from_status VARCHAR(32),to_status VARCHAR(32),reason_code VARCHAR(128),from_revision INT,to_revision INT,payload_json JSON,occurred_at_utc DATETIME(3)')
  await create('risk_reservations_v4','id CHAR(36) PRIMARY KEY,execution_intent_id CHAR(36),status VARCHAR(32),revision INT,released_at_utc DATETIME(3),release_reason VARCHAR(128),updated_at_utc DATETIME(3)')
  await create('risk_reservation_events_v4','id BIGINT AUTO_INCREMENT PRIMARY KEY,risk_reservation_id CHAR(36),event_type VARCHAR(64),from_status VARCHAR(32),to_status VARCHAR(32),reason_code VARCHAR(128),from_revision INT,to_revision INT,occurred_at_utc DATETIME(3)')
  await create('bridge_command_results_v4','id BIGINT AUTO_INCREMENT PRIMARY KEY,bridge_command_id VARCHAR(191),message_id VARCHAR(191) UNIQUE,result_sha256 CHAR(64),action VARCHAR(64),status VARCHAR(32),result_json JSON,error_code VARCHAR(128),terminal_code VARCHAR(128),completed_at_utc DATETIME(3),received_at_utc DATETIME(3),conflict TINYINT')
  await create('execution_outcomes','id CHAR(36) PRIMARY KEY,execution_intent_id CHAR(36) UNIQUE,distribution_target_id CHAR(36),trading_account_id BIGINT,resource_kind VARCHAR(32),ticket VARCHAR(64),result_sha256 CHAR(64),status VARCHAR(32),result_json JSON,confirmed_at_utc DATETIME(3),created_at_utc DATETIME(3),updated_at_utc DATETIME(3),revision INT')
  await create('execution_distribution_targets','id CHAR(36) PRIMARY KEY,distribution_id CHAR(36),child_operation_id CHAR(36),status VARCHAR(32),revision INT,updated_at_utc DATETIME(3),completed_at_utc DATETIME(3)')
  await create('execution_distributions','id CHAR(36) PRIMARY KEY,parent_operation_id CHAR(36),status VARCHAR(32),revision INT,result_summary_json JSON,updated_at_utc DATETIME(3),completed_at_utc DATETIME(3)')
  // The earlier parent fixture intentionally leaves an undispatched command. Retire that synthetic fixture only.
  await db.query("UPDATE bridge_commands_v4 SET status='failed' WHERE status='queued'")
  let loseCommitAck = false, discarded = 0
  const wrapped = new Proxy(pool,{get(target,key){
    if(key==='getConnection')return async()=>{
      const c=await target.getConnection();await c.query("SET SESSION time_zone='+00:00'")
      return new Proxy(c,{get(client,method){
        if(method==='commit')return async()=>{await client.commit();if(loseCommitAck){loseCommitAck=false;throw Error('injected_lifecycle_commit_ack_loss')}}
        if(method==='destroy')return()=>{discarded++;client.destroy()}
        const value=client[method];return typeof value==='function'?value.bind(client):value
      }})
    }
    const value=target[key];return typeof value==='function'?value.bind(target):value
  }})
  const unused=()=>{throw Error('unexpected_risk_or_clock')}
  const repo=new MysqlBridgeCommandRepository(wrapped,unused,unused)
  const expected={ticket:'101',symbol:'XAUUSD',direction:'buy',volume:'0.10',order_type:'market',magic:0,open_price:'2450',stop_limit_price:null,stop_loss:null,take_profit:null,expiration_utc_msc:null}
  const prepare=async()=>{
    const now=new Date(),intentId=randomUUID(),operationId=randomUUID(),parentId=randomUUID(),distributionId=randomUUID(),targetId=randomUUID(),reservationId=randomUUID()
    const expires=new Date(now.getTime()+300000)
    const action={actionId:'close',kind:'close_position',parameters:{ticket:'101',volume:'0.08'},expectedState:{positionsRevision:5}}
    await db.execute('INSERT INTO execution_intents (id,user_id,trading_account_id,action_kind,status,expires_at_utc,operation_id,source_type,source_id) VALUES (?,7,5,?,?,?, ?,?,?)',[intentId,'close_position','prepared',expires,operationId,'distribution_close',targetId])
    await db.execute('INSERT INTO execution_intent_payloads VALUES (?,?,?)',[intentId,JSON.stringify(action),sha256Canonical(action)])
    for(const id of [operationId,parentId])await db.execute("INSERT INTO operations (id,status,revision,result_summary_json) VALUES (?,'queued',1,JSON_OBJECT())",[id])
    await db.execute("INSERT INTO execution_distribution_targets (id,distribution_id,child_operation_id,status,revision) VALUES (?,?,?,'queued',1)",[targetId,distributionId,operationId])
    await db.execute("INSERT INTO execution_distributions (id,parent_operation_id,status,revision,result_summary_json) VALUES (?,?,'queued',1,JSON_OBJECT())",[distributionId,parentId])
    await db.execute("INSERT INTO risk_reservations_v4 (id,execution_intent_id,status,revision) VALUES (?,?,'active',1)",[reservationId,intentId])
    const command=await repo.create(createBridgeCommand({executionIntentId:intentId,commandSequence:1,userId:7,accountId:'5',terminalProfileId:'profile_12345678',
      route:{terminalInstanceId:'terminal_12345678',brokerServer:'Broker',login:'42',connectionEpoch:1},action:'position.close',params:{ticket:'101',volume:'0.08',deviation:20},expectedState:expected,deadlineAt:expires.toISOString()},now))
    return {command,intentId,operationId,parentId,distributionId,targetId,reservationId,tick:step=>new Date(now.getTime()+step).toISOString()}
  }
  const time=async(table,column,key,id,expectedTime)=>{
    const [[r]]=await db.execute(`SELECT DATE_FORMAT(${column},'%Y-%m-%dT%H:%i:%s.%fZ') value FROM ${table} WHERE ${key}=?`,[id])
    assert.ok(r);assert.equal(r.value===null?null:r.value.slice(0,23)+'Z',expectedTime)
  }
  const result=(f,status,step=30)=>({v:4,message_id:randomUUID(),type:'command.result',sent_at_utc_msc:Date.parse(f.tick(step)),correlation_id:f.command.request.message_id,route:f.command.request.route,
    payload:{command_id:f.command.id,action:'position.close',status,completed_at_utc_msc:Date.parse(f.tick(step)),result:status==='succeeded'?{deal_ticket:'301'}:null,error_code:status==='succeeded'?null:'test_terminal_result',terminal_code:null}})
  const assertFinished=async(f,status,at,reservation)=>{
    for(const [table,key,id] of [['execution_intents','id',f.intentId],['operations','id',f.operationId],['operations','id',f.parentId],['execution_distributions','id',f.distributionId],['execution_distribution_targets','id',f.targetId]]){
      const [[r]]=await db.execute(`SELECT status FROM ${table} WHERE ${key}=?`,[id]);assert.equal(r.status,status)
      await time(table,'completed_at_utc',key,id,at)
    }
    const [[r]]=await db.execute('SELECT status FROM risk_reservations_v4 WHERE id=?',[f.reservationId]);assert.equal(r.status,reservation)
  }
  const success=await prepare()
  loseCommitAck=true
  await assert.rejects(repo.markDispatched(success.command.id,1,success.tick(10)),{code:'bridge_command_commit_unknown'})
  let c=await repo.get(success.command.id)
  assert.equal(c.status,'dispatched');assert.equal(discarded,1)
  await assert.rejects(repo.markDispatched(c.id,1,success.tick(11)),{code:'bridge_command_revision_conflict'})
  await time('bridge_commands_v4','dispatched_at_utc','id',c.id,success.tick(10))
  c=await repo.markAccepted({v:4,message_id:randomUUID(),type:'command.accepted',sent_at_utc_msc:Date.parse(success.tick(20)),correlation_id:c.request.message_id,route:c.request.route,
    payload:{command_id:c.id,status:'recorded',accepted_at_utc_msc:Date.parse(success.tick(15))}},success.tick(20))
  await time('bridge_commands_v4','accepted_at_utc','id',c.id,success.tick(15))
  const envelope=result(success,'succeeded'),hash=bridgeResultHash(envelope)
  loseCommitAck=true
  await assert.rejects(repo.persistResult(envelope,hash,success.tick(40)),{code:'bridge_command_commit_unknown'})
  assert.equal(discarded,2)
  assert.equal((await repo.persistResult(envelope,hash,success.tick(40))).disposition,'duplicate')
  await time('bridge_commands_v4','completed_at_utc','id',c.id,success.tick(30))
  await time('execution_outcomes','confirmed_at_utc','execution_intent_id',success.intentId,success.tick(30))
  await time('bridge_command_results_v4','received_at_utc','message_id',envelope.message_id,success.tick(40))
  // Intent completion uses the terminal clock; operation/distribution completion uses server receipt time.
  await time('execution_intents','completed_at_utc','id',success.intentId,success.tick(30))
  for(const id of [success.operationId,success.parentId])await time('operations','completed_at_utc','id',id,success.tick(40))
  assert.equal((await repo.persistResult(envelope,hash,success.tick(50))).disposition,'duplicate')
  const [[duplicates]]=await db.execute('SELECT COUNT(*) n FROM bridge_command_results_v4 WHERE bridge_command_id=?',[c.id]);assert.equal(Number(duplicates.n),1)
  checks.push('dispatch-and-result-commit-ack-loss-do-not-reapply-state-or-duplicate-result')
  checks.push('dispatch-accept-result-outcome-and-parent-distribution-UTC-clocks-and-idempotent-result')
  const conflict=result(success,'failed',60)
  assert.equal((await repo.persistResult(conflict,bridgeResultHash(conflict),success.tick(70))).disposition,'conflict')
  await time('execution_outcomes','confirmed_at_utc','execution_intent_id',success.intentId,null)
  await time('risk_reservations_v4','updated_at_utc','id',success.reservationId,success.tick(70))
  const [[held]]=await db.execute('SELECT status FROM risk_reservations_v4 WHERE id=?',[success.reservationId]);assert.equal(held.status,'active')
  checks.push('conflicting-result-reactivates-reservation-and-clears-outcome-confirmation')
  // Leave the conflict visible in its fixture; use another isolated account-command slot for subsequent cases.
  await db.execute("UPDATE bridge_commands_v4 SET status='failed' WHERE id=?",[success.command.id])
  const failed=await prepare()
  await repo.markPreDispatchFailed(failed.command.id,1,'test_preflight_failure',failed.tick(10))
  await assertFinished(failed,'failed',failed.tick(10),'released')
  await time('risk_reservations_v4','released_at_utc','id',failed.reservationId,failed.tick(10))
  checks.push('pre-dispatch-failure-release-and-distribution-completion-UTC')
  const reconcile=await prepare()
  c=await repo.markDispatched(reconcile.command.id,1,reconcile.tick(10))
  c=await repo.markUncertain(c.id,c.revision,'transport_unknown',reconcile.tick(20))
  c=await repo.beginReconciliation(c.id,c.revision,reconcile.tick(30))
  const rejected=result(reconcile,'rejected',40)
  await repo.persistResult(rejected,bridgeResultHash(rejected),reconcile.tick(40))
  await assertFinished(reconcile,'rejected',reconcile.tick(40),'released')
  checks.push('uncertain-reconciliation-rejection-UTC-and-reservation-release')
  return {passed:true,checks,schema:'explicit-permanent-query-scaffolds',transport:'not-created',realTerminal:false,existingDatabaseWrites:0}
}
