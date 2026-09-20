import { verifyPeriodWorkflowRuntime } from './period-workflow-runtime-reference.mjs'
import { verifyExecutedDealOrigin } from './executed-deal-origin-reference.mjs'
import { verifySystemTradeAttribution } from './system-trade-attribution-reference.mjs'
import { verifySystemReviewQueue } from './system-review-queue-reference.mjs'
import { verifyNonemptySystemReview } from './system-review-nonempty-reference.mjs'
import { verifyPeriodReviewWriter } from './period-review-writer-reference.mjs'
import { verifyCollectedReviewResult } from './collected-review-result-reference.mjs'
import { MysqlOutboxRepository } from '../../server/dist-v4/outbox/infrastructure/mysql-outbox-repository.js'
import { verifyManualCandidateQueue } from './manual-candidate-queue-reference.mjs'
import { createMysqlManualCandidateTask } from '../../server/dist-v4/modules/reviews/composition.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { createManualCandidateBatch, createManualCandidateTaskRunner, createTransactionManualCandidatePageProcessor } from '../../server/dist-v4/bootstrap/manual-candidate-batch.js'
import { createTransactionManualCandidateSourceVerifier } from '../../server/dist-v4/bootstrap/manual-candidate-source-verifier.js'
import { ReviewService } from '../../server/dist-v4/modules/reviews/index.js'
import { MysqlReviewRepository } from '../../server/dist-v4/modules/reviews/infrastructure/mysql-review-repository.js'

