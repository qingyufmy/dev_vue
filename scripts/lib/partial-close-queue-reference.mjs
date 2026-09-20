import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {QueueEvents,Worker} from 'bullmq'
import Redis from 'ioredis'
import {developmentRedisConnection} from './development-redis.mjs'
import {MysqlOutboxRepository} from '../../server/dist-v4/outbox/infrastructure/mysql-outbox-repository.js'
import {BullMqOutboxTaskPublisher} from '../../server/dist-v4/outbox/infrastructure/bullmq-outbox-task-publisher.js'
import {createPartialCloseWorkflowQueue,PARTIAL_CLOSE_WORKFLOW_QUEUE} from '../../server/dist-v4/queue/partial-close-workflow-queue.js'
import {createPartialCloseWorkflowProcessor} from '../../server/dist-v4/queue/partial-close-workflow-processor.js'

export async function verifyPartialCloseQueue(db,connectionPool,scope,actualWorker,state) {
 const [[identity]]=await db.query('SELECT DATABASE() db');assert.match(identity.db,/^dev_vue_protection_ref_[a-f0-9]{32}$/)
 const connection={...await developmentRedisConnection(),maxRetriesPerRequest:null}
 const prefix='protection-reference-'+randomUUID().replaceAll('-','');assert.match(prefix,/^protection-reference-[a-f0-9]{32}$/)
 let queue,events,consumer,queueRemoved=false,delayed=0,runCalls=0
 const handoffs=[],failures=[],errors=[]
 const pool={...connectionPool,async execute(sql,params){const c=await connectionPool.getConnection();try{return await c.execute(sql,params)}finally{c.release()}}}
 try {
  await db.query('ALTER TABLE outbox_events ADD COLUMN lease_owner VARCHAR(191),ADD COLUMN lease_expires_at_utc DATETIME(3),ADD COLUMN dispatched_at_utc DATETIME(3)')
  const eventId=randomUUID()
  await db.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
   VALUES (?,'partial_close_workflow',?,'execution.partial-close.requested',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,[eventId,scope.workflowId,JSON.stringify({workflow_id:scope.workflowId,user_id:scope.userId,trading_account_id:scope.accountId})])
  const [[clock]]=await db.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at'),now=new Date(Number(clock.at))
  const disabledClaims=await new MysqlOutboxRepository(pool).claim('disabled',500,30,now)
  assert.ok(disabledClaims.every(item=>!item.eventType.startsWith('execution.partial-close.')))
  const outbox=new MysqlOutboxRepository(pool,{partialCloseWorkflows:true}),owner=randomUUID()
  const claimed=await outbox.claim(owner,500,30,now),event=claimed.find(item=>item.eventId===eventId);assert.ok(event)
  queue=createPartialCloseWorkflowQueue(connection,prefix)
  events=new QueueEvents(PARTIAL_CLOSE_WORKFLOW_QUEUE,{connection,prefix})
  queue.on('error',()=>errors.push('queue_error'));events.on('error',()=>errors.push('events_error'));events.on('delayed',()=>delayed++)
  await Promise.all([queue.waitUntilReady(),events.waitUntilReady()])
  const publisher=new BullMqOutboxTaskPublisher({},queue)
  await publisher.publish(event);await publisher.publish({...event,attempts:2})
  assert.equal(await queue.getWaitingCount(),1)
  const job=await queue.getJob(eventId);assert.ok(job);assert.deepEqual(job.data,scope)
  assert.equal(await outbox.markDispatched(event.id,owner,now),true)
  const processor=createPartialCloseWorkflowProcessor({async run(input){
   runCalls++;if(runCalls===1)return {workflowId:input.workflowId,state:'waiting',reason:'wait_history'}
   return actualWorker.run(input)
  }},async(input,childIntentId)=>{
   assert.deepEqual(input,scope);handoffs.push(childIntentId)
   if(handoffs.length===1)throw Error('reference_receiver_commit_unknown')
  })
  consumer=new Worker(PARTIAL_CLOSE_WORKFLOW_QUEUE,processor,{connection,prefix,concurrency:1,autorun:false})
  consumer.on('error',()=>errors.push('consumer_error'));consumer.on('failed',(_job,error)=>failures.push(error.message))
  await consumer.waitUntilReady()
  const running=consumer.run().catch(()=>errors.push('consumer_run_error'))
  const result=await job.waitUntilFinished(events,20000)
  assert.equal(result.state,'protection_prepared');assert.equal(result.replayed,true)
  assert.equal(handoffs.length,2);assert.equal(new Set(handoffs).size,1);assert.equal(handoffs[0],result.childIntentId)
  assert.ok(delayed>=1);assert.equal(runCalls,3);assert.deepEqual(failures,['reference_receiver_commit_unknown']);assert.deepEqual(errors,[])
  const saved=await state(scope);assert.equal(saved.counts.execution_intents,1);assert.equal(saved.counts.position_protection_reviews_v4,1)
  await publisher.publish(event);assert.equal(await queue.getWaitingCount(),0)
  await consumer.close();consumer=null;await running
  return {passed:true,redisHost:connection.host,redisDb:connection.db,prefix,checks:['actual-MySQL-outbox-explicit-capability-claim','real-Redis-duplicate-event-one-job',
   'waiting-delayed-before-actual-worker-SQL-preparation','receiver-unknown-retries-same-durable-child','completed-job-republication-does-not-reexecute'],
   firstWaitingResult:'injected',preparedReceiver:'injected-no-terminal-dispatch',get queueRemoved(){return queueRemoved}}
 } finally {
  if(consumer)await consumer.close(true)
  if(events)await events.close()
  if(queue){
   const reader=new Redis({...connection,maxRetriesPerRequest:1})
   try {
    await queue.obliterate({force:true});let cursor='0',count=0
    do{const result=await reader.scan(cursor,'MATCH',`${prefix}:*`,'COUNT',100);cursor=result[0];count+=result[1].length}while(cursor!=='0')
    assert.equal(count,0);queueRemoved=true
   }finally{reader.disconnect();await queue.close()}
  }
 }
}
