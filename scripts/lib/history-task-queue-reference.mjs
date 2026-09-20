import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Queue, QueueEvents, Worker } from 'bullmq'
import Redis from 'ioredis'
import { verifyQueuedCollection } from './history-task-queued-collection-reference.mjs'
import { developmentRedisConnection } from './development-redis.mjs'
import { createMysqlHistoryTaskWorker } from '../../server/dist-v4/modules/trade-history/composition.js'
import { MysqlHistoryCollectionTasks } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-collection-tasks.js'
import { MysqlOutboxRepository } from '../../server/dist-v4/outbox/infrastructure/mysql-outbox-repository.js'
import { BullMqOutboxTaskPublisher } from '../../server/dist-v4/outbox/infrastructure/bullmq-outbox-task-publisher.js'
import { createBridgeHistoryTaskProcessor } from '../../server/dist-v4/queue/bridge-history-task-processor.js'
import { BRIDGE_HISTORY_TASK_QUEUE } from '../../server/dist-v4/queue/task-queues.js'

export async function verifyHistoryTaskQueueReference(admin, pool, route, inject, observe, snapshots) {
  const [[identity]] = await admin.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_history_ref_[a-f0-9]{32}$/)
  const connection = { ...await developmentRedisConnection(), maxRetriesPerRequest: null }
  assert.equal(connection.host, '192.168.1.254')
  const prefix = 'history-reference-' + randomUUID().replaceAll('-', '')
  assert.match(prefix, /^history-reference-[a-f0-9]{32}$/)
  let queue, events, worker, job, queueRemoved = false, terminalQueries = 0, delayed = 0
  const failures = []
  try {
    const [[task]] = await admin.query("SELECT id FROM history_collection_tasks_v4 WHERE active_account_id=5 AND status='completing'")
    assert.ok(task)
    const guard = () => ({ async assert(candidate) { assert.deepEqual(candidate, route) } })
    const tasks = new MysqlHistoryCollectionTasks(pool, guard)
    const held = await tasks.claim(task.id, route)
    assert.equal(held.state, 'completing')
    const outbox = new MysqlOutboxRepository(pool), owner = randomUUID()
    const [[clock]] = await admin.query('SELECT UTC_TIMESTAMP(3) now')
    const legacyId = randomUUID()
    await admin.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
      VALUES (?,'trade_history','5','trade.history.requested',?,'pending',0,?,?)`,[legacyId,JSON.stringify({account_id:'5'}),clock.now,clock.now])
    const claimed = await outbox.claim(owner, 500, 30, new Date(clock.now))
    assert.ok(!claimed.some(e=>e.eventId===legacyId))
    const event = claimed.find(e => e.eventType==='trade.history.task.requested' && e.payload.task_id===task.id)
    assert.ok(event)
    queue = new Queue(BRIDGE_HISTORY_TASK_QUEUE, {connection,prefix,defaultJobOptions:{attempts:5,backoff:{type:'exponential',delay:100},removeOnComplete:false,removeOnFail:false}})
    queue.on('error', () => failures.push('queue_error'))
    events = new QueueEvents(BRIDGE_HISTORY_TASK_QUEUE,{connection,prefix})
    events.on('error', () => failures.push('queue_events_error'))
    events.on('delayed', () => { delayed++ })
    await Promise.all([queue.waitUntilReady(),events.waitUntilReady()])
    const publisher = new BullMqOutboxTaskPublisher({bridgeHistoryTask:queue})
    await publisher.publish(event); await publisher.publish(event)
    assert.equal(await queue.getWaitingCount(),1)
    job = await queue.getJob(event.eventId)
    assert.ok(job); assert.deepEqual(job.data,{taskId:task.id})
    assert.equal(await outbox.markDispatched(event.id,owner,new Date()),true)
    const processor = createBridgeHistoryTaskProcessor(createMysqlHistoryTaskWorker(pool,
      {async query(){terminalQueries++;throw Error('unexpected_terminal_query')}},
      {async current(accountId){assert.equal(accountId,route.accountId);return route}},guard))
    worker = new Worker(BRIDGE_HISTORY_TASK_QUEUE,processor,{connection,prefix,concurrency:1,autorun:false})
    worker.on('error',()=>failures.push('worker_error'))
    worker.on('failed',(_job,error)=>failures.push(/^[a-z0-9_]+$/.test(error.message) ? error.message : 'job_failed'))
    await worker.waitUntilReady()
    await admin.execute('UPDATE history_collection_tasks_v4 SET lease_expires_at_utc=UTC_TIMESTAMP(3)+INTERVAL 3 SECOND WHERE id=?',[task.id])
    inject('task-completion-ack')
    const run = worker.run().catch(()=>{failures.push('worker_run_failed')})
    const result = await job.waitUntilFinished(events,20000)
    assert.deepEqual(result,{state:'succeeded',freshThroughUtcMsc:held.claim.rangeEndUtcMsc})
    assert.equal(terminalQueries,0); assert.ok(delayed>=1); assert.deepEqual(failures,[])
    const [[stored]] = await admin.execute('SELECT status,result_receipt_id FROM history_collection_tasks_v4 WHERE id=?',[task.id])
    assert.equal(stored.status,'succeeded'); assert.ok(stored.result_receipt_id)
    assert.equal(await job.getState(),'completed')
    await publisher.publish(event)
    assert.equal(await queue.getWaitingCount(),0)
    assert.equal(await queue.getCompletedCount(),1)
    await worker.close(); await run; worker=null
    inject('task-completion-ack')
    const collection = await verifyQueuedCollection(admin,pool,route,queue,events,connection,prefix,outbox,publisher,snapshots)
    const [[legacy]] = await admin.execute('SELECT status,attempts FROM outbox_events WHERE event_id=?',[legacyId])
    assert.equal(legacy.status,'pending');assert.equal(legacy.attempts,0)
    return {passed:true,legacyEventPreserved:true,collection,checks:['actual-mysql-outbox-claim-publish-replay-one-job','busy-job-delayed-until-lease-expiry',
      'real-worker-restores-mysql-completion-and-confirms-commit-unknown','completed-outbox-replay-does-not-run-another-job'],
      redisHost:connection.host,redisDb:connection.db,prefix,terminalQueries,queueDeliveryVerified:true,
      get queueRemoved(){return queueRemoved}}
  } catch(error) {
    const [[clock]] = await admin.query('SELECT UTC_TIMESTAMP(3) db_now')
    const current = job ? await queue.getJob(job.id) : null
    observe({prefix,localNow:new Date().toISOString(),databaseNow:clock.db_now,delayed,failures,
      job:current ? {state:await current.getState(),delay:current.delay,timestamp:current.timestamp,attemptsMade:current.attemptsMade} : null})
    throw error
  } finally {
    if(worker) await worker.close(true)
    if(events) await events.close()
    if(queue) {
      const reader = new Redis({...connection,maxRetriesPerRequest:1})
      try {
        await queue.obliterate({force:true})
        let cursor='0', count=0
        do { const result=await reader.scan(cursor,'MATCH',`${prefix}:*`,'COUNT',100);cursor=result[0];count+=result[1].length } while(cursor!=='0')
        assert.equal(count,0);queueRemoved=true
      } finally { reader.disconnect(); await queue.close() }
    }
  }
}
