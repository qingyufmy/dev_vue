import { expect, it, vi } from 'vitest'
import { BridgeInstrumentWorker } from '../src/modules/bridge/application/bridge-instrument-worker.js'
const claim = { requestId: 'request-1', userId: 7, accountId: '11', symbol: 'XAUUSD', leaseToken: 'token-1' }
function fixture() {
  const tasks = { claim: vi.fn().mockResolvedValue({ state: 'claimed', claim }),
    complete: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(true) }
  const current = vi.fn().mockResolvedValue({ userId: 7, accountId: '11' })
  const collect = vi.fn().mockResolvedValue({ applied: true, revision: 3 })
  return { tasks, current, collect, worker: new BridgeInstrumentWorker(tasks, { current }, { collect }, () => 0) }
}
it('uses database scope and completes with the collected revision', async () => {
  const f = fixture()
  expect(await f.worker.run('request-1')).toEqual({ state: 'collected', revision: 3 })
  expect(f.current).toHaveBeenCalledWith('11')
  expect(f.collect).toHaveBeenCalledWith({ route: { userId: 7, accountId: '11' }, symbol: 'XAUUSD', collectionLease: { requestId: 'request-1', leaseToken: 'token-1' } })
  expect(f.tasks.complete).toHaveBeenCalledWith(claim, 3)
})
it.each([{ state: 'terminal' }, { state: 'busy', retryAt: '2026-09-09T00:01:30.000Z' }])('does not query for %j', async state => {
  const f = fixture(); f.tasks.claim.mockResolvedValue(state)
  expect(await f.worker.run('request-1')).toEqual(state.state === 'busy' ? { ...state, state: 'retry' } : state)
  expect(f.current).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled()
})
it.each([null, { userId: 8, accountId: '11' }, { userId: 7, accountId: '12' }])('rejects an absent or mismatched route %j', async route => {
  const f = fixture(); f.current.mockResolvedValue(route)
  expect(await f.worker.run('request-1')).toEqual({ state: 'retry', retryAt: '1970-01-01T00:00:05.000Z' })
  expect(f.collect).not.toHaveBeenCalled(); expect(f.tasks.complete).not.toHaveBeenCalled()
  expect(f.tasks.release).toHaveBeenCalledWith(claim, 'instrument_collection_failed')
})
it('releases a failed collection without persisting raw error text', async () => {
  const f = fixture(); f.collect.mockRejectedValue(new Error('private transport details'))
  expect((await f.worker.run('request-1')).state).toBe('retry')
  expect(f.tasks.release).toHaveBeenCalledWith(claim, 'instrument_collection_failed')
})
it('does not release after an unknown completion acknowledgement', async () => {
  const f = fixture(); f.tasks.complete.mockRejectedValue(new Error('connection lost'))
  await expect(f.worker.run('request-1')).rejects.toThrow('connection lost')
  expect(f.tasks.release).not.toHaveBeenCalled()
})
it('does not report success when the completion lease was lost', async () => {
  const f = fixture(); f.tasks.complete.mockResolvedValue(false)
  expect((await f.worker.run('request-1')).state).toBe('retry')
  expect(f.tasks.release).not.toHaveBeenCalled()
})
it('propagates persistence failure instead of reporting successful retry scheduling', async () => {
  const f = fixture(); f.current.mockResolvedValue(null); f.tasks.release.mockRejectedValue(new Error('database unavailable'))
  await expect(f.worker.run('request-1')).rejects.toThrow('database unavailable')
})
