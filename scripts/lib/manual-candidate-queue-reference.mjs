import assert from 'node:assert/strict'
import { Queue, QueueEvents, Worker } from 'bullmq'
import { MANUAL_CANDIDATE_QUEUE } from '../../server/dist-v4/queue/task-queues.js'
import { createManualCandidateProcessor } from '../../server/dist-v4/queue/manual-candidate-processor.js'
import { createManualCandidateTaskRunner } from '../../server/dist-v4/bootstrap/manual-candidate-batch.js'
import { createManualCandidateRecovery } from '../../server/dist-v4/bootstrap/manual-candidate-recovery.js'
import { MysqlOutboxRepository } from '../../server/dist-v4/outbox/infrastructure/mysql-outbox-repository.js'
import { BullMqOutboxTaskPublisher } from '../../server/dist-v4/outbox/infrastructure/bullmq-outbox-task-publisher.js'

export async function verifyManualCandidateQueue(admin, pool, scope) {
  const options = { connection: scope.connection, prefix: scope.prefix }
  const queue = new Queue(MANUAL_CANDIDATE_QUEUE, options)
  const events = new QueueEvents(MANUAL_CANDIDATE_QUEUE, options)
  const worker = new Worker(MANUAL_CANDIDATE_QUEUE, createManualCandidateProcessor(createManualCandidateTaskRunner(pool)),
    { ...options, autorun: false, concurrency: 2 })
  const failures = []
  for (const client of [queue, events, worker]) client.on('error', () => failures.push('candidate_queue_error'))
  worker.on('failed', () => failures.push('candidate_job_failed'))
  const recovery = createManualCandidateRecovery(pool, queue)
  let running
  try {
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady(), worker.waitUntilReady()])
    const outbox = new MysqlOutboxRepository(pool)
    let event
    const deadline = Date.now() + 15000
    while (!event && Date.now() < deadline) {
      const claimed = await outbox.claim('candidate-reference', 100, 30, new Date())
      event = claimed.find(e => e.eventType === 'trade.history.task.completed' && e.payload.task_id === scope.taskId)
      if (!event) await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(event, 'completion event must become claimable through dispatcher polling')
    const publisher = new BullMqOutboxTaskPublisher({ manualCandidates: queue })
    await publisher.publish(event); await publisher.publish(event)
    assert.equal(await queue.getWaitingCount(), 1)
    running = worker.run()
    const job = await queue.getJob(event.eventId)
    assert.equal((await job.waitUntilFinished(events, 20000)).state, 'succeeded')
    assert.equal(await outbox.markDispatched(event.id, 'candidate-reference', new Date()), true)
    // Simulate a missing durable scan task after an already acknowledged completion.
    // Candidates remain intact: discovery must recover without generating duplicates.
    await admin.execute('DELETE FROM manual_candidate_tasks_v4 WHERE history_task_id=?', [scope.taskId])
    await recovery.tick()
    const recovered = await queue.getJob(`manual-candidate-recovery-${scope.taskId}`)
    // Auto removal can win the read; the durable task is the authoritative completion.
    if (recovered) await recovered.waitUntilFinished(events, 20000)
    const [[task]] = await admin.execute('SELECT status FROM manual_candidate_tasks_v4 WHERE history_task_id=?', [scope.taskId])
    assert.equal(task.status, 'succeeded')
    assert.deepEqual(failures, [])
    return { passed: true, checks: ['completion-outbox-claimed', 'duplicate-publish-one-job', 'real-worker-advances-durable-task', 'missing-task-recovered-after-event-ack'] }
  } finally {
    await recovery.stop()
    await worker.close(true)
    if (running) await running
    await events.close()
    await queue.obliterate({ force: true })
    await queue.close()
  }
}
