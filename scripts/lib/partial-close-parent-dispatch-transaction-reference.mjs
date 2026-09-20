import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {MysqlBridgeCommandRepository,writePartialCloseParentDispatchReview} from '../../server/dist-v4/modules/execution/composition.js'
import {buildPartialClosePlan} from '../../server/dist-v4/modules/execution/domain/partial-close-plan.js'
import {sha256Canonical} from '../../server/dist-v4/modules/execution/domain/execution.js'

export async function verifyParentDispatchTransaction(db,pool,command,action) {
 const [[identity]]=await db.query('SELECT DATABASE() db');assert.match(identity.db,/^dev_vue_strategy_ref_[a-f0-9]{32}$/)
 // Remove only the preceding writer-only fixture receipt in this owned reference database.
 await db.execute('DELETE FROM partial_close_parent_dispatches_v4 WHERE parent_command_id=?',[command.id])
 await db.query('ALTER TABLE execution_intents ADD error_code VARCHAR(128), ADD updated_at_utc DATETIME(3), ADD completed_at_utc DATETIME(3)')
 await db.query(`CREATE TABLE execution_intent_events (execution_intent_id CHAR(36),event_type VARCHAR(64),from_status VARCHAR(32),to_status VARCHAR(32),reason_code VARCHAR(128),from_revision INT,to_revision INT,payload_json JSON,occurred_at_utc DATETIME(3)) ENGINE=InnoDB`)
 await db.query(`CREATE TABLE operations (id CHAR(36) PRIMARY KEY,status VARCHAR(32),revision INT,updated_at_utc DATETIME(3),completed_at_utc DATETIME(3)) ENGINE=InnoDB`)
 await db.query(`CREATE TABLE operation_events (operation_id CHAR(36),event_type VARCHAR(64),from_status VARCHAR(32),to_status VARCHAR(32),reason_code VARCHAR(128),from_revision INT,to_revision INT,payload_json JSON,occurred_at_utc DATETIME(3)) ENGINE=InnoDB`)
 await db.query(`CREATE TABLE execution_distribution_targets (id CHAR(36),distribution_id CHAR(36),status VARCHAR(32),revision INT,child_operation_id CHAR(36)) ENGINE=InnoDB`)
 const operationId=randomUUID(),expires=Date.parse(command.deadlineAt),plan=buildPartialClosePlan(command,action,expires)
 await db.execute("INSERT INTO operations (id,status,revision) VALUES (?,'queued',1)",[operationId])
 await db.execute("UPDATE execution_intents SET operation_id=?,source_type='user_command' WHERE id=?",[operationId,command.executionIntentId])
 const state=async()=>{
  const [[parent]]=await db.execute('SELECT status,revision,dispatched_at_utc FROM bridge_commands_v4 WHERE id=?',[command.id])
  const [[intent]]=await db.execute('SELECT status,revision FROM execution_intents WHERE id=?',[command.executionIntentId])
  const [[operation]]=await db.execute('SELECT status,revision FROM operations WHERE id=?',[operationId])
  const counts=[]
  for(const [table,column,id] of [['partial_close_parent_dispatches_v4','parent_command_id',command.id],['bridge_command_events_v4','bridge_command_id',command.id],
   ['execution_intent_events','execution_intent_id',command.executionIntentId],['operation_events','operation_id',operationId],['outbox_events','aggregate_id',operationId]]){
   const [[row]]=await db.execute(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`,[id]);counts.push(Number(row.n))
  }
  return {parent,intent,operation,counts}
 }
 let reviewCalls=0
 const make=(fault=null)=>new MysqlBridgeCommandRepository({execute:(...args)=>db.execute(...args),async getConnection(){
  const connection=await pool.getConnection();await connection.query("SET SESSION time_zone='+00:00'")
  return new Proxy(connection,{get(target,key){
   if(key==='commit')return async()=>{await target.commit();if(fault==='commit')throw Error('parent_dispatch_commit_ack_lost')}
   if(key==='execute')return async(sql,...args)=>{const result=await target.execute(sql,...args)
    if(fault && new RegExp('^\\s*(INSERT INTO|UPDATE) '+fault+'\\b').test(sql))throw Error('parent_dispatch_late_write_fault')
    return result}
   const value=target[key];return typeof value==='function'?value.bind(target):value
  }})
 }},()=>{throw Error('unexpected_clock')},()=>{throw Error('unexpected_policy')},undefined,undefined,undefined,
 async()=>async(connection,candidate,source,expiry)=>writePartialCloseParentDispatchReview(connection,candidate,source,expiry,
  {async read(){return {target:structuredClone(plan.target),revision:plan.initialRevision,volume:plan.initialVolume}}},
  {async review(request){reviewCalls++;const [[clock]]=await connection.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at')
   return {status:'approved',rejectCode:null,requestHash:sha256Canonical(request),contextHash:'a'.repeat(64),policyHash:'b'.repeat(64),
    evaluatedAt:new Date(Number(clock.at)).toISOString(),volume:plan.closeVolume,remainingVolume:'0.02'}}}))
 const before=await state();assert.equal(before.parent.status,'queued');assert.deepEqual(before.counts,[0,1,0,0,0])
 for(const fault of ['partial_close_parent_dispatches_v4','bridge_commands_v4','bridge_command_events_v4','execution_intents','execution_intent_events','operations','operation_events','outbox_events']){
  await assert.rejects(()=>make(fault).markDispatched(command.id,1,new Date().toISOString()),/parent_dispatch_late_write_fault/)
  assert.deepEqual(await state(),before)
 }
 await assert.rejects(()=>make('commit').markDispatched(command.id,1,new Date().toISOString()),/bridge_command_commit_unknown/)
 const after=await state();assert.equal(after.parent.status,'dispatched');assert.equal(after.parent.revision,2)
 assert.equal(after.intent.status,'dispatching');assert.equal(after.operation.status,'running');assert.deepEqual(after.counts,[1,2,1,1,1])
 const calls=reviewCalls
 const replay=await Promise.allSettled([make().markDispatched(command.id,1,new Date().toISOString()),make().markDispatched(command.id,1,new Date().toISOString())])
 assert.ok(replay.every(result=>result.status==='rejected' && result.reason.code==='bridge_command_revision_conflict'))
 assert.equal(reviewCalls,calls);assert.deepEqual(await state(),after)
 return {passed:true,checks:['eight-late-write-faults-rollback-receipt-state-audits-and-outbox','commit-ack-loss-persists-one-joint-dispatch',
  'concurrent-dispatch-retries-conflict-before-review-or-write'],persistence:'actual-MysqlBridgeCommandRepository-and-receipt-writer',schema:'query-scaffold',
  targetReader:'injected',riskReviewer:'injected',transport:'not-invoked',runtimeWired:false}
}
