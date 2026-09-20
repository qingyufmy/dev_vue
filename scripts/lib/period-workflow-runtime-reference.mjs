import { verifyNonemptySystemReview } from './system-review-nonempty-reference.mjs'
import { MysqlOutboxRepository } from '../../server/dist-v4/outbox/infrastructure/mysql-outbox-repository.js'
import { verifyCollectedReviewResult } from './collected-review-result-reference.mjs'
import { randomUUID } from 'node:crypto'
import { createMysqlHistoryTaskWorker } from '../../server/dist-v4/modules/trade-history/composition.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Queue, QueueEvents, Worker } from 'bullmq'
import { appendClockObservation } from '../../server/dist-v4/modules/trading/infrastructure/mysql-clock-observation-writer.js'
import { createPeriodReviewDiscovery } from '../../server/dist-v4/bootstrap/period-review-discovery.js'
import { createPeriodReviewTaskRunner } from '../../server/dist-v4/bootstrap/period-review-workflow.js'
import { createPeriodReviewRecovery } from '../../server/dist-v4/bootstrap/period-review-recovery.js'
import { createPeriodReviewProcessor } from '../../server/dist-v4/queue/period-review-processor.js'
import { PERIOD_REVIEW_QUEUE } from '../../server/dist-v4/queue/task-queues.js'

