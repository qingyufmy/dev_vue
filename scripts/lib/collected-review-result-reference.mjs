import Fastify from 'fastify'
import { createReviewHttp } from '../../server/dist-v4/modules/reviews/composition.js'
import { ReviewService } from '../../server/dist-v4/modules/reviews/index.js'
import assert from 'node:assert/strict'
import { Queue, QueueEvents, Worker } from 'bullmq'
import { createMysqlReviewWorker } from '../../server/dist-v4/modules/reviews/composition.js'
import { MysqlReviewRepository } from '../../server/dist-v4/modules/reviews/infrastructure/mysql-review-repository.js'
import { BullMqOutboxTaskPublisher } from '../../server/dist-v4/outbox/infrastructure/bullmq-outbox-task-publisher.js'
import { REVIEW_QUEUE } from '../../server/dist-v4/queue/task-queues.js'

/** Synthetic provider boundary; real collected case, queue, worker, transactions and read repository. */
export async function verifyCollectedReviewResult(admin, pool, scope, event, kind = 'manual') {
  if (kind === 'manual') {
  await admin.query('ALTER TABLE strategy_versions ADD prompt_text TEXT')
  await admin.query("UPDATE strategy_versions SET prompt_text='Reference strategy' WHERE id=1")
  await admin.query('INSERT INTO ai_model_profiles VALUES (1)')
  }
  const repo = new MysqlReviewRepository(pool)
  const tradeFrom = evidence => kind === 'manual' ? evidence.frozen_candidates[0].evidence.trade : kind === 'system' ? evidence.trade : evidence.trades[0].evidence.trade
  let calls = 0
  const processor = createMysqlReviewWorker(pool, { async resolve(claim) {
    assert.equal(claim.caseId, event.payload.review_case_id)
    assert.equal(tradeFrom(claim.evidence).taskId, scope.taskId)
    return { profileId: '1', provider: 'reference', model: 'synthetic', timeoutMs: 1000, maxAttempts: 1,
      async invoke(messages) {
        calls++
        const input = JSON.parse(messages.at(-1).content)
        assert.equal(tradeFrom(input.evidence).evidence.projection.netProfit, '10')
        const refs = input.allowed_evidence_refs
        assert.equal(refs.length, kind === 'system' ? 5 : 1)
        const role = { assessment: 'insufficient_evidence', summary: '人工交易未提供此角色证据', evidence_refs: refs }
        return { usage: null, value: { schema_version: 'review.v4.1', conclusion: kind === 'manual' ? 'manual_trade_reviewed' : 'insufficient_evidence',
          headline: '参考人工交易复盘', summary: '基于冻结成交证据生成，非真实模型结论。',
          metrics: { net_profit: '10', trade_count: 1, win_rate_percent: '100', profit_factor: null },
          trade_episodes: [], roles: { analyst: role, trader: role, risk: role, execution: role },
          counterexamples: [], memory_candidates: [], evidence_refs: refs, full_analysis_text: 'Reference frozen evidence result' } }
      } }
  } }, 'collected-review-reference')
  const options = { connection: scope.connection, prefix: scope.prefix }
  const queue = new Queue(REVIEW_QUEUE, options), events = new QueueEvents(REVIEW_QUEUE, options)
  const worker = new Worker(REVIEW_QUEUE, job => processor.process(job.data.reviewJobId), { ...options, concurrency: 2, autorun: false })
  const failures = []
  for (const client of [queue, events, worker]) client.on('error', () => failures.push('review_queue_error'))
  let running
  try {
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady(), worker.waitUntilReady()])
    const publisher = new BullMqOutboxTaskPublisher({ review: queue })
    await publisher.publish(event); await publisher.publish(event)
    assert.equal(await queue.getPrioritizedCount(), 1)
    running = worker.run()
    const job = await queue.getJob(event.eventId)
    const result = await job.waitUntilFinished(events, 20000)
    assert.equal(result.status, 'succeeded', JSON.stringify(result))
    const detail = await repo.getCase(scope.userId, event.payload.review_case_id)
    assert.equal(detail.summary.status, 'awaiting_confirmation')
    assert.equal(detail.currentJob.status, 'succeeded')
    assert.equal(detail.currentVersion.content.metrics.netProfit, '10')
    assert.equal(detail.currentVersion.content.fullAnalysisText, 'Reference frozen evidence result')
    assert.equal(await repo.getCase(scope.userId + 1000, event.payload.review_case_id), null)
    let actingUser=scope.userId
    const app=Fastify()
    try {
      await app.register(createReviewHttp(new ReviewService(repo), {
        async authenticate(){return {userId:actingUser}}, async assertWrite(){throw Error('reference_read_only')},
      }))
      const response=await app.inject({method:'GET',url:`/api/v4/review-cases/${event.payload.review_case_id}`})
      assert.equal(response.statusCode,200,response.body)
      assert.equal(response.json().data.current_version.content.metrics.net_profit,'10')
      assert.equal(response.json().data.current_job.status,'succeeded')
      assert.equal(response.headers['cache-control'],'no-store')
      actingUser=scope.userId+1000
      assert.equal((await app.inject({method:'GET',url:`/api/v4/review-cases/${event.payload.review_case_id}`})).statusCode,404)
    } finally {await app.close()}

    await job.remove()
    await publisher.publish(event)
    const replay = await queue.getJob(event.eventId)
    assert.equal((await replay.waitUntilFinished(events, 20000)).status, 'ignored')
    assert.equal(calls, 1)
    const [[counts]] = await admin.execute('SELECT (SELECT COUNT(*) FROM review_versions_v4 WHERE review_case_id=?) versions,(SELECT COUNT(*) FROM review_model_attempts_v4 a JOIN review_jobs_v4 j ON j.id=a.review_job_id WHERE j.review_case_id=?) attempts,(SELECT COUNT(*) FROM strategy_memory_pending_updates_v4) memory_updates',[event.payload.review_case_id,event.payload.review_case_id])
    assert.deepEqual([Number(counts.versions), Number(counts.attempts), Number(counts.memory_updates)], [1, 1, 0])
    assert.deepEqual(failures, [])
    return { passed: true, provider: 'synthetic-no-network-call', checks: ['collected-evidence-reaches-model-input', 'outbox-to-worker-to-version-to-detail', 'actual-http-contract-returns-result-and-rejects-foreign-user', 'redelivery-does-not-call-model-or-create-version', 'unconfirmed-result-does-not-write-memory'] }
  } finally {
    await worker.close(true)
    if (running) await running
    await events.close(); await queue.obliterate({ force: true }); await queue.close()
  }
}
