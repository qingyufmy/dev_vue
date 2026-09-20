import { describe, expect, it, vi } from 'vitest'
import { PublicMarketCollector } from '../src/modules/market/application/public-market-collector.js'
import { PublicMarketCatalog } from '../src/modules/market/application/public-market-catalog.js'
import { inspectSettingUpdate } from '../src/modules/settings/domain/setting-value-policy.js'
import type { MarketSourceState } from '../src/modules/market/domain/market-source.js'

function fixture() {
  const state: MarketSourceState = { revision: 1, generation: 1, source: { accountId: '20', ownerUserId: 1,
    connectionId: 'connection-20', connectionEpoch: 1 }, resolvedSymbol: 'XAUUSD.s', failures: 0, firstFailureAt: null, lastCheckedAt: Date.now() }
  const leases: Array<{ renew: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = []
  const streams = { create: vi.fn(() => { const lease = { renew: vi.fn().mockResolvedValue(undefined), close: vi.fn() }; leases.push(lease); return lease }) }
  const catalog = { list: vi.fn().mockResolvedValue(['XAUUSD']) }
  const selector = { select: vi.fn().mockResolvedValue(state), isCurrent: vi.fn().mockResolvedValue(true) }
  return { state, leases, streams, catalog, selector, collector: new PublicMarketCollector(catalog, selector, streams) }
}
describe('shared background market collection', () => {
  it('reuses one lease for a quote and all periods across repeated ticks', async () => {
    const f = fixture(); await f.collector.tick(); await f.collector.tick()
    expect(f.streams.create).toHaveBeenCalledTimes(1)
    const args = f.streams.create.mock.calls[0] as unknown as [number, Array<{ accountId: string; symbol: string; timeframe: string | null }>]
    expect(args[0]).toBe(1)
    expect(args[1]).toHaveLength(8)
    expect(args[1].every(t => t.accountId === '20' && t.symbol === 'XAUUSD.s')).toBe(true)
    expect(f.leases[0]!.renew).toHaveBeenCalledTimes(2)
  })
  it('cancels the previous lease before subscribing a new source generation', async () => {
    const f = fixture(); await f.collector.tick()
    f.selector.select.mockResolvedValue({ ...f.state, generation: 2, source: { ...f.state.source!, accountId: '21' } })
    await f.collector.tick()
    expect(f.leases[0]!.close).toHaveBeenCalledTimes(1)
    expect(f.leases[0]!.close.mock.invocationCallOrder[0]).toBeLessThan(f.leases[1]!.renew.mock.invocationCallOrder[0]!)
  })
  it('stops demand when the administrator removes the symbol', async () => {
    const f = fixture(); await f.collector.tick(); f.catalog.list.mockResolvedValue([])
    expect((await f.collector.tick()).active).toBe(0)
    expect(f.leases[0]!.close).toHaveBeenCalledTimes(1)
  })
  it('stops demand on authorization loss and does not silently choose another account', async () => {
    const f = fixture(); await f.collector.tick(); f.selector.isCurrent.mockResolvedValue(false)
    expect((await f.collector.tick()).active).toBe(0)
    expect(f.streams.create).toHaveBeenCalledTimes(1)
  })
  it('clears old demand when catalog reading fails', async () => {
    const f = fixture(); await f.collector.tick(); f.catalog.list.mockRejectedValue(new Error('unavailable'))
    await expect(f.collector.tick()).rejects.toThrow('unavailable')
    expect(f.leases[0]!.close).toHaveBeenCalledTimes(1)
  })
  it('does not install a lease after shutdown during source selection', async () => {
    const f = fixture(); let finish!: (value: MarketSourceState) => void
    f.selector.select.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = f.collector.tick(); await Promise.resolve(); await Promise.resolve()
    f.collector.close(); finish(f.state); await pending
    expect(f.streams.create).not.toHaveBeenCalled()
  })
  it('does not overlap a second collection cycle', async () => {
    const f = fixture(); let finish!: (value: MarketSourceState) => void
    f.selector.select.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = f.collector.tick(); await Promise.resolve(); await Promise.resolve()
    await f.collector.tick(); finish(f.state); await pending
    expect(f.selector.select).toHaveBeenCalledTimes(1)
  })
  it('does not invent a default when the database catalog is missing', async () => {
    const catalog = new PublicMarketCatalog({ read: async () => ({ status: 'missing' }) })
    await expect(catalog.list()).rejects.toThrow('market_catalog_unavailable')
  })
  it.each(['["XAUUSD.s"]', '["xauusd"]', '["XAUUSD","XAUUSD"]', '[1]'])('rejects invalid administrator catalog %s', value => {
    expect(inspectSettingUpdate({ namespace: 'market_data', key: 'symbols', expectedType: 'json_array', value }).status).toBe('rejected')
  })
  it('allows a base catalog and an explicit empty catalog', () => {
    for (const value of ['["XAUUSD","EURUSD"]', '[]']) expect(inspectSettingUpdate({ namespace: 'market_data', key: 'symbols', expectedType: 'json_array', value }).status).toBe('eligible')
  })
})
