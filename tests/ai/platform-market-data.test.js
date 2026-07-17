import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ queryAll: vi.fn(), queryOne: vi.fn(), queryRun: vi.fn() }))
const bridge = vi.hoisted(() => ({ activeId: vi.fn(), clock: vi.fn() }))
const mt5Bridge = vi.hoisted(() => vi.fn())
const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }))

vi.mock('../../server/db.js', () => db)
vi.mock('../../server/bridge-ws.js', () => ({
  getActivePlatformBridgeUserId: bridge.activeId,
  getPlatformMarketClockState: bridge.clock,
}))
vi.mock('../../server/routes/ai/market-data.js', () => ({ mt5Bridge }))
vi.mock('../../server/redis.js', () => ({ cacheGetJSON: redis.get, cacheSetJSON: redis.set }))

import { getPlatformRates } from '../../server/routes/ai/platform-market-data.js'

const rate = (minute, close) => ({
  time: `2026-07-16 10:0${minute}:00`, time_msc: 1784196000000 + minute * 60000,
  time_utc_msc: 1784185200000 + minute * 60000, timezone_offset_minutes: 180,
  clock_status: 'verified', open: close - 1, high: close + 1, low: close - 2,
  close, tick_volume: 100, spread: 2,
})

describe('platform market data', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bridge.activeId.mockResolvedValue(1)
    bridge.clock.mockReturnValue({ connected: true, timezone_offset_minutes: 180, clock_status: 'verified', clock_residual_ms: 15, broker_server: 'Demo', account_login: 123456 })
    db.queryOne.mockResolvedValue({ id: 9 })
    db.queryAll.mockResolvedValue([])
    db.queryRun.mockResolvedValue({ changes: 1, insertId: 1 })
    redis.get.mockResolvedValue(null)
    redis.set.mockResolvedValue(undefined)
  })

  it('persists only closed bars and returns the current bar as uncached live data', async () => {
    mt5Bridge.mockResolvedValue({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(0, 2000), rate(1, 2001), rate(2, 2002)] })
    const result = await getPlatformRates(7, { symbol: 'XAUUSD', timeframe: 'M1', count: 3 })
    expect(mt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ symbol: 'XAUUSD' }), expect.objectContaining({ noFallback: true }))
    const candleWrites = db.queryRun.mock.calls.filter(([sql]) => sql.includes('INSERT INTO market_candles'))
    expect(candleWrites).toHaveLength(1)
    expect(candleWrites[0][1]).toHaveLength(24)
    expect(result.rates.at(-1).close).toBe(2002)
    expect(result.market_meta).toMatchObject({ source: 'platform_admin_bridge', timezone_offset_minutes: 180, closed_candles_written: 2, live_candle_cached: false })
    expect(db.queryRun).toHaveBeenCalledWith(expect.stringContaining('account_login'), expect.arrayContaining([1, 'Demo', '123456', 'demo|123456']))
  })

  it('drops malformed OHLC rows before persistence and response merging', async () => {
    const malformed = { ...rate(1, 2001), high: null }
    mt5Bridge.mockResolvedValue({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(0, 2000), malformed, rate(2, 2002)] })
    const result = await getPlatformRates(7, { symbol: 'XAUUSD', timeframe: 'M1', count: 3 })
    const candleWrites = db.queryRun.mock.calls.filter(([sql]) => sql.includes('INSERT INTO market_candles'))
    expect(candleWrites).toHaveLength(1)
    expect(candleWrites[0][1]).toHaveLength(12)
    expect(result.rates.map(item => item.close)).toEqual([2000, 2002])
  })

  it('uses the Redis hot cache and only refreshes the newest MT5 bars', async () => {
    redis.get.mockResolvedValue([rate(0, 2000), rate(1, 2001)])
    mt5Bridge.mockResolvedValue({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(1, 2001), rate(2, 2002), rate(3, 2003)] })
    const result = await getPlatformRates(7, { symbol: 'XAUUSD', timeframe: 'M1', count: 3 })
    expect(mt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ count: 3 }), expect.any(Object))
    expect(db.queryAll.mock.calls.some(([sql]) => sql.includes('FROM market_candles'))).toBe(false)
    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining('market:candles:v2:9:XAUUSD:M1'), expect.any(Array), 86400)
    expect(result.market_meta.cache_layer).toBe('redis')
    expect(result.rates.at(-1).close).toBe(2003)
  })

  it('refills the requested window when a reconnect probe no longer overlaps the cache', async () => {
    redis.get.mockResolvedValue([rate(0, 2000), rate(1, 2001)])
    mt5Bridge
      .mockResolvedValueOnce({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(8, 2008), rate(9, 2009), rate(10, 2010)] })
      .mockResolvedValueOnce({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(7, 2007), rate(8, 2008), rate(9, 2009), rate(10, 2010)] })
    const result = await getPlatformRates(7, { symbol: 'XAUUSD', timeframe: 'M1', count: 3 })
    expect(mt5Bridge).toHaveBeenCalledTimes(2)
    expect(mt5Bridge).toHaveBeenNthCalledWith(1, 1, 'rates', expect.objectContaining({ count: 3 }), expect.any(Object))
    expect(mt5Bridge).toHaveBeenNthCalledWith(2, 1, 'rates', expect.objectContaining({ count: 4 }), expect.any(Object))
    expect(result.rates.map(item => item.close)).toEqual([2008, 2009, 2010])
    expect(result.market_meta).toMatchObject({ cache_gap_refilled: true, closed_candles_written: 3 })
    const saved = redis.set.mock.calls.at(-1)[1]
    expect(saved.map(item => item.close)).toEqual([2007, 2008, 2009])
  })

  it('refills when the probe overlaps an old candle but misses the cached boundary', async () => {
    redis.get.mockResolvedValue([rate(0, 2000), rate(1, 2001), rate(2, 2002)])
    mt5Bridge
      .mockResolvedValueOnce({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(0, 2000), rate(8, 2008), rate(9, 2009)] })
      .mockResolvedValueOnce({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(7, 2007), rate(8, 2008), rate(9, 2009), rate(10, 2010), rate(11, 2011)] })
    const result = await getPlatformRates(7, { symbol: 'XAUUSD', timeframe: 'M1', count: 4 })
    expect(mt5Bridge).toHaveBeenCalledTimes(2)
    expect(mt5Bridge).toHaveBeenNthCalledWith(2, 1, 'rates', expect.objectContaining({ count: 5 }), expect.any(Object))
    expect(result.market_meta.cache_gap_refilled).toBe(true)
    expect(result.rates.map(item => item.close)).toEqual([2008, 2009, 2010, 2011])
  })

  it('uses a partial hot cache as the baseline and refreshes the full window', async () => {
    redis.get.mockResolvedValue([rate(0, 2000)])
    mt5Bridge.mockResolvedValue({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(1, 2001), rate(2, 2002), rate(3, 2003), rate(4, 2004)] })
    const result = await getPlatformRates(7, { symbol: 'XAUUSD', timeframe: 'M1', count: 3 })
    expect(db.queryAll.mock.calls.some(([sql]) => sql.includes('FROM market_candles'))).toBe(false)
    expect(mt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ count: 4 }), expect.any(Object))
    expect(result.market_meta.cache_layer).toBe('redis_partial')
    expect(result.rates.map(item => item.close)).toEqual([2002, 2003, 2004])
  })

  it('falls back to the requesting user only when no administrator market bridge is active', async () => {
    bridge.activeId.mockResolvedValue(null)
    mt5Bridge.mockResolvedValue({ status: 'success', symbol: 'EURUSD', rates: [rate(0, 1.1)] })
    const result = await getPlatformRates(7, { symbol: 'EURUSD', timeframe: 'M5', count: 10 })
    expect(mt5Bridge).toHaveBeenCalledWith(7, 'rates', expect.any(Object), expect.objectContaining({ noFallback: true }))
    expect(result.market_meta).toMatchObject({ source: 'user_bridge_fallback', source_user_id: 7, live_candle_cached: false })
  })
})
