import { describe, expect, it, vi } from 'vitest'
import { DelayedError, type Job } from 'bullmq'
import type { Pool } from 'mysql2/promise'
import { BullMqOutboxTaskPublisher } from '../src/outbox/infrastructure/bullmq-outbox-task-publisher.js'
import { MysqlOutboxRepository } from '../src/outbox/infrastructure/mysql-outbox-repository.js'
import type { RuntimeTaskQueues } from '../src/queue/task-queues.js'
import type { ClaimedOutboxEvent } from '../src/outbox/application/outbox-ports.js'
import { createPartialCloseWorkflowProcessor } from '../src/queue/partial-close-workflow-processor.js'
import type { PartialCloseWorkflowJob } from '../src/queue/partial-close-workflow-queue.js'
import type { PartialCloseWorkflowWorkResult } from '../src/modules/execution/index.js'

const scope = {workflowId:'11111111-1111-8111-a111-111111111111',userId:7,accountId:'5'}
const childIntentId = '22222222-2222-5222-a222-222222222222'
const event: ClaimedOutboxEvent = {id:'1',eventId:'event-12345678',eventType:'execution.partial-close.requested',occurredAt:'2026-09-10T00:00:00.000Z',attempts:1,
  payload:{workflow_id:scope.workflowId,user_id:7,trading_account_id:'5'}}
function publisher() {
  const add=vi.fn().mockResolvedValue(undefined)
  return {add,publisher:new BullMqOutboxTaskPublisher({} as RuntimeTaskQueues,{add})}
}
describe('partial close outbox queue routing', () => {
  it.each(['requested','progressed','reviewed','expired'] as const)('routes %s with IDs only and stable delivery identity', async suffix => {
    const f=publisher(),e={...event,eventType:`execution.partial-close.${suffix}` as ClaimedOutboxEvent['eventType'],payload:{...event.payload,
      ...(suffix==='requested'?{}:{revision:3}),...(suffix==='reviewed'?{child_intent_id:childIntentId}:{})}}
    await f.publisher.publish(e);await f.publisher.publish({...e,attempts:2})
    expect(f.add.mock.calls).toEqual(Array.from({length:2},()=>['execution.partial-close.run',scope,{jobId:event.eventId}]))
  })
  it('does not acknowledge a new event when the workflow queue is unavailable', async () => {
    await expect(new BullMqOutboxTaskPublisher({} as RuntimeTaskQueues).publish(event)).rejects.toThrow('partial_close_queue_unavailable')
  })
  it.each([{user_id:'7'},{trading_account_id:'18446744073709551616'},{workflow_id:'wrong'},{action:'position.modify'}])('rejects malformed or executable payload fields %j', patch => {
    const f=publisher()
    return expect(f.publisher.publish({...event,payload:{...event.payload,...patch}})).rejects.toThrow()
  })
  it('propagates Redis failure without swallowing the delivery', async () => {
    const f=publisher(),failure=Error('redis_failed');f.add.mockRejectedValue(failure)
    await expect(f.publisher.publish(event)).rejects.toBe(failure)
  })
  it.each([false,true])('claims workflow events only with explicit capability %s', async enabled => {
    const execute=vi.fn(async()=>[[]]),connection={execute,beginTransaction:vi.fn(),commit:vi.fn(),rollback:vi.fn(),release:vi.fn()}
    const pool={getConnection:async()=>connection} as unknown as Pool
    await new MysqlOutboxRepository(pool,{partialCloseWorkflows:enabled}).claim('owner',10,30,new Date())
    for(const [sql] of execute.mock.calls as unknown as [string][]) expect(sql.includes('execution.partial-close.requested')).toBe(enabled)
  })
})
describe('partial close queue processor', () => {
  function fixture(result: PartialCloseWorkflowWorkResult = {workflowId:scope.workflowId,state:'protection_prepared',childIntentId,replayed:false}) {
    const run=vi.fn(async()=>result),prepared=vi.fn(async()=>{}),moveToDelayed=vi.fn(async(_at: number,_token?: string)=>{})
    const job={name:'execution.partial-close.run',data:{...scope},moveToDelayed} as unknown as Job<PartialCloseWorkflowJob>
    return {run,prepared,job,moveToDelayed,process:createPartialCloseWorkflowProcessor({run},prepared)}
  }
  it('delays waiting without consuming a normal failure attempt or invoking dispatch', async () => {
    const f=fixture({workflowId:scope.workflowId,state:'waiting',reason:'wait_history'}),before=Date.now()
    await expect(f.process(f.job,'token')).rejects.toBeInstanceOf(DelayedError)
    expect(f.moveToDelayed).toHaveBeenCalledWith(expect.any(Number),'token')
    expect(f.moveToDelayed.mock.calls[0]![0]).toBeGreaterThanOrEqual(before+1000)
    expect(f.prepared).not.toHaveBeenCalled()
  })
  it('does not complete a prepared task before the receiver succeeds', async () => {
    const f=fixture(),failure=Error('dispatch_commit_unknown');f.prepared.mockRejectedValueOnce(failure)
    await expect(f.process(f.job,'token')).rejects.toBe(failure)
    await expect(f.process(f.job,'token')).resolves.toMatchObject({state:'protection_prepared'})
    expect(f.prepared.mock.calls).toEqual([[scope,childIntentId],[scope,childIntentId]])
  })
  it('requires reconciliation capability and never sends uncertain work to the prepared receiver', async () => {
    const f=fixture({workflowId:scope.workflowId,state:'protection_reconcile',childIntentId,commandId:'command'})
    await expect(f.process(f.job,'token')).rejects.toThrow('partial_close_reconciliation_receiver_required')
    const reconcile=vi.fn(async()=>{})
    const process=createPartialCloseWorkflowProcessor({run:f.run},f.prepared,reconcile)
    await expect(process(f.job,'token')).rejects.toBeInstanceOf(DelayedError)
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(scope,childIntentId,'command')
    expect(f.prepared).not.toHaveBeenCalled()
    expect(f.moveToDelayed).toHaveBeenCalledTimes(1)
  })
  it.each(['expired','stopped','succeeded'] as const)('completes %s without dispatch', async state => {
    const f=fixture({workflowId:scope.workflowId,state})
    await expect(f.process(f.job,'token')).resolves.toMatchObject({state});expect(f.prepared).not.toHaveBeenCalled()
  })
  it('rejects unrecognized job names before SQL work', async () => {
    const f=fixture();f.job.name='unexpected'
    await expect(f.process(f.job,'token')).rejects.toThrow('partial_close_job_name_invalid');expect(f.run).not.toHaveBeenCalled()
  })
})