/** Actual collected history and review repositories; terminal input and prerequisite domains are reference fixtures. */
export async function verifyCollectedManualCase(admin, pool, scope) {
  const [[identity]]=await admin.query('SELECT DATABASE() db')
  assert.match(identity.db,/^dev_vue_history_ref_[a-f0-9]{32}$/)
  await admin.query('ALTER TABLE trading_accounts ADD account_login VARCHAR(64), ADD broker_server VARCHAR(128)')
  await admin.execute('UPDATE trading_accounts SET account_login=?,broker_server=? WHERE id=?',[scope.route.login,scope.route.brokerServer,scope.route.accountId])
  for(const sql of [
    'CREATE TABLE strategies (id BIGINT UNSIGNED PRIMARY KEY,kind VARCHAR(20),name VARCHAR(50),owner_user_id INT,scope VARCHAR(20),status VARCHAR(20),active_version_id BIGINT UNSIGNED,deleted_at_utc DATETIME(3)) ENGINE=InnoDB',
    'CREATE TABLE strategy_versions (id BIGINT UNSIGNED PRIMARY KEY,strategy_id BIGINT UNSIGNED NOT NULL,UNIQUE KEY pair(id,strategy_id)) ENGINE=InnoDB',
    'CREATE TABLE strategy_subscriptions (id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB',
    'CREATE TABLE ai_model_profiles (id INT PRIMARY KEY) ENGINE=InnoDB',
  ])await admin.query(sql)
  for(const file of ['20260904_012_review_memory_core.sql','inplace/049_review_write_receipts.sql']) {
    const text=await readFile(new URL('../../server/db/migrations/'+file,import.meta.url),'utf8')
    for(const statement of splitSqlStatements(text))await admin.query(statement)
  }
  await admin.execute("INSERT INTO strategies VALUES (1,'analysis','reference',?,'private','active',1,NULL)",[scope.userId])
  await admin.query('INSERT INTO strategy_versions VALUES (1,1)')
  await admin.query(await readFile(new URL('../../server/db/migrations/inplace/074_manual_candidate_tasks.sql',import.meta.url),'utf8'))
  const faultRunner=createMysqlManualCandidateTask(pool,c=>({async run(taskId,cursor){
    await createTransactionManualCandidatePageProcessor(c).run(taskId,cursor)
    throw Error('injected_candidate_page_failure')
  }}))
  await assert.rejects(faultRunner.run(scope.taskId),/injected_candidate_page_failure/)
  const [[rolledBack]]=await admin.query('SELECT (SELECT COUNT(*) FROM manual_candidate_tasks_v4) tasks,(SELECT COUNT(*) FROM manual_review_candidates_v4) candidates')
  assert.deepEqual([Number(rolledBack.tasks),Number(rolledBack.candidates)],[0,0])
  const runner=createManualCandidateTaskRunner(pool)
  await admin.execute('UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3) WHERE user_id=? AND trading_account_id=?',[scope.userId,scope.route.accountId])
  const ackPool={async getConnection(){const c=await pool.getConnection();return new Proxy(c,{get(target,key){
    if(key==='commit')return async()=>{await target.commit();throw Error('injected_candidate_commit_ack_loss')}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})}}
  const ackRunner=createMysqlManualCandidateTask(ackPool,createTransactionManualCandidatePageProcessor)
  await assert.rejects(ackRunner.run(scope.taskId),{code:'review_commit_unknown'})

  const [[waiting]]=await admin.execute('SELECT status,after_record_id,page_attempts FROM manual_candidate_tasks_v4 WHERE history_task_id=?',[scope.taskId])
  assert.equal(waiting.after_record_id,null)
  assert.equal(Number(waiting.page_attempts),1)
  assert.equal((await runner.run(scope.taskId)).state,'waiting')
  await admin.execute('UPDATE trading_account_ownerships SET revoked_at_utc=NULL WHERE user_id=? AND trading_account_id=?',[scope.userId,scope.route.accountId])
  await admin.execute('UPDATE manual_candidate_tasks_v4 SET next_attempt_at_utc=UTC_TIMESTAMP(3) WHERE history_task_id=?',[scope.taskId])
  const queueRuntime=await verifyManualCandidateQueue(admin,pool,scope)
  const [[completedTask]]=await admin.execute('SELECT last_results_json,page_attempts FROM manual_candidate_tasks_v4 WHERE history_task_id=?',[scope.taskId])
  assert.equal(Number(completedTask.page_attempts),1)
  const batch=createManualCandidateBatch(pool)
  const processed=typeof completedTask.last_results_json==='string'?JSON.parse(completedTask.last_results_json):completedTask.last_results_json
  assert.equal(processed.status,'processed');assert.equal(processed.nextRecordId,null)
  assert.equal(processed.results.length,1)
  assert.equal(processed.results[0].recordId,scope.recordId)
  const candidate=processed.results[0].result
  assert.equal(candidate.status,'unchanged')
  const replayBatch=await batch.run(scope.taskId)
  assert.equal(replayBatch.results[0].result.status,'unchanged')
  const [[row]]=await admin.execute('SELECT id,revision,evidence_sha256 FROM manual_review_candidates_v4 WHERE id=?',[candidate.candidateId])
  const input={candidateIds:[row.id],selectionTokens:[`${row.id}.${row.revision}.${row.evidence_sha256}`],
    strategyId:'1',idempotencyKey:'collected-manual-reference',userThesis:'Reference collected trade'}
  const service=new ReviewService(new MysqlReviewRepository(pool,createTransactionManualCandidateSourceVerifier))
  await admin.execute('UPDATE account_trade_records_v4 SET revision=revision+1 WHERE id=?',[scope.recordId])
  try {
    await assert.rejects(service.createManualCase(scope.userId,input),{code:'manual_review_source_changed'})
    const [[counts]]=await admin.query('SELECT (SELECT COUNT(*) FROM review_cases_v4) cases,(SELECT COUNT(*) FROM review_jobs_v4) jobs,(SELECT COUNT(*) FROM review_write_receipts_v4) receipts')
    assert.deepEqual([Number(counts.cases),Number(counts.jobs),Number(counts.receipts)],[0,0,0])
  }finally{await admin.execute('UPDATE account_trade_records_v4 SET revision=revision-1 WHERE id=?',[scope.recordId])}
  const [first,second]=await Promise.all([service.createManualCase(scope.userId,input),service.createManualCase(scope.userId,input)])
  assert.deepEqual(first,second)
  const [[payload]]=await admin.execute('SELECT evidence_json FROM review_evidence_payloads_v4 WHERE review_case_id=?',[first.summary.id])
  const evidence=typeof payload.evidence_json==='string'?JSON.parse(payload.evidence_json):payload.evidence_json
  assert.equal(evidence.schema_version,'review-evidence.v4.2')
  assert.equal(evidence.frozen_candidates.length,1)
  const frozen=evidence.frozen_candidates[0].evidence
  assert.equal(frozen.trade.taskId,scope.taskId)
  assert.equal(frozen.trade.evidence.recordId,scope.recordId)
  assert.equal(frozen.trade.evidence.facts.length,2)
  assert.equal(frozen.trade.evidence.projection.netProfit,'10')
  assert.equal(frozen.authority.ownership.userId,scope.userId)
  const [[counts]]=await admin.query(`SELECT (SELECT COUNT(*) FROM review_cases_v4) cases,
    (SELECT COUNT(*) FROM review_jobs_v4) jobs,(SELECT COUNT(*) FROM review_write_receipts_v4) receipts,
    (SELECT COUNT(*) FROM outbox_events WHERE event_type IN ('review.job.requested','review.case.changed')) events`)
  assert.deepEqual([Number(counts.cases),Number(counts.jobs),Number(counts.receipts),Number(counts.events)],[1,1,1,2])
  assert.deepEqual(await service.createManualCase(scope.userId,input),first)
  await assert.rejects(service.createManualCase(scope.userId,{...input,idempotencyKey:'collected-manual-duplicate'}),{code:'manual_review_candidate_not_eligible'})
  let modelEvent
  const modelDeadline=Date.now()+15000
  const modelOutbox=new MysqlOutboxRepository(pool)
  while(!modelEvent && Date.now()<modelDeadline){
    const modelEvents=await modelOutbox.claim('manual-case-model-outbox',100,30,new Date())
    modelEvent=modelEvents.find(event=>event.eventType==='review.job.requested' && event.payload.review_case_id===first.summary.id)
    if(!modelEvent)await new Promise(resolve=>setTimeout(resolve,250))
  }
  assert.ok(modelEvent)
  const generatedResult=await verifyCollectedReviewResult(admin,pool,scope,modelEvent)
  const executedDealOrigin=await verifyExecutedDealOrigin(pool)
  const systemTradeAttribution=await verifySystemTradeAttribution(pool,scope,frozen.trade.asOfUtcMsc)
  const consumedBatch=await batch.run(scope.taskId)
  assert.equal(consumedBatch.results[0].result.status,'already_reviewed')
  const systemReviewQueue=await verifySystemReviewQueue(admin,pool,scope)
  const nonemptySystemReview=await verifyNonemptySystemReview(admin,pool,scope,frozen.trade.asOfUtcMsc)
  const periodReviews=await verifyPeriodReviewWriter(admin,pool,scope)
  const periodWorkflow=await verifyPeriodWorkflowRuntime(admin,pool,scope)
  return {passed:true,queueRuntime,generatedResult,executedDealOrigin,systemTradeAttribution,systemReviewQueue,nonemptySystemReview,periodReviews,periodWorkflow,sourceVerifier:'actual-transaction-adapter',terminalTransport:'synthetic-query',
    prerequisiteDomains:'scaffold',checks:['candidate-page-and-task-cursor-rollback-together','waiting-page-keeps-cursor-and-database-retry-time','actual-commit-ack-loss-recovers-durable-waiting-state','queue-worker-and-recovery-finish-durable-task','bounded-batch-discovers-and-replays-collected-candidate','collected-candidate-committed-before-case','changed-record-revision-no-case-job-receipt',
      'concurrent-case-one-job-one-receipt-two-outbox','case-model-job-is-claimable-by-runtime-outbox','case-freezes-collected-facts-and-actual-ownership','replay-and-duplicate-consumption-protection']}
}
