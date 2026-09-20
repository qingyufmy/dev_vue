import {verifyPositionProtectionBinding} from './position-protection-binding-reference.mjs'
import {verifyPositionProtectionCommandReview} from './position-protection-command-reference.mjs'
import {verifyPartialCloseQueue} from './partial-close-queue-reference.mjs'
import {createPartialCloseWorkflowWorker} from '../../server/dist-v4/modules/execution/index.js'
import {createPositionProtectionReviewCapture} from '../../server/dist-v4/bootstrap/position-protection-preparation.js'
import {createPartialCloseProgressCapture} from '../../server/dist-v4/bootstrap/partial-close-progress.js'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {splitSqlStatements} from './v4-migration-plan.mjs'
import {createMysqlPositionProtectionPreparation,createMysqlPartialCloseWorkflowProgress,createMysqlPartialCloseWorkflowRecovery} from '../../server/dist-v4/modules/execution/composition.js'
import {sha256Canonical} from '../../server/dist-v4/modules/execution/domain/execution.js'

/** Actual 009 operation/intent DDL, 011 source ALTER, 056 and 058; other parents and risk review are fixtures. */
export async function verifyPositionProtectionPreparation(pool) {
 const db=await pool.getConnection(),name='dev_vue_protection_ref_'+randomUUID().replaceAll('-',''),checks=[]
 let original,created=false,fault=null,rejected=false,reviewCalls=0,phase='ddl'
 try {
  const [[identity]]=await db.query('SELECT DATABASE() db');original=identity.db
  assert.match(original,/^dev_vue_strategy_ref_[a-f0-9]{32}$/);assert.match(name,/^dev_vue_protection_ref_[a-f0-9]{32}$/)
  await db.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;await db.query(`USE ${name}`)
  await db.query("SET SESSION time_zone='+00:00'")
  const id='CHAR(36) CHARACTER SET ascii COLLATE ascii_bin'
  for(const sql of [
   'CREATE TABLE users (id INT PRIMARY KEY) ENGINE=InnoDB','CREATE TABLE trading_accounts (id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB',
   `CREATE TABLE risk_decisions_v4 (id ${id} PRIMARY KEY) ENGINE=InnoDB`,`CREATE TABLE trade_decisions (id ${id} PRIMARY KEY) ENGINE=InnoDB`,
   `CREATE TABLE user_execution_commands (id ${id} PRIMARY KEY) ENGINE=InnoDB`,
   "CREATE TABLE trading_account_ownerships (trading_account_id BIGINT UNSIGNED,user_id INT,role VARCHAR(32),revoked_at_utc DATETIME(3)) ENGINE=InnoDB",
   `CREATE TABLE bridge_commands_v4 (id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,execution_intent_id ${id},user_id INT,trading_account_id BIGINT UNSIGNED,action VARCHAR(64),status VARCHAR(32)) ENGINE=InnoDB`,
   `CREATE TABLE outbox_events (event_id ${id} PRIMARY KEY,aggregate_type VARCHAR(64),aggregate_id VARCHAR(191),event_type VARCHAR(128),payload_json JSON,status VARCHAR(32),attempts INT,available_at_utc DATETIME(3),created_at_utc DATETIME(3)) ENGINE=InnoDB`,
  ]) await db.query(sql)
  const load=async path=>splitSqlStatements(await readFile(new URL('../../server/db/migrations/'+path,import.meta.url),'utf8'))
  const base=await load('20260903_009_execution_intents_and_reservations.sql')
  for(const table of ['operations','operation_events','execution_intents','execution_intent_payloads','execution_intent_events']) {
   const ddl=base.find(sql=>new RegExp('CREATE TABLE IF NOT EXISTS '+table+' \\(').test(sql));assert.ok(ddl);await db.query(ddl)
  }
  const user=await load('20260904_011_user_execution_commands_and_distributions.sql')
  await db.query(user.find(sql=>/ALTER TABLE operations/.test(sql)))
  for(const sql of await load('corrections/011-execution-intent-foreign-keys.sql'))await db.query(sql)
  for(const sql of await load('inplace/056_partial_close_workflows.sql'))await db.query(sql)
  const migration=await readFile(new URL('../../server/db/migrations/inplace/058_position_protection_children.sql',import.meta.url),'utf8')
  for(const sql of splitSqlStatements(migration))await db.query(sql)
  await db.query('INSERT INTO users VALUES (7)');await db.query('INSERT INTO trading_accounts VALUES (5)')
  await db.query("INSERT INTO trading_account_ownerships VALUES (5,7,'owner',NULL)")
  const userCommand=randomUUID();await db.execute('INSERT INTO user_execution_commands VALUES (?)',[userCommand])
  const seed=async(offset=0)=>{
   const [[clock]]=await db.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at'),at=Number(clock.at)+offset
   const workflowId=randomUUID(),parentIntentId=randomUUID(),parentOperationId=randomUUID(),parentCommandId=randomUUID()
   await db.execute(`INSERT INTO operations (id,user_id,trading_account_id,kind,status,source_type,source_id,idempotency_scope,idempotency_key,request_sha256,accepted_at_utc,updated_at_utc)
    VALUES (?,7,5,'user_execution_command','succeeded','user_command',?,'user_command',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,[parentOperationId,userCommand,sha256Canonical(parentOperationId),sha256Canonical('parent')])
   await db.execute(`INSERT INTO execution_intents (id,operation_id,risk_decision_id,trade_decision_id,user_command_id,risk_decision_revision,account_risk_revision,user_id,trading_account_id,action_id,action_kind,source_type,source_id,idempotency_key,request_sha256,expected_state_sha256,status,expires_at_utc,created_at_utc,updated_at_utc)
    VALUES (?,?,NULL,NULL,?,NULL,1,7,5,?,'close_position','user_command',?,?,?,?,'succeeded',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
    [parentIntentId,parentOperationId,userCommand,parentIntentId,userCommand,sha256Canonical(parentIntentId),sha256Canonical('parent'),sha256Canonical({})])
   await db.execute("INSERT INTO bridge_commands_v4 (id,execution_intent_id,user_id,trading_account_id,action,status) VALUES (?,?,7,5,'position.close','succeeded')",[parentCommandId,parentIntentId])
   const target={userId:'7',accountId:'5',terminalInstanceId:'terminal-1',brokerServer:'Broker',login:'42',ticket:'101',positionIdentifier:'100',symbol:'XAUUSD',side:'buy'}
   const plan={workflowId,parentIntentId,parentCommandId,target,initialVolume:'0.10',closeVolume:'0.08',initialRevision:5,expiresAt:at+60000,protection:{stopLoss:'2450'}}
   const ready={state:'risk_review_required',workflowId,target,remainingVolume:'0.02',projectionRevision:6,projectionObservedAt:at-100,protection:plan.protection}
   await db.execute(`INSERT INTO partial_close_workflows_v4 (id,parent_intent_id,parent_command_id,user_id,trading_account_id,plan_json,plan_sha256,status,revision,expires_at_utc,created_at_utc,updated_at_utc)
    VALUES (?,?,?,7,5,?,?,'risk_review_required',2,?,?,?)`,[workflowId,parentIntentId,parentCommandId,JSON.stringify(plan),sha256Canonical(plan),new Date(plan.expiresAt).toISOString().replace('T',' ').replace('Z',''),new Date(at-1000).toISOString().replace('T',' ').replace('Z',''),new Date(at).toISOString().replace('T',' ').replace('Z','')])
   for(const [revision,type,payload] of [[1,'registered',{planHash:sha256Canonical(plan),parentIntentId,parentCommandId}],[2,'risk_review_required',{planHash:sha256Canonical(plan),assessment:ready}]])
    await db.execute('INSERT INTO partial_close_workflow_events_v4 VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',[workflowId,revision,type,JSON.stringify(payload),sha256Canonical(payload)])
   return {workflowId,userId:7,accountId:'5'}
  }
  const connectionPool={async getConnection(){
   const connection=await pool.getConnection();await connection.query(`USE ${name}`);await connection.query("SET SESSION time_zone='+00:00'")
   return new Proxy(connection,{get(target,key){
    if(key==='release')return ()=>target.destroy()
    if(key==='commit')return async()=>{await target.commit();if(fault==='commit'){fault=null;throw Error('injected_commit_ack_loss')}}
    if(key==='execute')return async(sql,params)=>{const result=await target.execute(sql,params);if(fault && sql.includes(fault) && /^\s*(INSERT|UPDATE)/.test(sql)){fault=null;throw Error('injected_statement_ack_loss')}return result}
    const value=target[key];return typeof value==='function'?value.bind(target):value
   }})
  }}
  const service=createMysqlPositionProtectionPreparation(connectionPool,async()=>connection=>({async review(request){
   reviewCalls++;const [[clock]]=await connection.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at')
   const actionId=`protection:${request.workflowId}:2`
   return {workflowId:request.workflowId,workflowRevision:2,requestHash:sha256Canonical(request),contextHash:'a'.repeat(64),
    evaluation:{status:rejected?'rejected':'approved',rejectCode:rejected?'RISK_GLOBAL_KILL_SWITCH':null,policyHash:'b'.repeat(64),evaluatedAt:new Date(Number(clock.at)).toISOString(),manualReleaseId:null,manualReleaseRevision:null,
     rules:[{code:rejected?'RISK_GLOBAL_KILL_SWITCH':'RISK_POSITION_PROTECTION_APPROVED',outcome:rejected?'rejected':'passed',actionId,details:{}}],
     approvedActions:rejected?[]:[{actionId,kind:'modify_position',parameters:{ticket:'101',stop_loss:'2450'},expectedState:{accountRevision:2,positionsRevision:6,quoteRevision:8,contractRevision:3,riskRevision:4}}]}}
  }}))
  const state=async scope=>{
   const [[workflow]]=await db.execute('SELECT status,revision FROM partial_close_workflows_v4 WHERE id=?',[scope.workflowId])
   const counts={}
   for(const [table,where] of [['operations','source_id'],['execution_intents','position_workflow_id'],['position_protection_reviews_v4','workflow_id'],['partial_close_workflow_events_v4','workflow_id'],['outbox_events','aggregate_id']]) {
    const [[row]]=await db.execute(`SELECT COUNT(*) n FROM ${table} WHERE ${where}=?`,[scope.workflowId]);counts[table]=Number(row.n)
   }
   return {status:workflow.status,revision:Number(workflow.revision),counts}
  }
  const scope=await seed(),before=await state(scope)
  for(const table of ['operations','operation_events','execution_intents','execution_intent_payloads','execution_intent_events','position_protection_reviews_v4','UPDATE partial_close_workflows_v4','partial_close_workflow_events_v4','outbox_events']) {
   phase='rollback-'+table;fault=table;await assert.rejects(()=>service.prepare(scope),/injected_statement_ack_loss/);assert.equal(fault,null);assert.deepEqual(await state(scope),before)
  }
  checks.push('nine-real-write-ack-faults-rollback-parent-workflow-child-audits-and-outbox')
  reviewCalls=0
  phase='concurrency';const results=await Promise.all([service.prepare(scope),service.prepare(scope),service.prepare(scope)])
  assert.equal(results.filter(r=>!r.replayed).length,1);assert.equal(reviewCalls,1);assert.equal(new Set(results.map(r=>r.childIntentId)).size,1)
  const progress=createMysqlPartialCloseWorkflowProgress(connectionPool,async()=>()=>({history:{async read(){throw Error('unexpected_history')}},projection:{async read(){throw Error('unexpected_projection')}}}),30000)
  const progressed=await progress.advance(scope);assert.equal(progressed.status,'protecting');assert.equal(progressed.replayed,true);assert.equal(reviewCalls,1)
  checks.push('old-progress-message-after-preparation-replays-proven-child-without-history-or-risk')
  const saved=await state(scope);assert.deepEqual(saved,{status:'protecting',revision:3,counts:{operations:1,execution_intents:1,position_protection_reviews_v4:1,partial_close_workflow_events_v4:3,outbox_events:1}})
  checks.push('concurrent-three-calls-one-review-one-child-one-outbox')
  const outage=Error('reference_redis_unavailable'),routesDown={async current(){throw outage}}
  const recovery=createMysqlPositionProtectionPreparation(connectionPool,createPositionProtectionReviewCapture(routesDown,{maxAgeMs:30000,maxInstrumentAgeMs:300000}))
  const recoveryProgress=createMysqlPartialCloseWorkflowProgress(connectionPool,createPartialCloseProgressCapture(routesDown,30000),30000)
  assert.equal((await recovery.prepare(scope)).replayed,true);assert.equal((await recoveryProgress.advance(scope)).status,'protecting')
  assert.deepEqual(await state(scope),saved);checks.push('Redis-outage-does-not-block-verified-preparation-and-progress-replay')
  const needsReview=await seed(),needsReviewBefore=await state(needsReview)
  await assert.rejects(()=>recovery.prepare(needsReview),error=>error===outage);assert.deepEqual(await state(needsReview),needsReviewBefore)
  checks.push('Redis-outage-preserves-original-error-and-writes-nothing-for-new-review')
  const due=await seed(-120000),dueBefore=await state(due)
  for(const table of ['UPDATE partial_close_workflows_v4','partial_close_workflow_events_v4','outbox_events']) {
   phase='expiry-rollback-'+table;fault=table
   await assert.rejects(()=>recovery.prepare(due),/injected_statement_ack_loss/);assert.deepEqual(await state(due),dueBefore)
  }
  const expired=await Promise.all([recovery.prepare(due),recovery.prepare(due)])
  assert.equal(expired.filter(r=>!r.replayed).length,1);assert.equal(expired[0].status,'expired');assert.equal(expired[0].childIntentId,null)
  const expiredState=await state(due)
  assert.deepEqual(expiredState,{status:'expired',revision:3,counts:{operations:0,execution_intents:0,position_protection_reviews_v4:0,partial_close_workflow_events_v4:3,outbox_events:1}})
  assert.equal((await recoveryProgress.advance(due)).status,'expired');assert.deepEqual(await state(due),expiredState)
  checks.push('offline-expiry-three-write-rollbacks-concurrent-once-no-review-or-child-and-progress-replay')
  const expiryUnknown=await seed(-120000);fault='commit'
  await assert.rejects(()=>recovery.prepare(expiryUnknown),/bridge_command_commit_unknown/)
  assert.equal((await recovery.prepare(expiryUnknown)).replayed,true);assert.deepEqual(await state(expiryUnknown),expiredState)
  checks.push('expiry-COMMIT-ack-loss-recovers-with-one-event-and-outbox')
  const uncertainDue=await seed(-120000),uncertainBefore=await state(uncertainDue)
  await db.execute("UPDATE bridge_commands_v4 SET status='uncertain' WHERE id=(SELECT parent_command_id FROM partial_close_workflows_v4 WHERE id=?)",[uncertainDue.workflowId])
  await assert.rejects(()=>recovery.prepare(uncertainDue),/parent_not_confirmed/);assert.deepEqual(await state(uncertainDue),uncertainBefore)
  checks.push('elapsed-deadline-does-not-abandon-uncertain-parent')


  const unknown=await seed();fault='commit';reviewCalls=0
  await assert.rejects(()=>service.prepare(unknown),/bridge_command_commit_unknown/)
  const recovered=await service.prepare(unknown);assert.equal(recovered.replayed,true);assert.equal(reviewCalls,1)
  assert.deepEqual(await state(unknown),saved);checks.push('committed-child-ack-loss-recovery-without-new-review-or-child')
  const denied=await seed();rejected=true
  const deniedResult=await service.prepare(denied);assert.equal(deniedResult.status,'stopped');assert.equal(deniedResult.childIntentId,null)
  assert.equal((await state(denied)).counts.execution_intents,0);rejected=false
  assert.equal((await service.prepare(denied)).replayed,true);assert.equal((await progress.advance(denied)).status,'stopped');checks.push('risk-rejection-durable-no-child-replay-does-not-reapprove')
  const pending=await seed();await db.execute("UPDATE bridge_commands_v4 SET status='uncertain' WHERE id=(SELECT parent_command_id FROM partial_close_workflows_v4 WHERE id=?)",[pending.workflowId])
  const pendingBefore=await state(pending);await assert.rejects(()=>service.prepare(pending),/parent_not_confirmed/);assert.deepEqual(await state(pending),pendingBefore)
  checks.push('parent-uncertainty-cannot-produce-child')
  const childId=results[0].childIntentId
  await assert.rejects(()=>db.execute("UPDATE execution_intents SET action_kind='market_order' WHERE id=?",[childId]),e=>e.code==='ER_CHECK_CONSTRAINT_VIOLATED')
  await assert.rejects(()=>db.execute("UPDATE execution_intents SET source_id='wrong' WHERE id=?",[childId]),e=>e.code==='ER_CHECK_CONSTRAINT_VIOLATED')
  await assert.rejects(()=>db.execute('UPDATE position_protection_reviews_v4 SET child_intent_id=? WHERE workflow_id=?',[childId,unknown.workflowId]),e=>['ER_DUP_ENTRY','ER_NO_REFERENCED_ROW_2'].includes(e.code))
  await db.beginTransaction()
  try {
   await db.execute('DELETE FROM position_protection_reviews_v4 WHERE workflow_id=?',[scope.workflowId])
   await assert.rejects(()=>db.execute('UPDATE position_protection_reviews_v4 SET child_intent_id=? WHERE workflow_id=?',[childId,unknown.workflowId]),e=>e.code==='ER_NO_REFERENCED_ROW_2')
  } finally {await db.rollback()}
  checks.push('actual-source-family-action-and-composite-review-child-FK-constraints')
  await db.beginTransaction()
  try {
   await db.execute('UPDATE execution_intents SET expires_at_utc=DATE_ADD(expires_at_utc,INTERVAL 1 SECOND) WHERE id=?',[childId])
   // Replay uses another connection; commit this isolated tamper for visibility.
   await db.commit()
   await assert.rejects(()=>service.prepare(scope),/child_corrupt/)
  } finally {
   await db.rollback()
   await db.execute('UPDATE execution_intents SET expires_at_utc=DATE_SUB(expires_at_utc,INTERVAL 1 SECOND) WHERE id=?',[childId])
  }
  checks.push('stored-child-expiry-cannot-be-extended-on-replay')
  await db.execute("UPDATE execution_intent_payloads SET action_json=JSON_SET(action_json,'$.parameters.stop_loss','1') WHERE execution_intent_id=?",[childId])
  await assert.rejects(()=>service.prepare(scope),/child_corrupt/);await assert.rejects(()=>progress.advance(scope),/child_corrupt/);checks.push('stored-child-payload-tampering-rejected-by-preparation-and-progress-replay')
  const worker=createPartialCloseWorkflowWorker(progress,service),workflowScope=await seed()
  const workerResults=await Promise.all([worker.run(workflowScope),worker.run(workflowScope)])
  assert.equal(workerResults[0].state,'protection_prepared');assert.equal(workerResults[1].childIntentId,workerResults[0].childIntentId)
  assert.equal((await state(workflowScope)).counts.execution_intents,1)
  const expiredWorkerScope=await seed(-120000)
  assert.equal((await createPartialCloseWorkflowWorker(recoveryProgress,recovery).run(expiredWorkerScope)).state,'expired')
  checks.push('actual-worker-progress-to-preparation-concurrent-replay-and-offline-expiry')
  // Keep older case fixtures outside this bounded scheduling test's due window.
  await db.query('UPDATE partial_close_workflows_v4 SET updated_at_utc=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR)')
  const scan=createMysqlPartialCloseWorkflowRecovery(connectionPool),firstDue=await seed(-2000),secondDue=await seed(-2000)
  const dueIds=[firstDue.workflowId,secondDue.workflowId]
  const scheduleState=async()=>JSON.stringify((await db.query(`SELECT id,status,revision,updated_at_utc FROM partial_close_workflows_v4 WHERE id IN (?,?) ORDER BY id`,dueIds))[0])
  const scheduleBefore=await scheduleState()
  for(const table of ['outbox_events','UPDATE partial_close_workflows_v4']) {
   fault=table;await assert.rejects(()=>scan.schedule(1),/injected_statement_ack_loss/);assert.equal(await scheduleState(),scheduleBefore)
   for(const candidate of [firstDue,secondDue])assert.equal((await state(candidate)).counts.outbox_events,0)
  }
  phase='scan-concurrency'
  const scheduled=await Promise.all([scan.schedule(1),scan.schedule(1)])
  const concurrentCount=scheduled.reduce((a,b)=>a+b,0)
  assert.ok(concurrentCount>=1 && concurrentCount<=2)
  // SKIP LOCKED can skip rows encountered under the other scanner's range locks; the next bounded pass picks them up.
  assert.equal(concurrentCount+await scan.schedule(500),2);assert.equal(await scan.schedule(500),0)
  for(const candidate of [firstDue,secondDue]) {
   const current=await state(candidate);assert.equal(current.revision,2);assert.equal(current.counts.partial_close_workflow_events_v4,2);assert.equal(current.counts.outbox_events,1)
  }
  checks.push('bounded-concurrent-recovery-atomic-cooldown-pending-dedup-without-business-revision-changes')
  const scanUnknown=await seed(-2000);fault='commit'
  await assert.rejects(()=>scan.schedule(1),/bridge_command_commit_unknown/);assert.equal(await scan.schedule(1),0)
  assert.equal((await state(scanUnknown)).counts.outbox_events,1)
  checks.push('recovery-COMMIT-ack-loss-does-not-duplicate-pending-delivery')

  const commandReviewEvidence=await verifyPositionProtectionCommandReview(connectionPool,workflowScope)
  const bindingEvidence=await verifyPositionProtectionBinding(connectionPool,workflowScope,async()=>{const scope=await seed();await service.prepare(scope);return scope})
  const queueEvidence=await verifyPartialCloseQueue(db,connectionPool,await seed(),worker,state)
  return {passed:true,checks,queueEvidence,commandReviewEvidence,bindingEvidence,migrationSha256:createHash('sha256').update(migration).digest('hex'),riskReview:'injected-port',parentEvidence:'query-scaffolds-and-seeded-confirmed-eligibility',existingDatabaseWrites:0,referenceDatabaseRemoved:true}
 } catch(error) {error.referenceStatement=phase+':'+(error.actual?.code ?? error.code ?? '')+':'+(error.actual?.message ?? error.message);throw error
 } finally {
  await db.rollback();if(original)await db.query(`USE ${original}`);if(created)await db.query(`DROP DATABASE ${name}`);db.release()
 }
}
