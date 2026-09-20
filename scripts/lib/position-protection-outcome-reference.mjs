import assert from 'node:assert/strict'
import {readPositionProtectionSuccessReceipt} from '../../server/dist-v4/modules/execution/composition.js'
import {canonicalHash} from '../../server/dist-v4/modules/execution/domain/bridge-command.js'
import {readFile} from 'node:fs/promises'
import {splitSqlStatements} from './v4-migration-plan.mjs'
import {mergePositionProtectionOutcome,createMysqlPositionProtectionReceiverScope,createMysqlPositionProtectionOutcomeService,createMysqlPositionProtectionPreparation,createMysqlPartialCloseWorkflowProgress,createMysqlPartialCloseWorkflowRecovery,replayPositionProtectionCommandBinding} from '../../server/dist-v4/modules/execution/composition.js'
import {createPositionProtectionOutcomeProjectionCapture} from '../../server/dist-v4/bootstrap/position-protection-outcome.js'
import {createPartialCloseWorkflowWorker} from '../../server/dist-v4/modules/execution/application/partial-close-workflow-worker.js'
import {createPartialCloseWorkflowProcessor} from '../../server/dist-v4/queue/partial-close-workflow-processor.js'
import {bridgeCommandTransaction} from '../../server/dist-v4/modules/execution/infrastructure/bridge-command-transaction.js'
import {createMysqlPositionProtectionReconciliationRequest} from '../../server/dist-v4/modules/execution/composition.js'
import {verifyProtectionResultTransaction} from './position-protection-result-transaction-reference.mjs'

