import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { PublicMarketSnapshot, type PublicMarketCache } from '../src/modules/market/application/public-market-snapshot.js'
import { publicMarketRoutes } from '../src/modules/market/transport/http/public-market-routes.js'
import type { MarketSourceState } from '../src/modules/market/domain/market-source.js'
import { AuthError } from '../src/modules/auth/index.js'

function fixture() {
  const state: MarketSourceState = { revision: 1, generation: 1, source: { accountId: '20', ownerUserId: 1,
    connectionId: 'connection-20', connectionEpoch: 1 }, resolvedSymbol: 'XAUUSD.s', failures: 0, firstFailureAt: null, lastCheckedAt: Date.now() }
  const sources = { read: vi.fn().mockResolvedValue(state), compareAndSet: vi.fn() }
  const providers = { list: vi.fn().mockResolvedValue([1]) }
  const cache = { findPublicCachedSource: vi.fn().mockResolvedValue({ accountId: '20', ownerUserId: 1, resolvedSymbol: 'XAUUSD.s', platform: 'mt5' as const }), getPublicDisplayClock: vi.fn().mockResolvedValue({ offset: 180, checkedAt: new Date().toISOString(), ownerUserId: 1 }), getPublicSourceClock: vi.fn().mockResolvedValue({ offset: 180, checkedAt: new Date().toISOString() }), findOwnedAccount: vi.fn().mockResolvedValue({ id: '20' }),
    getQuote: vi.fn().mockResolvedValue({ accountId: '20', symbol: 'XAUUSD.s', bid: '2500.00', ask: '2500.20', last: null,
      spread: '0.20', observedAt: '2026-09-14T00:00:00.000Z', revision: 2 }),
    listCandles: vi.fn().mockResolvedValue([{ accountId: '20', symbol: 'XAUUSD.s', timeframe: 'M5', openTime: '2026-09-14T00:00:00.000Z',
      open: '2500', high: '2501', low: '2499', close: '2500', tickVolume: '10', closed: true, revision: 1 }]),
  } satisfies PublicMarketCache
  const catalog = { list: vi.fn().mockResolvedValue(['XAUUSD']) }
  return { state, sources, providers, cache, catalog, service: new PublicMarketSnapshot(providers, cache, catalog) }
}
describe('shared public market cache', () => {
  it('shares only the selected administrator bridge status, not the viewer account', async () => {
    const f = fixture()
    f.state.marketState = { state: 'open', reason: 'quote_fresh', checked_at_utc_msc: Date.now() }
    const service = new PublicMarketSnapshot(f.providers, f.cache, f.catalog, undefined, f.sources)
    expect((await service.symbols()).market_states).toEqual([{ symbol: 'XAUUSD', state: 'open', reason: 'quote_fresh', checked_at: expect.any(String) }])
    expect(f.sources.read).toHaveBeenCalledWith({ pool: { kind: 'public' }, symbol: 'XAUUSD' })
    expect(JSON.stringify((await service.symbols()).market_states)).not.toMatch(/account|connection|XAUUSD.s/)
  })
  it.each(['expired', 'revoked', 'offline', 'failure', 'future'] as const)('does not label %s administrator evidence as open or closed', async mode => {
    const f = fixture()
    f.state.marketState = { state: 'closed', reason: 'weekend_tick_stale', checked_at_utc_msc: Date.now() + (mode === 'expired' ? -46000 : mode === 'future' ? 30000 : 0) }
    if (mode === 'revoked') f.providers.list.mockResolvedValue([2])
    if (mode === 'offline') f.state.source = null
    if (mode === 'failure') f.state.failures = 1
    const service = new PublicMarketSnapshot(f.providers, f.cache, f.catalog, undefined, f.sources)
    expect((await service.symbols()).market_states[0]).toMatchObject({ state: 'unknown', checked_at: null })
  })
  it('does not publish a symbol removed from the administrator catalog', async () => {
    const f = fixture(); f.catalog.list.mockResolvedValue([])
    expect((await f.service.read('XAUUSD', 'M5')).status).toBe('unavailable')
    expect(f.cache.getQuote).not.toHaveBeenCalled()
  })
  it('rejects catalog removal during a snapshot read', async () => {
    const f = fixture(); f.catalog.list.mockResolvedValueOnce(['XAUUSD']).mockResolvedValueOnce(['XAUUSD']).mockResolvedValue([])
    await expect(f.service.read('XAUUSD', 'M5')).rejects.toThrow('public_market_source_changed')
  })
  it('returns provider prices with no account details and no election', async () => {
    const f = fixture()
    const result = await f.service.read('XAUUSD', 'M5')
    expect(result.quote?.bid).toBe('2500.00')
    expect(result.candles).toHaveLength(1)
    expect(result.structure).toMatchObject({ algorithm: 'chan_structure_v8', status: 'insufficient_klines', based_on_closed_bars: 1 })
    expect(JSON.stringify(result)).not.toMatch(/accountId|account_id|ownerUserId|connection-20|XAUUSD.s/)
    expect(f.cache.listCandles).toHaveBeenCalledWith('20', 'XAUUSD.s', 'M5', 200, undefined)
    await f.service.read('XAUUSD', 'M5')
    expect(f.cache.listCandles.mock.calls.filter(call => call[3] === 1800)).toHaveLength(1)
    expect(f.sources.compareAndSet).not.toHaveBeenCalled()
  })
  it('keeps public history when every collector is offline', async () => {
    const f = fixture(); f.sources.read.mockResolvedValue(null)
    expect((await f.service.read('XAUUSD', 'M5')).candles).toHaveLength(1)
    expect(f.cache.getQuote).toHaveBeenCalled()
  })
  it('reuses structure for quote changes and recalculates when a closed candle is revised or added', async () => {
    const f = fixture()
    const bar = (await f.cache.listCandles())[0]!
    f.cache.listCandles.mockClear()
    await f.service.read('XAUUSD', 'M5')
    f.cache.getQuote.mockResolvedValue({ ...(await f.cache.getQuote())!, bid: '2502', revision: 3 })
    await f.service.read('XAUUSD', 'M5')
    expect(f.cache.listCandles.mock.calls.filter(call => call[3] === 1800)).toHaveLength(1)
    f.cache.listCandles.mockResolvedValue([{ ...bar, high: '2503', revision: 4 }])
    await f.service.read('XAUUSD', 'M5')
    expect(f.cache.listCandles.mock.calls.filter(call => call[3] === 1800)).toHaveLength(2)
    f.cache.listCandles.mockResolvedValue([bar, { ...bar, openTime: '2026-09-14T00:05:00.000Z', revision: 5 }])
    expect((await f.service.read('XAUUSD', 'M5')).structure?.based_on_closed_bars).toBe(2)
    expect(f.cache.listCandles.mock.calls.filter(call => call[3] === 1800)).toHaveLength(3)
    f.cache.listCandles.mockResolvedValue([{ ...bar, close: '2501', revision: 6 }, { ...bar, openTime: '2026-09-14T00:05:00.000Z', revision: 5 }])
    await f.service.read('XAUUSD', 'M5')
    expect(f.cache.listCandles.mock.calls.filter(call => call[3] === 1800)).toHaveLength(4)
    await f.service.read('XAUUSD', 'M5', 2)
    expect(f.cache.listCandles.mock.calls.filter(call => call[3] === 1800)).toHaveLength(4)
  })
  it('does not use a provider whose admin access was removed', async () => {
    const f = fixture(); f.providers.list.mockResolvedValue([])
    expect((await f.service.read('XAUUSD', 'M5')).status).toBe('unavailable')
    expect(f.cache.getQuote).not.toHaveBeenCalled()
  })
  it('keeps cache identity stable when a collector reconnects', async () => {
    const f = fixture(); f.sources.read.mockResolvedValueOnce(f.state).mockResolvedValue({ ...f.state, generation: 2 })
    const first = await f.service.read('XAUUSD', 'M5')
    f.sources.read.mockResolvedValue(null)
    expect((await f.service.read('XAUUSD', 'M5')).source_key).toBe(first.source_key)
  })
  it('rechecks admin eligibility after cache reads', async () => {
    const f = fixture(); f.providers.list.mockResolvedValueOnce([1]).mockResolvedValueOnce([1]).mockResolvedValue([])
    await expect(f.service.read('XAUUSD', 'M5')).rejects.toThrow('public_market_source_changed')
  })
  it('rejects a cache row from a different account', async () => {
    const f = fixture(); f.cache.listCandles.mockResolvedValue([{ accountId: '99' }])
    await expect(f.service.read('XAUUSD', 'M5')).rejects.toThrow('public_market_scope_invalid')
  })
  it('serves the validated HTTP contract to an authenticated ordinary user', async () => {
    const f = fixture(); const app = Fastify()
    await app.register(publicMarketRoutes, { service: f.service, auth: { authenticate: async () => ({ userId: 99 }) } })
    try {
      const reply = await app.inject('/market/public-snapshot?symbol=XAUUSD&timeframe=M5')
      expect(reply.statusCode).toBe(200)
      expect(reply.json().data.source_key).toMatch(/^[a-f0-9]{64}$/)
      const symbols = await app.inject('/market/public-symbols')
      expect(symbols.statusCode).toBe(200)
      expect(symbols.json().data.items).toEqual(['XAUUSD'])
      expect((await app.inject('/market/public-snapshot?symbol=XAUUSD&timeframe=invalid')).statusCode).toBe(400)
    } finally { await app.close() }
  })
  it('passes a bounded historical cursor only to the elected source and rejects malformed cursors', async () => {
    const f = fixture(); const app = Fastify()
    await app.register(publicMarketRoutes, { service: f.service, auth: { authenticate: async () => ({ userId: 99 }) } })
    try {
      const before = '2026-09-14T01:00:00.000Z'
      const response = await app.inject(`/market/public-snapshot?symbol=XAUUSD&timeframe=M5&page_size=200&before=${before}`)
      expect(response.statusCode).toBe(200)
      expect(response.json().data.structure).toMatchObject({ algorithm: 'chan_structure_v8', based_on_closed_bars: 1 })
      expect(f.cache.listCandles).toHaveBeenCalledWith('20', 'XAUUSD.s', 'M5', 200, before)
      expect(f.cache.listCandles).toHaveBeenCalledWith('20', 'XAUUSD.s', 'M5', 1800, before)
      expect(f.cache.getPublicSourceClock).toHaveBeenCalled()
      expect((await app.inject('/market/public-snapshot?symbol=XAUUSD&timeframe=M5&before=invalid')).statusCode).toBe(400)
      expect((await app.inject('/market/public-snapshot?symbol=XAUUSD&timeframe=M5&page_size=501')).statusCode).toBe(400)
    } finally { await app.close() }
  })
  it('requires a session before reading shared prices', async () => {
    const f = fixture(); const app = Fastify()
    await app.register(publicMarketRoutes, { service: f.service, auth: { authenticate: async () => { throw new AuthError('unauthenticated', 401) } } })
    try {
      expect((await app.inject('/market/public-snapshot?symbol=XAUUSD&timeframe=M5')).statusCode).toBe(401)
      expect(f.sources.read).not.toHaveBeenCalled()
    } finally { await app.close() }
  })
})

it('shares only the administrator clock and withdraws it after provider access is removed', async () => {
  const f = fixture()
  expect((await f.service.symbols()).timezone).toMatchObject({ offset_minutes: 180, status: 'calibrated' })
  expect(f.cache.getPublicDisplayClock).toHaveBeenCalledWith([1])
  f.providers.list.mockResolvedValue([])
  expect((await f.service.symbols()).timezone).toBeNull()
})

it('keeps confirmed public timezone with no online collector or viewer account', async () => {
  const f = fixture(); f.sources.read.mockResolvedValue(null)
  expect((await f.service.symbols()).timezone).toMatchObject({ offset_minutes: 180, status: 'calibrated' })
  expect(f.sources.read).not.toHaveBeenCalled()
})
it('does not query a viewer or terminal when the public cache is empty', async () => {
  const f = fixture(); f.cache.findPublicCachedSource.mockResolvedValue(null)
  expect((await f.service.read('XAUUSD', 'M5')).status).toBe('unavailable')
  expect(f.cache.getQuote).not.toHaveBeenCalled()
})
