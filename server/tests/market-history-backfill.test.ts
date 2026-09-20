import { expect, it, vi } from 'vitest'
import { MarketHistoryBackfill, type HistoryProgress, type MarketHistoryPorts } from '../src/modules/market/application/market-history-backfill.js'
const scope = { pool: { kind: 'public' as const }, symbol: 'XAUUSD', timeframe: 'M5' as const }
function fixture() {
  let now = 1_800_000_000_000
  let progress: HistoryProgress | null = null
  const state = { revision: 1, generation: 1, source: { accountId: '9', ownerUserId: 1, connectionId: 'connection', connectionEpoch: 1 }, resolvedSymbol: 'XAUUSD.s', failures: 0, firstFailureAt: null, lastCheckedAt: now }
  const ports: MarketHistoryPorts = { demands: vi.fn(async () => [scope]), select: vi.fn(async () => state), current: vi.fn(async () => true),
    progress: async () => progress, save: async (_d, value) => { progress = value }, collect: vi.fn(async () => 199), changed: vi.fn(async () => {}) }
  const worker = new MarketHistoryBackfill(ports, () => now)
  return { worker, ports, state, progress: () => progress!, advance: (ms: number) => { now += ms } }
}
it('does not query any terminal without actual demand', async () => {
  const f = fixture(); vi.mocked(f.ports.demands).mockResolvedValue([]); await f.worker.tick()
  expect(f.ports.collect).not.toHaveBeenCalled()
})
it('pages backward through calendar gaps without creating candles', async () => {
  const f = fixture(); vi.mocked(f.ports.collect).mockResolvedValueOnce(0)
  await f.worker.tick(); expect(f.progress().count).toBe(0)
  await f.worker.tick()
  expect(vi.mocked(f.ports.collect).mock.calls[1]![2]).toBe(1_800_000_000_000 - 199 * 5 * 60_000)
  expect(f.progress().count).toBe(199)
})
it('stops at the target and only repairs the recent interval on later checks', async () => {
  const f = fixture(); for (let i = 0; i < 11; i++) await f.worker.tick()
  expect(f.progress().status).toBe('complete')
  await f.worker.tick(); expect(f.ports.collect).toHaveBeenCalledTimes(11)
  const anchor = f.progress().anchor; f.advance(3_600_001); await f.worker.tick()
  expect(f.progress().stopAt).toBe(anchor); expect(f.progress().status).toBe('complete')
  expect(f.ports.collect).toHaveBeenCalledTimes(12)
})
it('does not advance a checkpoint after a source change during a read', async () => {
  const f = fixture(); vi.mocked(f.ports.current).mockResolvedValue(false); await f.worker.tick()
  expect(f.progress()).toBeNull(); expect(f.ports.changed).not.toHaveBeenCalled()
})
it('backs off a failed page and retries the same window', async () => {
  const f = fixture(); vi.mocked(f.ports.collect).mockRejectedValueOnce(new Error('unavailable'))
  await expect(f.worker.tick()).rejects.toThrow('unavailable'); await f.worker.tick()
  expect(f.ports.collect).toHaveBeenCalledTimes(1)
  f.advance(30_001); await f.worker.tick()
  expect(vi.mocked(f.ports.collect).mock.calls[1]![2]).toBe(vi.mocked(f.ports.collect).mock.calls[0]![2])
})
it('marks bounded empty history insufficient and does not continuously retry', async () => {
  const f = fixture(); vi.mocked(f.ports.collect).mockResolvedValue(0)
  for (let i = 0; i < 24; i++) await f.worker.tick()
  expect(f.progress().status).toBe('insufficient'); await f.worker.tick()
  expect(f.ports.collect).toHaveBeenCalledTimes(24)
})