export async function verifyProtectionOutcomeReceipt(db,source,pool) {
 const [[identity]]=await db.query('SELECT DATABASE() db');assert.match(identity.db,/^dev_vue_protection_ref_[a-f0-9]{32}$/)
 await db.query(`CREATE TABLE bridge_command_results_v4 (bridge_command_id VARCHAR(191),message_id VARCHAR(191),result_sha256 CHAR(64),
  action VARCHAR(64),status VARCHAR(32),conflict TINYINT,result_json JSON,error_code VARCHAR(128),terminal_code VARCHAR(64),completed_at_utc DATETIME(3)) ENGINE=InnoDB`)
 for(const sql of splitSqlStatements(await readFile(new URL('../../server/db/migrations/inplace/061_position_protection_outcomes.sql',import.meta.url),'utf8')))await db.query(sql)
 for(const sql of splitSqlStatements(await readFile(new URL('../../server/db/migrations/inplace/062_position_protection_unissued_expiries.sql',import.meta.url),'utf8')))await db.query(sql)
 await db.beginTransaction()
 try {
  const [[clock]]=await db.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at'),completed=Number(clock.at)
  const payload={command_id:source.id,action:source.action,status:'succeeded',completed_at_utc_msc:completed,result:{ticket:source.request.payload.params.ticket},error_code:null,terminal_code:10009}
  const hash=canonicalHash(payload),command={...source,status:'succeeded',completedAt:new Date(completed).toISOString(),resultHash:hash,resultMessageId:'result-1'}
  await db.execute("UPDATE bridge_commands_v4 SET status='succeeded',result_sha256=?,result_message_id=?,completed_at_utc=? WHERE id=?",
   [hash,command.resultMessageId,command.completedAt.replace('T',' ').replace('Z',''),command.id])
  await db.execute("UPDATE execution_intents SET status='succeeded' WHERE id=?",[command.executionIntentId])
  assert.equal(await readPositionProtectionSuccessReceipt(db,command),null)
  await db.execute("INSERT INTO bridge_command_results_v4 VALUES (?,?,?,'position.protection.set','succeeded',0,?,NULL,'10009',?)",
   [command.id,command.resultMessageId,hash,JSON.stringify(payload.result),command.completedAt.replace('T',' ').replace('Z','')])
  const receipt=await readPositionProtectionSuccessReceipt(db,command)
  assert.equal(receipt.resultHash,hash);assert.equal(receipt.completedAt,completed)
  await db.query('UPDATE bridge_command_results_v4 SET conflict=1')
  assert.equal(await readPositionProtectionSuccessReceipt(db,command),null)
  await db.query('UPDATE bridge_command_results_v4 SET conflict=0')
  await db.query("UPDATE bridge_command_results_v4 SET result_json=JSON_OBJECT('ticket','other')")
  await assert.rejects(()=>readPositionProtectionSuccessReceipt(db,command),/position_protection_receipt_invalid/)
  await db.execute('UPDATE bridge_command_results_v4 SET result_json=?',[JSON.stringify(payload.result)])
  await db.query("UPDATE bridge_command_results_v4 SET message_id='other'")
  assert.equal(await readPositionProtectionSuccessReceipt(db,command),null)
  await db.query("UPDATE bridge_command_results_v4 SET message_id='result-1'")
  await db.query('INSERT INTO bridge_command_results_v4 SELECT * FROM bridge_command_results_v4')
  await assert.rejects(()=>readPositionProtectionSuccessReceipt(db,command),/position_protection_receipt_invalid/)
  await db.query('DELETE FROM bridge_command_results_v4 LIMIT 1')
  await db.rollback()
  const resultTransactionEvidence=await verifyProtectionResultTransaction(db,pool,source,payload,hash)
  const [[childRow]]=await db.execute('SELECT child_json FROM position_protection_reviews_v4 WHERE child_intent_id=?',[source.executionIntentId])
  const child=typeof childRow.child_json==='string'?JSON.parse(childRow.child_json):childRow.child_json
  const scope={workflowId:child.request.workflowId,userId:source.userId,accountId:source.accountId}
  let projectionCalls=0
  const projection=async connection=>{
   projectionCalls++
   const [[clock]]=await connection.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at')
   const target={...child.request.target,userId:String(source.userId),accountId:source.accountId}
   return {route:target,complete:true,revision:child.intent.action.expectedState.positionsRevision+2,observedAt:Number(clock.at),positions:[{
    target,volume:child.request.remainingVolume,stopLoss:child.request.protection.stopLoss??null,takeProfit:child.request.protection.takeProfit??null,
   }]}
  }
  const counts=async()=>{
   const [[row]]=await db.execute(`SELECT w.status,w.revision,
    (SELECT COUNT(*) FROM position_protection_outcomes_v4 WHERE workflow_id=w.id) receipts,
    (SELECT COUNT(*) FROM partial_close_workflow_events_v4 WHERE workflow_id=w.id) events,
    (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id=w.id) outbox FROM partial_close_workflows_v4 w WHERE id=?`,[scope.workflowId])
   return row
  }
  await db.execute("UPDATE outbox_events SET status='dispatched' WHERE aggregate_id=?",[scope.workflowId])
  await db.execute('UPDATE partial_close_workflows_v4 SET updated_at_utc=UTC_TIMESTAMP(3)-INTERVAL 2 SECOND WHERE id=?',[scope.workflowId])
  const requested=async()=>{const [[row]]=await db.execute("SELECT COUNT(*) n FROM outbox_events WHERE aggregate_id=? AND event_type='execution.partial-close.requested' AND status='pending'",[scope.workflowId]);return Number(row.n)}
  await createMysqlPartialCloseWorkflowRecovery(pool).schedule(500)
  assert.equal(await requested(),0)
  await createMysqlPartialCloseWorkflowRecovery(pool,{protecting:true}).schedule(500)
  assert.equal(await requested(),1)
  await createMysqlPartialCloseWorkflowRecovery(pool,{protecting:true}).schedule(500)
  assert.equal(await requested(),1)
  const before=await counts();assert.equal(Number(before.revision),3)
  const receiverScope=createMysqlPositionProtectionReceiverScope(pool)
  assert.equal(await receiverScope.read(scope,source.executionIntentId),'active')
  await assert.rejects(()=>receiverScope.read(scope,'33333333-3333-5333-a333-333333333333'),/position_protection_receiver_scope_mismatch/)
  const waiting=await bridgeCommandTransaction(pool,c=>mergePositionProtectionOutcome(c,scope,async()=>null,30000))
  assert.equal(waiting.outcome.state,'waiting');assert.deepEqual(await counts(),before)
  const noFacts=async()=>{throw Error('must_not_reread_parent_facts')}
  const pendingWorker=createPartialCloseWorkflowWorker(
   createMysqlPartialCloseWorkflowProgress(pool,async()=>()=>({history:{read:noFacts},projection:{read:noFacts}}),30000),
   createMysqlPositionProtectionPreparation(pool,async()=>()=>({review:noFacts})),
   createMysqlPositionProtectionOutcomeService(pool,async()=>async()=>null,30000))
  assert.equal((await pendingWorker.run(scope)).state,'waiting');assert.deepEqual(await counts(),before)
  await db.beginTransaction()
  try {
   await db.execute("UPDATE bridge_commands_v4 SET status='uncertain' WHERE id=?",[source.id])
   const uncertain=await mergePositionProtectionOutcome(db,scope,async()=>{throw Error('uncertain_must_not_read_projection')},30000)
   assert.equal(uncertain.outcome.state,'reconcile')
  }finally{await db.rollback()}
  assert.deepEqual(await counts(),before)
  const wrapped=(fault=null,loseAck=false)=>({async getConnection(){const c=await pool.getConnection();return new Proxy(c,{get(t,key){
   if(key==='execute')return async(sql,...args)=>{const result=await t.execute(sql,...args);if(fault&&new RegExp('^\\s*(INSERT INTO|UPDATE) '+fault+'\\b').test(sql))throw Error('outcome_write_fault');return result}
   if(key==='commit')return async()=>{await t.commit();if(loseAck)throw Error('outcome_commit_ack_loss')}
   const value=t[key];return typeof value==='function'?value.bind(t):value
  }})}})
  for(const table of ['position_protection_outcomes_v4','partial_close_workflows_v4','partial_close_workflow_events_v4','outbox_events']){
   await assert.rejects(()=>bridgeCommandTransaction(wrapped(table),c=>mergePositionProtectionOutcome(c,scope,projection,30000)),/outcome_write_fault/)
   assert.deepEqual(await counts(),before)
  }
  await assert.rejects(()=>bridgeCommandTransaction(wrapped(null,true),c=>mergePositionProtectionOutcome(c,scope,projection,30000)),/bridge_command_commit_unknown/)
  const saved=await counts();assert.equal(saved.status,'succeeded');assert.equal(Number(saved.revision),4);assert.equal(Number(saved.receipts),1)
  const calls=projectionCalls
  const recovered=await bridgeCommandTransaction(pool,c=>mergePositionProtectionOutcome(c,scope,async()=>{throw Error('must_not_read_current_positions')},30000))
  assert.equal(recovered.replayed,true);assert.equal(recovered.outcome.state,'succeeded');assert.equal(projectionCalls,calls);assert.deepEqual(await counts(),saved)
  assert.equal(await receiverScope.read(scope,source.executionIntentId),'terminal')
  const offlineService=createMysqlPositionProtectionOutcomeService(pool,createPositionProtectionOutcomeProjectionCapture({async current(){throw Error('redis_unavailable')}},30000),30000)
  assert.equal((await offlineService.merge(scope)).outcome.state,'succeeded')
  assert.deepEqual(await counts(),saved)
  const unexpected=async()=>{throw Error('terminal_replay_must_not_request_live_facts')}
  const preparation=createMysqlPositionProtectionPreparation(pool,async()=>()=>({review:unexpected}))
  const progress=createMysqlPartialCloseWorkflowProgress(pool,async()=>()=>({history:{read:unexpected},projection:{read:unexpected}}),30000)
  const storedPreparation=await preparation.prepare(scope)
  assert.equal(storedPreparation.status,'succeeded');assert.equal(storedPreparation.revision,4);assert.equal(storedPreparation.childIntentId,source.executionIntentId)
  const worker=createPartialCloseWorkflowWorker(progress,preparation)
  const process=createPartialCloseWorkflowProcessor(worker,unexpected)
  const result=await process({name:'execution.partial-close.run',data:scope,moveToDelayed:unexpected},'token')
  assert.equal(result.state,'succeeded');assert.deepEqual(await counts(),saved)
  await bridgeCommandTransaction(pool,c=>replayPositionProtectionCommandBinding(c,command,scope.workflowId))
  assert.deepEqual(await counts(),saved)
  const [[requestsBefore]]=await db.execute("SELECT COUNT(*) n FROM outbox_events WHERE aggregate_id=? AND event_type='bridge.command.reconcile.requested'",[command.id])
  await createMysqlPositionProtectionReconciliationRequest(pool)(scope,command.executionIntentId,command.id)
  const [[requestsAfter]]=await db.execute("SELECT COUNT(*) n FROM outbox_events WHERE aggregate_id=? AND event_type='bridge.command.reconcile.requested'",[command.id])
  assert.equal(Number(requestsAfter.n),Number(requestsBefore.n))
  await db.query("UPDATE position_protection_outcomes_v4 SET evidence_sha256=REPEAT('0',64)")
  await assert.rejects(()=>bridgeCommandTransaction(pool,c=>mergePositionProtectionOutcome(c,scope,projection,30000)),/position_protection_outcome_corrupt/)
  return {passed:true,resultTransactionEvidence,checks:['missing-receipt-waits','numeric-terminal-code-original-hash-verified','conflicting-result-excluded','tampered-result-rejected','foreign-message-excluded','ambiguous-receipts-rejected','waiting-and-uncertain-do-not-write-terminal-state','four-outcome-writes-rollback-atomically','commit-ack-loss-replays-frozen-terminal-result','terminal-preparation-progress-worker-processor-and-command-binding-replay-without-live-facts-or-dispatch','tampered-terminal-evidence-rejected'],schema:'query-scaffold-with-actual-061',terminalResult:'seeded',projection:'injected',existingDatabaseWrites:0}
 }finally{await db.rollback()}
}