export async function verifyPeriodWorkflowRuntime(admin,pool,scope) {
  const [[identity]]=await admin.query('SELECT DATABASE() db');assert.match(identity.db,/^dev_vue_history_ref_[a-f0-9]{32}$/)
  await admin.execute('INSERT INTO terminal_profiles VALUES (?) ON DUPLICATE KEY UPDATE id=id',[scope.route.terminalProfileId])
  for(const name of ['076_terminal_clock_observations','077_period_review_workflows'])
    await admin.query(await readFile(new URL(`../../server/db/migrations/inplace/${name}.sql`,import.meta.url),'utf8'))
  const [[own]]=await admin.query('SELECT interval_id FROM trading_account_ownerships WHERE trading_account_id=5 AND user_id=7')
  const key=new Date(Date.now()-86400000).toISOString().slice(0,10)
  const begin=Date.parse(`${key}T00:00:00Z`)-180*60000,end=begin+86400000
  const [deals]=await admin.execute(`SELECT d.evidence_json FROM account_trade_record_deals_v4 x
    JOIN terminal_history_deals_v4 d ON d.id=x.terminal_deal_id WHERE x.trade_record_id=? ORDER BY x.sequence_number`,[scope.recordId])
  const terminalDeals=deals.map(row=>typeof row.evidence_json==='string'?JSON.parse(row.evidence_json):row.evidence_json)
  assert.equal(terminalDeals.length,2)
  for(const [index,deal] of terminalDeals.entries()) Object.assign(deal,{
    ticket:String(70001+index),order:String(71001+index),position_id:'70000',time_msc:begin+3600000+index*1000,
  })
  let revision=100
  for(const observed of [begin-1000,begin+1000,end-1000,end+1000]) {
    revision++
    await appendClockObservation(admin,{route:scope.route,projection:{resource:'account.metrics',resourceId:'current',accountId:scope.route.accountId,revision,
      data:{id:scope.route.accountId,revision,observedAt:new Date(observed).toISOString(),timezoneOffsetMinutes:180,clockStatus:'calibrated'}}},
    {intervalId:own.interval_id,ownershipRevision:scope.route.ownershipRevision},{timezoneOffsetMinutes:180,clockStatus:'calibrated'})
  }
  const discovery=createPeriodReviewDiscovery(pool)
  await discovery.tick()
  const [[target]]=await admin.execute("SELECT id FROM period_review_workflows_v4 WHERE period_kind='daily' AND period_key=?",[key])
  assert.ok(target)
  const [[count]]=await admin.query('SELECT COUNT(*) n FROM period_review_workflows_v4')
  const restarted=createPeriodReviewDiscovery(pool);await restarted.tick();await restarted.stop()
  assert.equal((await admin.query('SELECT COUNT(*) n FROM period_review_workflows_v4'))[0][0].n,count.n)
  const options={connection:scope.connection,prefix:scope.prefix}
  const queue=new Queue(PERIOD_REVIEW_QUEUE,options),events=new QueueEvents(PERIOD_REVIEW_QUEUE,options)
  const worker=new Worker(PERIOD_REVIEW_QUEUE,createPeriodReviewProcessor(createPeriodReviewTaskRunner(pool)),{...options,concurrency:1,autorun:false})
  const recovery=createPeriodReviewRecovery(pool,{async add(name,data,opts){if(data.workflowId===target.id)return queue.add(name,data,opts)}})
  const errors=[];for(const client of [queue,events,worker])client.on('error',()=>errors.push('period_queue_error'))
  let running
  try {
    await Promise.all([queue.waitUntilReady(),events.waitUntilReady(),worker.waitUntilReady()])
    await recovery.tick();await recovery.tick();assert.equal(await queue.getWaitingCount(),1)
    let job=await queue.getJob(`period-review-${target.id}`);assert.ok(job)
    running=worker.run()
    assert.equal((await job.waitUntilFinished(events,20000)).phase,'history')
    const [[saved]]=await admin.execute('SELECT progress_json FROM period_review_workflows_v4 WHERE id=?',[target.id])
    const progress=typeof saved.progress_json==='string'?JSON.parse(saved.progress_json):saved.progress_json
    assert.equal(progress.plan.period.start.utcMsc,begin);assert.equal(progress.plan.period.end.utcMsc,end)
    assert.equal(progress.plan.historyStartUtcMsc,Date.parse('2020-01-01T00:00:00.000Z'))
    await recovery.tick();job=await queue.getJob(`period-review-${target.id}`);assert.ok(job)
    assert.equal((await job.waitUntilFinished(events,20000)).phase,'history')
    const [[requested]]=await admin.execute('SELECT status,range_start_utc,range_end_utc FROM history_collection_tasks_v4 WHERE id=?',[progress.historyTaskId])
    assert.ok(requested);assert.equal(requested.status,'pending')
    const [[outbox]]=await admin.execute("SELECT COUNT(*) n FROM outbox_events WHERE aggregate_id=? AND event_type='trade.history.task.requested'",[progress.historyTaskId])
    assert.equal(Number(outbox.n),1)
    assert.equal((await admin.execute('SELECT last_reason FROM period_review_workflows_v4 WHERE id=?',[target.id]))[0][0].last_reason,'history_collection_pending')
    await recovery.tick();assert.equal(await queue.getWaitingCount(),0)
    let providerCalls=0
    const historyWorker=createMysqlHistoryTaskWorker(pool,{async query(input){
      providerCalls++;assert.equal(input.rangeStartUtcMsc,progress.plan.historyStartUtcMsc)
      assert.equal(input.rangeEndUtcMsc,progress.plan.asOfUtcMsc);assert.equal(input.cursor,null)
      // The VM clock can lead the local collector by a few seconds. Never forge a future response.
      const wait=progress.plan.asOfUtcMsc+100-Date.now()
      assert.ok(wait<30000,'reference_clock_skew_exceeds_bound')
      if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait))
      const observed=Date.now()-1
      return {v:4,type:'query.response',message_id:randomUUID(),correlation_id:randomUUID(),sent_at_utc_msc:observed,
        route:{terminal_instance_id:scope.route.terminalInstanceId,account_ref:{broker_server:scope.route.brokerServer,login:scope.route.login},connection_epoch:scope.route.connectionEpoch},
        payload:{request_id:randomUUID(),resource:input.resource,source:'terminal',source_revision:'period-nonempty-v1',observed_at_utc_msc:observed,
          history_coverage:{version:1,status:'complete',range_start_utc_msc:input.rangeStartUtcMsc,range_end_utc_msc:input.rangeEndUtcMsc,source_revision:'period-nonempty-v1',collected_at_utc_msc:observed},
          items:input.resource==='history.deals'?terminalDeals:[],has_more:false,next_cursor:null}}
    }},{async current(accountId){assert.equal(accountId,scope.route.accountId);return scope.route}},()=>({async assert(route){assert.deepEqual(route,scope.route)}}))
    assert.equal((await historyWorker.run(progress.historyTaskId)).state,'succeeded')
    assert.equal(providerCalls,2)
    const [[collectedRecord]]=await admin.query("SELECT id FROM account_trade_records_v4 WHERE stable_trade_key='mt5:position:70000'")
    assert.ok(collectedRecord)
    const periodScope={...scope,recordId:collectedRecord.id,taskId:progress.historyTaskId}
    const sourceReview=await verifyNonemptySystemReview(admin,pool,periodScope,progress.plan.asOfUtcMsc)
    const [[beforeCases]]=await admin.query('SELECT COUNT(*) n FROM review_cases_v4')
    // Test clock injection: the earlier check already proved that an unexpired retry is not queued.
    await admin.execute('UPDATE period_review_workflows_v4 SET next_attempt_at_utc=UTC_TIMESTAMP(3) WHERE id=?',[target.id])
    await recovery.tick();job=await queue.getJob(`period-review-${target.id}`);assert.ok(job)
    assert.equal((await job.waitUntilFinished(events,20000)).phase,'succeeded')
    const [[done]]=await admin.execute('SELECT progress_json FROM period_review_workflows_v4 WHERE id=?',[target.id])
    const finished=typeof done.progress_json==='string'?JSON.parse(done.progress_json):done.progress_json
    assert.equal(finished.empty,false);assert.equal(finished.caseIds.length,1)
    assert.equal(Number((await admin.query('SELECT COUNT(*) n FROM review_cases_v4'))[0][0].n),Number(beforeCases.n)+1)
    const outboxRepository=new MysqlOutboxRepository(pool),deadline=Date.now()+15000
    let reviewEvent
    while(!reviewEvent&&Date.now()<deadline){
      reviewEvent=(await outboxRepository.claim('automatic-period-reference',100,30,new Date())).find(e=>e.eventType==='review.job.requested'&&e.payload.review_case_id===finished.caseIds[0])
      if(!reviewEvent)await new Promise(resolve=>setTimeout(resolve,250))
    }
    assert.ok(reviewEvent)
    const model=await verifyCollectedReviewResult(admin,pool,periodScope,reviewEvent,'daily')
    await recovery.tick();assert.equal(await queue.getWaitingCount(),0)
    assert.equal((await historyWorker.run(progress.historyTaskId)).state,'terminal');assert.equal(providerCalls,2)
    assert.deepEqual(errors,[])
    return {passed:true,sourceReview,model,checks:['actual-owned-account-discovery','restart-unique-scope-replay','duplicate-recovery-one-job',
      'actual-worker-freezes-historical-boundaries','actual-owner-interval-lifecycle-window','actual-history-task-and-outbox-request','database-retry-suppresses-early-wake','actual-provider-pages-complete-history-task','actual-nonempty-inventory-creates-period-case-job-outbox','automatic-period-result-through-worker-and-http','completed-history-and-period-replay-no-effects'],
      scope:'Real SQL authorization/discovery/planning/request/history receipt/inventory/completion and Redis Worker. Clock, terminal query payloads and model are synthetic; source single-trade case was produced by the system collector with synthetic execution lineage. Daily case/job/evidence are created by the actual workflow, not seeded. Retry due time advanced in fixture.'}
  } finally {
    await discovery.stop();await recovery.stop();await worker.close(true);if(running)await running
    await events.close();await queue.obliterate({force:true});await queue.close()
  }
}
