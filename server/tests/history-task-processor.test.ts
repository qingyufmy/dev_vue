import { expect, it, vi } from 'vitest'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import type { HistoryResourcePageChain } from '../src/modules/trade-history/application/trade-history-collector-ports.js'
import type { HistoryCollectionTaskClaimResult } from '../src/modules/trade-history/application/history-collection-tasks.js'
import { historyTaskRoute } from '../src/modules/trade-history/application/history-collection-task.js'
import { historyTaskCompletion } from '../src/modules/trade-history/application/history-task-completion.js'
import { HistoryTaskProcessor } from '../src/modules/trade-history/application/history-task-processor.js'
import { HistoryCommitUnknown } from '../src/modules/trade-history/application/history-commit-unknown.js'

const route: BridgeGatewayRoute = { userId: 7, accountId: '5', platform: 'mt5', terminalInstanceId: 'terminal', terminalProfileId: 'profile',
  brokerServer: 'Broker', login: '001', connectionEpoch: 3, connectionId: 'connection', sessionId: 'session', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
const claim = { taskId: '00000000-0000-4000-8000-000000000001', accountId: '5', leaseToken: '00000000-0000-4000-8000-000000000002',
  rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000, routeHash: historyTaskRoute(route).hash }
const chains: HistoryResourcePageChain[] = ['history.orders', 'history.deals'].map(resource => ({ resource: resource as HistoryResourcePageChain['resource'],
  rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000, source: 'terminal', sourceRevision: 'r1', pageCount: 1, itemCount: 3, pageChainHash: 'a'.repeat(64) }))
const completion = historyTaskCompletion(claim, route, chains)

function fixture(result: HistoryCollectionTaskClaimResult = { state: 'completing', claim, completion }) {
  const repository = { begin: vi.fn(async () => ({ rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000 })),
    persistPage: vi.fn(async () => {}), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) }
  const factory = vi.fn(() => repository)
  const tasks = { claim: vi.fn(async () => result), renew: vi.fn(async () => {}) }
  const query = vi.fn(async () => { throw Error('unexpected_terminal_query') })
  const processor = new HistoryTaskProcessor(tasks, factory, { query }, () => new Date(3000))
  return { processor, repository, factory, tasks, query }
}
it.each([{ state: 'busy', retryAt: '2026-09-10T00:00:00Z' }, { state: 'terminal', status: 'succeeded' },
  { state: 'terminal', status: 'failed' }] as const)('does no collection work for $state $status', async result => {
  const f = fixture(result)
  expect(await f.processor.process(claim.taskId, route)).toEqual(result)
  expect(f.factory).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled()
})
it('resumes durable completion without begin, page writes, or terminal queries', async () => {
  const f = fixture()
  expect(await f.processor.process(claim.taskId, route)).toEqual({ state: 'succeeded', freshThroughUtcMsc: 2000 })
  expect(f.factory).toHaveBeenCalledWith(claim)
  expect(f.repository.complete).toHaveBeenCalledWith(route, 2000, new Date(3000), completion.value.pageChains)
  expect(f.repository.begin).not.toHaveBeenCalled(); expect(f.repository.persistPage).not.toHaveBeenCalled()
  expect(f.repository.fail).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled()
})
it.each([false, true])('confirms unknown completion once with unchanged evidence; second failure=%s', async fails => {
  const f = fixture()
  f.repository.complete.mockRejectedValueOnce(new HistoryCommitUnknown())
  if (fails) f.repository.complete.mockRejectedValueOnce(Error('connection_unavailable'))
  if (fails) await expect(f.processor.process(claim.taskId, route)).rejects.toBeInstanceOf(HistoryCommitUnknown)
  else await expect(f.processor.process(claim.taskId, route)).resolves.toMatchObject({ state: 'succeeded' })
  expect(f.repository.complete).toHaveBeenCalledTimes(2)
  expect(f.repository.complete.mock.calls[0]).toEqual(f.repository.complete.mock.calls[1])
  expect(f.repository.fail).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled()
})
it('preserves prepared work after an ordinary recovery failure', async () => {
  const f = fixture(); f.repository.complete.mockRejectedValueOnce(Error('database_unavailable'))
  await expect(f.processor.process(claim.taskId, route)).rejects.toThrow('database_unavailable')
  expect(f.repository.complete).toHaveBeenCalledTimes(1); expect(f.repository.fail).not.toHaveBeenCalled()
})
it('rejects corrupted stored completion before constructing a writer', async () => {
  const f = fixture({ state: 'completing', claim, completion: { ...completion, json: '{}' } })
  await expect(f.processor.process(claim.taskId, route)).rejects.toThrow('history_task_completion_corrupt')
  expect(f.factory).not.toHaveBeenCalled()
})
it('rejects a claim returned for another task', async () => {
  const f = fixture()
  await expect(f.processor.process('00000000-0000-4000-8000-000000000009', route)).rejects.toThrow('history_task_claim_mismatch')
  expect(f.factory).not.toHaveBeenCalled()
})
it('does not retry an uncertain claim or create a writer', async () => {
  const f = fixture(); f.tasks.claim.mockRejectedValueOnce(new HistoryCommitUnknown())
  await expect(f.processor.process(claim.taskId, route)).rejects.toBeInstanceOf(HistoryCommitUnknown)
  expect(f.tasks.claim).toHaveBeenCalledTimes(1); expect(f.factory).not.toHaveBeenCalled()
})
it('routes collecting tasks through the bound collector and its failure handling', async () => {
  const f = fixture({ state: 'collecting', claim })
  await expect(f.processor.process(claim.taskId, route)).rejects.toThrow('unexpected_terminal_query')
  expect(f.factory).toHaveBeenCalledWith(claim); expect(f.repository.begin).toHaveBeenCalledTimes(1)
  expect(f.query).toHaveBeenCalledTimes(1); expect(f.repository.fail).toHaveBeenCalledTimes(1)
  expect(f.repository.complete).not.toHaveBeenCalled()
})
