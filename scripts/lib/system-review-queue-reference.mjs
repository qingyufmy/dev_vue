import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Queue, QueueEvents, Worker } from 'bullmq'
import { SYSTEM_REVIEW_QUEUE } from '../../server/dist-v4/queue/task-queues.js'
import { createSystemReviewProcessor } from '../../server/dist-v4/queue/system-review-processor.js'
import { createMysqlSystemReviewTask, assertMysqlSystemReviewTaskSchemaReady } from '../../server/dist-v4/modules/reviews/composition.js'
import { createSystemReviewRecovery } from '../../server/dist-v4/bootstrap/system-review-recovery.js'
import { createSystemReviewTaskRunner } from '../../server/dist-v4/bootstrap/system-review-batch.js'

export async function verifySystemReviewQueue(admin, pool, scope) {
  const [[db]] = await admin.query('SELECT DATABASE() db')
  assert.match(db.db, /^dev_vue_history_ref_[a-f0-9]{32}$/)
  await admin.query(await readFile(new URL('../../server/db/migrations/inplace/075_system_review_tasks.sql',import.meta.url),'utf8'))
  await assertMysqlSystemReviewTaskSchemaReady(pool)
  // The actual page reader must exclude this manual trade and finish the empty system page.
  assert.equal((await createSystemReviewTaskRunner(pool).run(scope.taskId)).state, 'succeeded')
  await admin.execute('DELETE FROM system_review_tasks_v4 WHERE history_task_id=?',[scope.taskId])
  const failed = createMysqlSystemReviewTask(pool, () => ({ async run() { throw Error('injected_system_page_failure') } }))
  await assert.rejects(failed.run(scope.taskId), /injected_system_page_failure/)
  assert.equal(Number((await admin.query('SELECT COUNT(*) n FROM system_review_tasks_v4'))[0][0].n), 0)
  const cursor = '00000000-0000-4000-8000-000000000001'
  const runner = createMysqlSystemReviewTask(pool, () => ({ async run(_task, after) {
    return after === null ? { status:'processed', nextRecordId:cursor, results:[{recordId:scope.recordId,result:{status:'unresolved',reason:'source_pending'}}] }
      : {status:'processed',nextRecordId:null,results:[]}
  } }))
  assert.equal((await runner.run(scope.taskId)).state, 'pending')
  const [[advanced]] = await admin.query('SELECT after_record_id,unresolved_count FROM system_review_tasks_v4')
  assert.equal(advanced.after_record_id,cursor); assert.equal(Number(advanced.unresolved_count),1)
  assert.equal((await runner.run(scope.taskId)).state,'waiting')
  const [[cycle]] = await admin.query('SELECT after_record_id,unresolved_count,page_attempts FROM system_review_tasks_v4')
  assert.equal(cycle.after_record_id,null); assert.equal(Number(cycle.page_attempts),2)
  assert.equal((await runner.run(scope.taskId)).state,'waiting')
  await admin.execute('UPDATE system_review_tasks_v4 SET next_attempt_at_utc=UTC_TIMESTAMP(3) WHERE history_task_id=?',[scope.taskId])
  const options={connection:scope.connection,prefix:scope.prefix}
  const queue=new Queue(SYSTEM_REVIEW_QUEUE,options), events=new QueueEvents(SYSTEM_REVIEW_QUEUE,options)
  const worker=new Worker(SYSTEM_REVIEW_QUEUE,createSystemReviewProcessor(createSystemReviewTaskRunner(pool)),{...options,autorun:false,concurrency:1})
  // Other completed fixture tasks exercise unrelated histories; restrict this worker's reference route.
  const recovery=createSystemReviewRecovery(pool,{async add(name,data,options){
    if(data.taskId===scope.taskId)return queue.add(name,data,options)
  }}), failures=[]
  for(const client of [queue,events,worker])client.on('error',()=>failures.push('system_queue_error'))
  worker.on('failed',()=>failures.push('system_job_failed'))
  let running
  try {
    await Promise.all([queue.waitUntilReady(),events.waitUntilReady(),worker.waitUntilReady()])
    await recovery.tick(); await recovery.tick()
    assert.equal(await queue.getWaitingCount(),1)
    const job=await queue.getJob(`system-review-recovery-${scope.taskId}`)
    assert.ok(job)
    running=worker.run()
    assert.equal((await job.waitUntilFinished(events,20000)).state,'succeeded')
    const [[done]]=await admin.query('SELECT status,unresolved_count FROM system_review_tasks_v4')
    assert.equal(done.status,'succeeded'); assert.equal(Number(done.unresolved_count),0)
    assert.deepEqual(failures,[])
    return {passed:true,pageCases:'synthetic-unresolved-then-actual-empty-system-page',checks:[
      'manual-trade-excluded-from-system-scan','page-failure-rolls-back-task','unresolved-page-advances-cursor',
      'cycle-retains-unresolved-and-db-retry','duplicate-recovery-one-job','real-worker-resets-cycle-and-completes']}
  } finally {
    await recovery.stop(); await worker.close(true); if(running)await running
    await events.close(); await queue.obliterate({force:true}); await queue.close()
  }
}
