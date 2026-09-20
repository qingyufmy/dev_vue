import assert from 'node:assert/strict'
import {createMysqlPartialCloseReceiptReader,createMysqlPartialCloseWorkflowProgress} from '../../server/dist-v4/modules/execution/composition.js'
import {createPartialCloseHistoryProofReader} from '../../server/dist-v4/bootstrap/partial-close-history-proof.js'

export async function verifyParentProgressChain(db,pool,command){
 const [[identity]]=await db.query('SELECT DATABASE() db');assert.match(identity.db,/^dev_vue_strategy_ref_[a-f0-9]{32}$/)
 const [[stored]]=await db.execute('SELECT plan_json FROM partial_close_workflows_v4 WHERE parent_command_id=?',[command.id])
 const plan=typeof stored.plan_json==='string'?JSON.parse(stored.plan_json):stored.plan_json
 const receipt=await createMysqlPartialCloseReceiptReader(db).read(plan)
 assert.ok(receipt);assert.equal(receipt.orderTicket,'201');assert.deepEqual(receipt.dealTickets,['301'])
 const scope={workflowId:plan.workflowId,userId:command.userId,accountId:command.accountId}
 let historyReady=false,projectionMode='missing',projectionCalls=0
 const state=async()=>{
  const [[row]]=await db.execute('SELECT status,revision FROM partial_close_workflows_v4 WHERE id=?',[plan.workflowId])
  const [[events]]=await db.execute('SELECT COUNT(*) n FROM partial_close_workflow_events_v4 WHERE workflow_id=?',[plan.workflowId])
  const [[outbox]]=await db.execute('SELECT COUNT(*) n FROM outbox_events WHERE aggregate_id=?',[plan.workflowId])
  return {status:row.status,revision:Number(row.revision),events:Number(events.n),outbox:Number(outbox.n)}
 }
 const scopedPool={async getConnection(){const connection=await pool.getConnection();await connection.query("SET SESSION time_zone='+00:00'");return connection}}
 const progress=createMysqlPartialCloseWorkflowProgress(scopedPool,async()=>connection=>({
  history:createPartialCloseHistoryProofReader(createMysqlPartialCloseReceiptReader(connection),{async read(input){
   assert.equal(input.orderTicket,receipt.orderTicket);assert.deepEqual(input.receiptDealTickets,receipt.dealTickets)
   assert.equal(input.positionIdentifier,plan.target.positionIdentifier);assert.equal(input.expectedVolume,plan.closeVolume)
   if(!historyReady)return {status:'pending'}
   return {status:'matched',orderTicket:receipt.orderTicket,positionIdentifier:plan.target.positionIdentifier,closedVolume:plan.closeVolume,
    lastDealAtUtcMsc:receipt.completedAt,taskId:'history-task',receiptId:'history-receipt',completionHash:'b'.repeat(64),
    deals:[{ticket:'301',dealId:'deal',factHash:'c'.repeat(64),provenanceHashes:['d'.repeat(64)]}]}
  }},{...command.route,userId:command.userId,accountId:command.accountId,platform:'mt5'}),
  projection:{async read(){projectionCalls++;if(projectionMode==='missing')return null
   const [[clock]]=await connection.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at')
   return {route:{userId:String(command.userId),accountId:command.accountId,...command.route},complete:true,
    revision:projectionMode==='old'?plan.initialRevision:plan.initialRevision+1,observedAt:Number(clock.at),positions:[{target:plan.target,volume:'0.02'}]}
  }}
 }),30000)
 const before=await state();assert.equal(before.status,'awaiting_close')
 assert.equal((await progress.advance(scope)).assessment.state,'wait_history');assert.equal(projectionCalls,0);assert.deepEqual(await state(),before)
 historyReady=true
 assert.equal((await progress.advance(scope)).assessment.state,'wait_projection');assert.deepEqual(await state(),before)
 projectionMode='old'
 assert.equal((await progress.advance(scope)).assessment.state,'wait_projection');assert.deepEqual(await state(),before)
 projectionMode='new'
 const results=await Promise.all([progress.advance(scope),progress.advance(scope)])
 assert.ok(results.every(result=>result.status==='risk_review_required'));assert.equal(results.filter(result=>result.replayed).length,1)
 const after=await state();assert.deepEqual(after,{status:'risk_review_required',revision:2,events:before.events+1,outbox:before.outbox+1})
 assert.equal((await progress.advance(scope)).replayed,true);assert.deepEqual(await state(),after)
 return {passed:true,checks:['actual-persistResult-output-read-as-exact-order-and-deal-receipt','result-without-history-waits-without-projection-read',
  'missing-or-old-projection-waits-without-state-write','concurrent-valid-facts-create-one-review-request'],
  receipt:'actual-SQL-parent-result',history:'injected-completed-order-port',projection:'injected-current-collection-port',childPrepared:false}
}
