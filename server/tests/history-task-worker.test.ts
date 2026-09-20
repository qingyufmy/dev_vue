import { expect, it, vi } from 'vitest'
import { DelayedError, type Job } from 'bullmq'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import { HistoryTaskWorker, type HistoryTaskLocator } from '../src/modules/trade-history/application/history-task-worker.js'
import { createBridgeHistoryTaskProcessor, type BridgeHistoryTaskJob } from '../src/queue/bridge-history-task-processor.js'

const taskId = '00000000-0000-4000-8000-000000000001'
const route = { accountId: '5' } as BridgeGatewayRoute
it('uses current verified clock when login lease has no offset', async () => {
  const original = { accountId: '5', userId: 2, timezoneOffsetMinutes: null } as BridgeGatewayRoute
  const process = vi.fn(async () => ({ state: 'succeeded' as const, freshThroughUtcMsc: 2000 }))
  const read = vi.fn(async () => ({ clockStatus: 'calibrated' as const, timezoneOffsetMinutes: 180 }))
  const worker = new HistoryTaskWorker({ find: async () => ({ accountId: '5', status: 'pending' }) },
    { current: async () => original }, { process }, { read })
  await worker.run(taskId)
  expect(read).toHaveBeenCalledWith(2, '5')
  expect(process).toHaveBeenCalledWith(taskId, { ...original, timezoneOffsetMinutes: 180 })
  expect(original.timezoneOffsetMinutes).toBeNull()
})
it('does not collect using stale login-time clock', async () => {
  const process = vi.fn()
  const worker = new HistoryTaskWorker({ find: async () => ({ accountId: '5', status: 'pending' }) },
    { current: async () => ({ ...route, timezoneOffsetMinutes: 180 }) }, { process },
    { read: async () => ({ clockStatus: 'stale', timezoneOffsetMinutes: 180 }) })
  await expect(worker.run(taskId)).rejects.toThrow('history_task_clock_unavailable')
  expect(process).not.toHaveBeenCalled()
})
function fixture(status: NonNullable<Awaited<ReturnType<HistoryTaskLocator['find']>>>['status'] = 'pending') {
  const find = vi.fn(async (): ReturnType<HistoryTaskLocator['find']> => ({ accountId: '5', status }))
  const current = vi.fn(async (): Promise<BridgeGatewayRoute | null> => route)
  const process = vi.fn(async () => ({ state: 'succeeded' as const, freshThroughUtcMsc: 2000 }))
  const worker = new HistoryTaskWorker({ find }, { current }, { process })
  return { find, current, process, worker }
}
it.each(['succeeded', 'failed'] as const)('acknowledges immutable %s tasks without an online route', async status => {
  const f = fixture(status)
  expect(await f.worker.run(taskId)).toEqual({ state: 'terminal', status })
  expect(f.current).not.toHaveBeenCalled(); expect(f.process).not.toHaveBeenCalled()
})
it.each(['pending', 'running', 'completing'] as const)('resolves durable account before processing %s', async status => {
  const f = fixture(status)
  await f.worker.run(taskId)
  expect(f.current).toHaveBeenCalledWith('5'); expect(f.process).toHaveBeenCalledWith(taskId, route)
})
it('rejects invalid task identity before reading storage', async () => {
  const f = fixture()
  await expect(f.worker.run('5')).rejects.toThrow('history_task_id_invalid')
  expect(f.find).not.toHaveBeenCalled()
})
it('rejects absent tasks without resolving an account', async () => {
  const f = fixture(); f.find.mockResolvedValueOnce(null)
  await expect(f.worker.run(taskId)).rejects.toThrow('history_task_not_found')
  expect(f.current).not.toHaveBeenCalled()
})
it.each([null, { accountId: '6' } as BridgeGatewayRoute])('does not process an unavailable or mismatched route', async value => {
  const f = fixture(); f.current.mockResolvedValueOnce(value)
  await expect(f.worker.run(taskId)).rejects.toThrow(value ? 'history_task_claim_mismatch' : 'bridge_query_route_unavailable')
  expect(f.process).not.toHaveBeenCalled()
})
it('moves busy jobs to delayed with the worker token instead of acknowledging them', async () => {
  const retryAt = new Date(Date.now()+90000).toISOString()
  const run = vi.fn(async () => ({ state: 'busy' as const, retryAt }))
  const moveToDelayed = vi.fn(async () => {})
  const job = { data: { taskId }, moveToDelayed } as unknown as Job<BridgeHistoryTaskJob>
  await expect(createBridgeHistoryTaskProcessor({ run })(job, 'worker-token')).rejects.toBeInstanceOf(DelayedError)
  expect(moveToDelayed).toHaveBeenCalledWith(Date.parse(retryAt), 'worker-token')
  expect(run).toHaveBeenCalledTimes(1)
})
it('rejects an invalid retry timestamp without moving the job', async () => {
  const run = vi.fn(async () => ({ state: 'busy' as const, retryAt: 'invalid' }))
  const moveToDelayed = vi.fn()
  const job = { data: { taskId }, moveToDelayed } as unknown as Job<BridgeHistoryTaskJob>
  await expect(createBridgeHistoryTaskProcessor({ run })(job)).rejects.toThrow('history_task_retry_time_invalid')
  expect(moveToDelayed).not.toHaveBeenCalled()
})
it('returns successful task results without queue state changes', async () => {
  const result = { state: 'terminal' as const, status: 'succeeded' as const }
  const moveToDelayed = vi.fn()
  const job = { data: { taskId }, moveToDelayed } as unknown as Job<BridgeHistoryTaskJob>
  expect(await createBridgeHistoryTaskProcessor({ run: async () => result })(job)).toEqual(result)
  expect(moveToDelayed).not.toHaveBeenCalled()
})
