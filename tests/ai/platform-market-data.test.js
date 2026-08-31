import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ queryAll: vi.fn(), queryOne: vi.fn(), queryRun: vi.fn(), withTransaction: vi.fn() }))
const bridge = vi.hoisted(() => ({ activeId: vi.fn(), clock: vi.fn(), dataRoute: vi.fn() }))
const mt5Bridge = vi.hoisted(() => vi.fn())
const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }))

vi.mock('../../server/db.js', () => db)
vi.mock('../../server/bridge-ws.js', () => ({
  getActivePlatformBridgeUserId: bridge.activeId,
  getBridgeDataRoute: bridge.dataRoute,
  getPlatformMarketClockState: bridge.clock,
}))
vi.mock('../../server/routes/ai/market-data.js', () => ({ mt5Bridge }))
vi.mock('../../server/redis.js', () => ({ cacheDel: redis.del, cacheGetJSON: redis.get, cacheSetJSON: redis.set }))

import { buildRatesRequestKey, getPlatformRates, inspectRateContinuity, saveChanStructureAnchor } from '../../server/routes/ai/platform-market-data.js'

const rate = (minute, close) => ({
  time: `2026-07-16 10:0${minute}:00`, time_msc: 1784196000000 + minute * 60000,
  time_utc_msc: 1784185200000 + minute * 60000, timezone_offset_minutes: 180,
  clock_status: 'verified', open: close - 1, high: close + 1, low: close - 2,
  close, tick_volume: 100, spread: 2,
})
const historicalRate = (index, close = 2000 + index) => ({
  ...rate(0, close),
  time: '2026-07-16 10:00:00',
  time_msc: 1784196000000 + index * 60000,
  time_utc_msc: 1784185200000 + index * 60000,
})

describe('platform market data', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bridge.activeId.mockResolvedValue(1)
    bridge.dataRoute.mockReturnValue(null)
    bridge.clock.mockReturnValue({ connected: true, platform:'mt5', timezone_offset_minutes: 180, clock_status: 'verified', clock_residual_ms: 15, broker_server: 'Demo', account_login: 123456 })
    db.queryOne.mockResolvedValue({ id: 9 })
    db.queryAll.mockResolvedValue([])
    db.queryRun.mockResolvedValue({ changes: 1, insertId: 1 })
    db.withTransaction.mockImplementation(async callback => callback(vi.fn().mockResolvedValue([[], []])))
    redis.get.mockResolvedValue(null)
    redis.set.mockResolvedValue(undefined)
    redis.del.mockResolvedValue(undefined)
  })

  it('does not coalesce review hydration with a smaller live request', () => {
    const live = buildRatesRequestKey(7, 1, { symbol:'XAUUSD', timeframe:'M1', count:1000 })
    const review = buildRatesRequestKey(7, 1, { symbol:'XAUUSD', timeframe:'M1', count:1642, review_window:true,
      start_utc_msc:1784185200000, end_utc_msc:1784271600000 })
    expect(live).not.toBe(review)
    expect(review).toContain(':review:1784185200000-1784271600000:1642')
  })

  it('does not coalesce MT4 and MT5 requests for the same broker account', () => {
    const base = { symbol:'XAUUSD', timeframe:'M5', count:2000 }
    const mt4 = buildRatesRequestKey(7, 1, { ...base, market_platform_hint:'mt4' })
    const mt5 = buildRatesRequestKey(7, 1, { ...base, market_platform_hint:'mt5' })
    expect(mt4).not.toBe(mt5)
    expect(mt4).toContain(':mt4:XAUUSD:M5:')
    expect(mt5).toContain(':mt5:XAUUSD:M5:')
  })

  it('does not hide a single missing candle merely because broker dates changed', () => {
    const before = { ...rate(0, 2000), time:'2026-07-16 23:55:00', time_utc_msc:1784231700000 }
    const after = { ...rate(1, 2001), time:'2026-07-17 00:05:00', time_utc_msc:before.time_utc_msc + 10 * 60000 }
    const integrity = inspectRateContinuity([before, after], 'M5')
    expect(integrity.status).toBe('suspicious_gap')
    expect(integrity.suspicious_gaps[0].missing_bar_count).toBe(1)
  })

  it('does not treat an eight-hour weekday gap as a market closure', () => {
    const startUtc = Date.parse('2026-07-14T04:00:00Z')
    const weekdayGap = [
      { ...rate(0, 2000), time:'2026-07-14 07:00:00', time_utc_msc:startUtc },
      { ...rate(1, 2001), time:'2026-07-14 15:00:00', time_utc_msc:startUtc + 8 * 60 * 60 * 1000 },
    ]
    expect(inspectRateContinuity(weekdayGap, 'H4')).toMatchObject({
      status:'suspicious_gap',
      suspicious_gaps:[expect.objectContaining({ missing_bar_count:1 })],
    })
    expect(inspectRateContinuity(weekdayGap, 'H1')).toMatchObject({
      status:'suspicious_gap',
      suspicious_gaps:[expect.objectContaining({ missing_bar_count:7 })],
    })
  })

  it('freezes the exact session policy identity even when a window has no gaps', () => {
    const policyEnv = {
      AI_MARKET_SESSION_POLICY_MODE:'enforce',
      AI_MARKET_SESSION_POLICIES_JSON:JSON.stringify([{
        policy_id:'demo-metals', version:1, platform:'mt5', broker_server:'Demo', symbols:['XAUUSD'],
        daily_closures:[{ weekdays:[1, 2, 3, 4, 5], from:'00:00', to:'01:00' }],
      }]),
    }
    const intact = inspectRateContinuity([rate(0, 2000), rate(1, 2001)], 'M1', {
      standardSymbol:'XAUUSD', platform:'mt5', brokerServer:'Demo', clockStatus:'verified', env:policyEnv,
    })
    expect(intact).toMatchObject({ status:'ok', policy_match:true, policy:{ mode:'enforce', matched:true,
      policy_id:'demo-metals', policy_version:1, policy_hash:expect.any(String) } })
  })

  it('fails closed for a gap that continues after the Sunday session opens', () => {
    const sundayOpen = Date.parse('2026-07-19T22:00:00Z')
    const integrity = inspectRateContinuity([
      { ...rate(0, 2000), time:'2026-07-19 21:00:00', time_utc_msc:sundayOpen - 3600000 },
      { ...rate(1, 2001), time:'2026-07-19 23:00:00', time_utc_msc:sundayOpen + 3600000 },
    ], 'H1', { standardSymbol:'XAUUSD', timezoneOffsetMinutes:0, clockStatus:'verified', strictSessionPolicy:true })
    expect(integrity).toMatchObject({
      status:'suspicious_gap', continuity_status:'suspicious_gap',
      suspicious_gaps:[expect.objectContaining({ missing_bar_count:1 })],
    })
  })

  it('exposes unknown session policy when strict continuity lacks clock and timezone evidence', () => {
    const startUtc = Date.parse('2026-07-14T04:00:00Z')
    const integrity = inspectRateContinuity([
      { ...rate(0, 2000), time_utc_msc:startUtc },
      { ...rate(1, 2001), time_utc_msc:startUtc + 8 * 60 * 60 * 1000 },
    ], 'H4', { standardSymbol:'XAUUSD', strictSessionPolicy:true })
    expect(integrity).toMatchObject({ status:'suspicious_gap', continuity_status:'unknown_session', continuity_reason:'market_session_policy_unavailable' })
  })

  it('classifies only verified metal holiday windows and keeps other symbols suspicious', () => {
    const beforeUtc = Date.parse('2025-12-24T17:00:00Z')
    const afterUtc = Date.parse('2025-12-25T21:00:00Z')
    const rows = [
      { ...rate(0, 2000), time:'2025-12-24 17:00:00', time_utc_msc:beforeUtc },
      { ...rate(1, 2001), time:'2025-12-25 21:00:00', time_utc_msc:afterUtc },
    ]
    expect(inspectRateContinuity(rows, 'H4', { standardSymbol:'XAUUSD' })).toMatchObject({
      status:'ok',
      expected_closures:[expect.objectContaining({ classification:'holiday_closure', reason:'christmas_closure' })],
    })
    expect(inspectRateContinuity(rows, 'H4', { standardSymbol:'EURUSD' })).toMatchObject({
      status:'suspicious_gap', suspicious_gaps:[expect.objectContaining({ missing_bar_count:6 })],
    })
  })

  it('reports duplicate candle open times instead of silently deduplicating them', () => {
    const duplicate = { ...rate(0, 2001), close:2001 }
    const integrity = inspectRateContinuity([rate(0, 2000), duplicate, rate(1, 2002)], 'M1')
    expect(integrity).toMatchObject({
      status:'suspicious_gap',
      suspicious_gaps:[expect.objectContaining({ reason:'duplicate_open_time', missing_bar_count:0 })],
    })
  })

  it('keeps the fixed M15 Chan bootstrap request intact', async () => {
    const key = buildRatesRequestKey(7, 1, { symbol:'XAUUSD', timeframe:'M15', count:1000 })
    expect(key).toContain(':live:current:1000')
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] })

    await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M15', count:1000 })

    expect(mt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ count:1001 }), expect.any(Object))
  })

  it('uses the default observer source for a supported browser symbol', async () => {
    db.queryOne.mockImplementation(async sql => {
      if (sql.includes('FROM ai_observer_channels')) {
        return { bridge_user_id:1, trading_account_id:91, symbols_json:'["XAUUSD"]' }
      }
      return { id:9 }
    })
    bridge.dataRoute.mockReturnValue({
      terminal_instance_id:'observer-terminal-91',
      account_ref:{ broker_server:'Broker-Demo', login:'860058' },
    })
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.s', rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] })

    const result = await getPlatformRates(7, {
      symbol:'XAUUSD', timeframe:'M1', count:3, browser_market_view:true,
    })

    expect(bridge.dataRoute).toHaveBeenCalledWith(1, 91, { strictAccount:true })
    expect(mt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({
      symbol:'XAUUSD',
      terminal_instance_id:'observer-terminal-91',
      account_ref:{ broker_server:'Broker-Demo', login:'860058' },
    }), expect.any(Object))
    expect(result.market_meta.source).toBe('platform_admin_bridge')
  })

  it('uses the ordinary user bridge only when the selected symbol is outside the default source', async () => {
    db.queryOne.mockImplementation(async sql => {
      if (sql.includes('FROM ai_observer_channels')) {
        return { bridge_user_id:1, symbols_json:'["XAUUSD"]' }
      }
      return { id:9 }
    })
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'EURUSD', rates:[rate(0, 10.1), rate(1, 10.2), rate(2, 10.3)] })

    const result = await getPlatformRates(7, {
      symbol:'EURUSD', timeframe:'M1', count:3, browser_market_view:true,
    })

    expect(mt5Bridge).toHaveBeenCalledWith(7, 'rates', expect.objectContaining({ symbol:'EURUSD' }), expect.any(Object))
    expect(result.market_meta.source).toBe('user_bridge_fallback')
  })

  it('keeps an explicit user account route on fallback D1 requests', async () => {
    bridge.activeId.mockResolvedValue(null)
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.s',
      rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] })
    const platformRoute = {
      terminal_instance_id:'user-terminal-11',
      account_ref:{ broker_server:'Broker-Demo', login:'12345' },
      platform:'mt5',
    }

    const result = await getPlatformRates(7, {
      symbol:'XAUUSD.s', timeframe:'D1', count:3, prefer_user_source:true,
      platform_trading_account_id:11, platform_route:platformRoute,
    })

    expect(bridge.clock).toHaveBeenCalledWith(7, 11)
    expect(mt5Bridge).toHaveBeenCalledWith(7, 'rates', expect.objectContaining({
      symbol:'XAUUSD.s', timeframe:'D1', terminal_instance_id:'user-terminal-11',
      account_ref:platformRoute.account_ref,
    }), expect.any(Object))
    expect(result.market_meta.source).toBe('user_bridge_fallback')
  })

  it('does not silently fall back when the configured default source is offline', async () => {
    db.queryOne.mockImplementation(async sql => {
      if (sql.includes('FROM ai_observer_channels')) {
        return { bridge_user_id:1, symbols_json:'["XAUUSD"]' }
      }
      return { id:9 }
    })
    bridge.activeId.mockResolvedValue(null)

    const result = await getPlatformRates(7, {
      symbol:'XAUUSD', timeframe:'M1', count:3, browser_market_view:true,
    })

    expect(result).toMatchObject({ status:'error', error:'observer_source_offline' })
    expect(mt5Bridge).not.toHaveBeenCalled()
  })

  it('hydrates an exact historical review range without dropping its final closed bar', async () => {
    const start = rate(0, 2000).time_utc_msc
    const end = rate(2, 2002).time_utc_msc + 60000
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', range_complete:true,
      rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] })
    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:20,
      review_window:true, start_utc_msc:start, end_utc_msc:end })
    expect(mt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({
      start_utc_msc:start, end_utc_msc:end,
    }), expect.objectContaining({ timeoutMs:30000, noFallback:true }))
    expect(result.rates.map(item => item.close)).toEqual([2000, 2001, 2002])
    expect(result.market_meta).toMatchObject({ source:'platform_admin_bridge_range', cache_layer:'exact_range', closed_candles_written:3,
      range_confirmation_basis:'actual_returned_closed_rates', range_response_endpoints_verified:false,
      range_complete_reported:true })
    expect(redis.set).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['false', false],
  ])('accepts an exact historical review range when Bridge range_complete is %s but returned closed rates are valid', async (_label, rangeComplete) => {
    const start = rate(0, 2000).time_utc_msc
    const end = rate(2, 2002).time_utc_msc + 60000
    const response = { status:'success', symbol:'XAUUSD.a', rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] }
    if (rangeComplete !== undefined) response.range_complete = rangeComplete
    mt5Bridge.mockResolvedValue(response)

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:20,
      review_window:true, start_utc_msc:start, end_utc_msc:end })

    expect(result.status).toBe('success')
    expect(result.market_meta).toMatchObject({
      range_confirmation_basis:'actual_returned_closed_rates',
      range_response_endpoints_verified:false,
      range_complete_reported:rangeComplete ?? null,
    })
  })

  it('accepts a legacy Bridge false flag with null endpoint echoes using actual closed rates', async () => {
    const start = rate(0, 2000).time_utc_msc
    const end = rate(2, 2002).time_utc_msc + 60000
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', range_complete:false,
      range_start_utc_msc:null, range_end_utc_msc:null,
      rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:20,
      review_window:true, start_utc_msc:start, end_utc_msc:end })

    expect(result).toMatchObject({ status:'success' })
    expect(result.market_meta).toMatchObject({
      range_confirmation_basis:'actual_returned_closed_rates',
      range_response_endpoints_verified:false, range_complete_reported:false,
    })
  })

  it('applies the same exact-range audit to the user Bridge fallback', async () => {
    bridge.activeId.mockResolvedValue(null)
    const start = rate(0, 2000).time_utc_msc
    const end = rate(2, 2002).time_utc_msc + 60000
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', range_complete:false,
      range_start_utc_msc:start, range_end_utc_msc:end,
      rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:20,
      review_window:true, start_utc_msc:start, end_utc_msc:end })

    expect(result.market_meta).toMatchObject({
      source:'user_bridge_fallback', range_confirmation_basis:'actual_returned_closed_rates',
      range_response_endpoints_verified:true, range_complete_reported:false,
      range_start_utc_msc:start, range_end_utc_msc:end,
    })
  })

  it('accepts an authoritative range whose requested start falls in a market closure', async () => {
    const first = rate(0, 2000)
    const start = first.time_utc_msc - 2 * 86400_000
    const end = rate(2, 2002).time_utc_msc + 60_000
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', range_complete:true,
      rates:[first, rate(1, 2001), rate(2, 2002)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:20,
      review_window:true, start_utc_msc:start, end_utc_msc:end })

    expect(result.status).toBe('success')
    expect(result.rates.map(item => item.close)).toEqual([2000, 2001, 2002])
    expect(result.market_meta).toMatchObject({
      range_bridge_authoritative:true,
      range_coverage_verified:true,
      endpoint_coverage_verified:false,
      range_start_open_time_matched:false,
    })
  })

  it('marks an exact Bridge range gap as a verified source gap', async () => {
    const start = rate(0, 2000).time_utc_msc
    const end = rate(4, 2004).time_utc_msc
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', range_complete:true,
      rates:[rate(0, 2000), rate(1, 2001), rate(3, 2003)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:20,
      review_window:true, start_utc_msc:start, end_utc_msc:end })

    expect(result.market_meta).toMatchObject({
      cache_internal_gap_detected:true,
      cache_internal_gap_status:'verified_source_gap',
      cache_internal_gap_verified_source:true,
      cache_internal_gap_unresolved:false,
      range_bridge_authoritative:true,
    })
    expect(result.market_meta.cache_internal_gap_details).toHaveLength(1)
  })

  it.each([
    { range_start_utc_msc:rate(0, 2000).time_utc_msc + 60000, range_end_utc_msc:rate(2, 2002).time_utc_msc + 60000 },
    { range_start_utc_msc:rate(0, 2000).time_utc_msc },
    { range_start_utc_msc:null, range_end_utc_msc:rate(2, 2002).time_utc_msc + 60000 },
  ])('rejects an exact Bridge range response with invalid or mismatched echoed endpoints', async responseRange => {
    const start = rate(0, 2000).time_utc_msc
    const end = rate(2, 2002).time_utc_msc + 60000
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', range_complete:false,
      ...responseRange, rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:20,
      review_window:true, start_utc_msc:start, end_utc_msc:end })

    expect(result).toMatchObject({ status:'error', error:'rates_range_response_mismatch' })
  })

  it('does not replace a failed exact review range with unrelated live candles', async () => {
    const start = rate(0, 2000).time_utc_msc
    const end = rate(4, 2004).time_utc_msc
    mt5Bridge.mockResolvedValue({ status:'error', error:'terminal_range_unavailable', message:'范围不可用' })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:20,
      review_window:true, start_utc_msc:start, end_utc_msc:end })

    expect(result).toMatchObject({ status:'error', error:'terminal_range_unavailable' })
    expect(mt5Bridge).toHaveBeenCalledTimes(1)
    expect(mt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({
      start_utc_msc:start, end_utc_msc:end,
    }), expect.any(Object))
  })

  it('returns an explicit empty-range error without issuing a live fallback request', async () => {
    const start = rate(0, 2000).time_utc_msc
    const end = rate(4, 2004).time_utc_msc
    mt5Bridge.mockResolvedValue({ status:'success', rates:[] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:20,
      review_window:true, start_utc_msc:start, end_utc_msc:end })

    expect(result).toMatchObject({ status:'error', error:'rates_range_empty' })
    expect(mt5Bridge).toHaveBeenCalledTimes(1)
  })

  it('does not persist or return a still-forming bar from an exact range request', async () => {
    const liveOpen = Math.floor(Date.now() / 60000) * 60000
    const rates = [-2, -1, 0].map((offset, index) => ({
      ...rate(index, 2000 + index),
      time_utc_msc:liveOpen + offset * 60000,
    }))
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', range_complete:true, rates })
    const result = await getPlatformRates(7, {
      symbol:'XAUUSD', timeframe:'M1', count:20, review_window:true,
      start_utc_msc:liveOpen - 2 * 60000,
      end_utc_msc:liveOpen + 60000,
    })
    expect(result.rates.map(item => item.close)).toEqual([2000, 2001])
    expect(result.market_meta).toMatchObject({
      source:'platform_admin_bridge_range',
      closed_candles_written:2,
      last_bar_closed:true,
    })
    const candleWrites = db.queryRun.mock.calls.filter(([sql]) => sql.includes('INSERT INTO market_candles'))
    expect(candleWrites).toHaveLength(1)
    expect(candleWrites[0][1]).toHaveLength(24)
  })

  it('rejects unrelated live candles when an exact range has no closed rates', async () => {
    const liveOpen = Math.floor(Date.now() / 60000) * 60000
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', range_complete:false,
      rates:[{ ...rate(0, 2000), time_utc_msc:liveOpen }] })
    const result = await getPlatformRates(7, {
      symbol:'XAUUSD', timeframe:'M1', count:20, review_window:true,
      start_utc_msc:liveOpen - 5 * 60000, end_utc_msc:liveOpen - 2 * 60000,
    })
    expect(result).toMatchObject({ status:'error' })
    expect(mt5Bridge).toHaveBeenCalledTimes(1)
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
    expect(db.queryRun).toHaveBeenCalledWith(expect.stringContaining('account_login'), expect.arrayContaining([1, 'Demo', '123456', 'mt5|demo|123456']))
  })

  it('never persists an observer bootstrap offset as the target terminal own clock', async () => {
    bridge.clock.mockReturnValue({
      connected:true, platform:'mt5', broker_server:'Demo', account_login:123456,
      timezone_offset_minutes:180, clock_status:'observer_bootstrap',
      clock_source:'default_observer_source', source_clock_status:'persisted_stale',
    })
    const historicalRates = [rate(0, 2000), rate(1, 2001), rate(2, 2002)].map(item => {
      const { timezone_offset_minutes, clock_status, ...withoutClock } = item
      return withoutClock
    })
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', rates:historicalRates })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:3 })

    const sourceWrite = db.queryRun.mock.calls.find(([sql]) => sql.includes('INSERT INTO market_data_sources'))
    expect(sourceWrite?.[0]).toContain("NULL, 'unknown', NULL, NULL")
    expect(sourceWrite?.[1]).toEqual([1, 'Demo', '123456', 'mt5|demo|123456'])
    expect(db.queryRun.mock.calls.some(([sql]) => sql.includes('INSERT INTO market_clock_samples'))).toBe(false)
    expect(result.market_meta).toMatchObject({
      timezone_offset_minutes:180, clock_status:'observer_bootstrap',
    })
  })

  it('derives broker time for MT4 rates that only expose server and UTC milliseconds', async () => {
    bridge.clock.mockReturnValue({ connected:true, timezone_offset_minutes:null,
      clock_status:'unknown', broker_server:'Demo', account_login:123456 })
    const mt4Rates = [rate(0, 2000), rate(1, 2001), rate(2, 2002)].map(item => {
      const { time, time_msc, timezone_offset_minutes, ...withoutLegacyTime } = item
      return { ...withoutLegacyTime, time_server_msc:item.time_utc_msc + 180 * 60000 }
    })
    mt5Bridge.mockResolvedValue({ status:'success', source:'mt4', symbol:'XAUUSD',
      timezone_offset_minutes:180, clock_status:'mt4_current_offset', clock_sample_age_ms:2500, rates:mt4Rates })
    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:3 })
    const candleWrite = db.queryRun.mock.calls.find(([sql]) => sql.includes('INSERT INTO market_candles'))
    expect(candleWrite).toBeTruthy()
    expect(candleWrite[1][5]).toBe('2026-07-16 10:00:00')
    expect(candleWrite[1][17]).toBe('2026-07-16 10:01:00')
    expect(db.queryRun).toHaveBeenCalledWith(expect.stringContaining('account_login'), expect.arrayContaining([
      1, 'Demo', '123456', 'mt4|demo|123456|offset:180',
    ]))
    expect(result.market_meta).toMatchObject({
      platform:'mt4', timezone_offset_minutes:180, clock_status:'mt4_current_offset',
      clock_sample_age_ms:2500,
    })
  })

  it('cold-refills MT4 candles and drops the old anchor when the current server offset changes', async () => {
    bridge.clock.mockReturnValue({ connected:true, platform:'mt4', timezone_offset_minutes:120,
      clock_status:'mt4_current_offset', broker_server:'Demo', account_login:123456 })
    redis.get.mockResolvedValue([rate(0, 1900), rate(1, 1901), rate(2, 1902)])
    mt5Bridge.mockResolvedValue({ status:'success', source:'mt4', symbol:'XAUUSD',
      timezone_offset_minutes:180, clock_status:'mt4_current_offset', clock_sample_age_ms:0,
      rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002), rate(3, 2003)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:3 })

    expect(mt5Bridge).toHaveBeenCalledTimes(2)
    expect(result.market_meta).toMatchObject({
      cache_layer:'cold', cache_gap_refilled:true, cache_source_identity_refilled:true,
      chan_structure_anchor_utc_msc:null, timezone_offset_minutes:180,
      clock_sample_age_ms:0,
    })
    expect(db.queryRun).toHaveBeenCalledWith(expect.stringContaining('account_login'), expect.arrayContaining([
      1, 'Demo', '123456', 'mt4|demo|123456|offset:180',
    ]))
  })

  it('reloads the Chan anchor from the final MT4 offset-scoped source after a refill', async () => {
    bridge.clock.mockReturnValue({ connected:true, platform:'mt4', timezone_offset_minutes:120,
      clock_status:'mt4_current_offset', clock_sample_age_ms:0, broker_server:'Demo', account_login:123456 })
    db.queryOne.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM market_data_sources')) {
        return { id:String(params?.[1]).endsWith('|offset:180') ? 10 : 9 }
      }
      if (sql.includes('FROM chan_structure_anchors')) {
        return Number(params?.[0]) === 10
          ? { anchor_time_utc_msc:1784188800000, last_confirmed_segment_time_utc_msc:1784192400000 }
          : { anchor_time_utc_msc:1784102400000, last_confirmed_segment_time_utc_msc:1784106000000 }
      }
      return null
    })
    redis.get.mockResolvedValue([rate(0, 1900), rate(1, 1901), rate(2, 1902)])
    mt5Bridge.mockResolvedValue({ status:'success', source:'mt4', symbol:'XAUUSD',
      timezone_offset_minutes:180, clock_status:'mt4_current_offset', clock_sample_age_ms:0,
      rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002), rate(3, 2003)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:3 })

    expect(result.market_meta).toMatchObject({
      source_id:10,
      cache_source_identity_refilled:true,
      chan_structure_anchor_utc_msc:1784188800000,
      chan_last_confirmed_segment_utc_msc:1784192400000,
    })
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('algorithm_version = ?'), [
      10, 'XAUUSD', 'M1', 'chan_structure_v8',
    ])
  })

  it('loads the final source anchor when the initial clock identity is unavailable', async () => {
    bridge.clock.mockReturnValue({ connected:true, platform:null, timezone_offset_minutes:null,
      clock_status:'unknown', broker_server:'Demo', account_login:123456 })
    db.queryOne.mockImplementation(async (sql) => {
      if (sql.includes('FROM market_data_sources')) return { id:10 }
      if (sql.includes('FROM chan_structure_anchors')) {
        return { anchor_time_utc_msc:1784188800000, last_confirmed_segment_time_utc_msc:1784192400000 }
      }
      return null
    })
    mt5Bridge.mockResolvedValue({ status:'success', source:'mt4', symbol:'XAUUSD',
      timezone_offset_minutes:180, clock_status:'mt4_current_offset', clock_sample_age_ms:0,
      rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:3 })

    expect(result.market_meta).toMatchObject({
      source_id:10,
      platform:'mt4',
      chan_structure_anchor_utc_msc:1784188800000,
      chan_last_confirmed_segment_utc_msc:1784192400000,
    })
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('algorithm_version = ?'), [
      10, 'XAUUSD', 'M1', 'chan_structure_v8',
    ])
  })

  it('keeps the final completed bar during a closed market instead of treating it as live', async () => {
    const completed = [
      { ...rate(0, 2000), captured_at_utc_msc: rate(2, 2002).time_utc_msc + 60000 },
      { ...rate(1, 2001), captured_at_utc_msc: rate(2, 2002).time_utc_msc + 60000 },
      { ...rate(2, 2002), captured_at_utc_msc: rate(2, 2002).time_utc_msc + 60000 },
    ]
    mt5Bridge.mockResolvedValue({ status: 'success', symbol: 'XAUUSD.a', rates: completed })
    const result = await getPlatformRates(7, { symbol: 'XAUUSD', timeframe: 'M1', count: 3 })
    const candleWrites = db.queryRun.mock.calls.filter(([sql]) => sql.includes('INSERT INTO market_candles'))
    expect(candleWrites).toHaveLength(1)
    expect(candleWrites[0][1]).toHaveLength(36)
    expect(result.rates.map(item => item.close)).toEqual([2000, 2001, 2002])
    expect(result.market_meta).toMatchObject({
      last_bar_closed: true,
      closed_candles_written: 3,
      live_candle_cached: false,
    })
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

  it('rejects future-shifted MT5 candles before persistence or response', async () => {
    const futureOpen = Date.now() + 3 * 60 * 60 * 1000
    const futureRates = [0, 1, 2].map((index) => ({
      ...rate(index, 2000 + index),
      time_utc_msc: futureOpen + index * 60000,
      time_msc: futureOpen + (180 + index) * 60000,
    }))
    mt5Bridge.mockResolvedValue({
      status:'success', symbol:'XAUUSD.a', rates:futureRates,
    })

    const result = await getPlatformRates(7, {
      symbol:'XAUUSD', timeframe:'M1', count:3,
    })

    expect(result).toMatchObject({ status:'error', error:'rates_timestamp_invalid' })
    expect(db.queryRun.mock.calls.some(([sql]) => sql.includes('INSERT INTO market_candles'))).toBe(false)
    expect(redis.set).not.toHaveBeenCalled()
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

  it('uses a complete terminal window even when the Redis cache write fails', async () => {
    redis.set.mockRejectedValueOnce(new Error('redis unavailable'))
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:3 })

    expect(result.status).toBe('success')
    expect(result.rates.map(item => item.close)).toEqual([2000, 2001, 2002])
    expect(result.market_meta).toMatchObject({
      cache_write_degraded:true,
      cache_write_failure_layers:['redis'],
    })
  })

  it('uses a complete terminal window even when candle persistence fails', async () => {
    db.queryRun.mockImplementation(async sql => {
      if (sql.includes('INSERT INTO market_candles')) throw new Error('mysql unavailable')
      return { changes:1, insertId:1 }
    })
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:3 })

    expect(result.status).toBe('success')
    expect(result.rates).toHaveLength(3)
    expect(result.market_meta).toMatchObject({
      closed_candles_written:0,
      cache_write_degraded:true,
      cache_write_failure_layers:['mysql'],
    })
  })

  it('does not let a three-bar probe truncate a larger chart cache', async () => {
    const hot = Array.from({ length:200 }, (_, index) => rate(index, 2000 + index))
    redis.get.mockResolvedValue(hot)
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', rates:[
      rate(198, 2198), rate(199, 2199), rate(200, 2200),
    ] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:3 })

    expect(result.rates.map(item => item.close)).toEqual([2198, 2199, 2200])
    const saved = redis.set.mock.calls.at(-1)[1]
    expect(saved).toHaveLength(200)
    expect(saved[0].close).toBe(2000)
    expect(saved.at(-1).close).toBe(2199)
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

  it('refills a suspicious intraday hole but accepts daily and weekend closures', async () => {
    db.queryOne.mockResolvedValue({ id:76 })
    const intraday = [rate(0, 2000), rate(1, 2001), rate(3, 2003)]
    const dailyClose = [
      { ...rate(0, 2000), time: '2026-07-16 23:55:00' },
      { ...rate(3, 2003), time: '2026-07-17 01:00:00', time_utc_msc: rate(0, 2000).time_utc_msc + 65 * 60000 },
    ]
    expect(inspectRateContinuity(intraday, 'M1').status).toBe('suspicious_gap')
    expect(inspectRateContinuity(dailyClose, 'M5')).toMatchObject({
      status: 'ok',
      expected_closures: [expect.objectContaining({ missing_bar_count: 12 })],
    })

    redis.get.mockResolvedValue(intraday)
    mt5Bridge
      .mockResolvedValueOnce({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(3, 2003), rate(4, 2004), rate(5, 2005)] })
      .mockResolvedValueOnce({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(0, 2000), rate(1, 2001), rate(3, 2003), rate(4, 2004)] })
    const result = await getPlatformRates(7, { symbol: 'XAUUSD', timeframe: 'M1', count: 3 })
    expect(mt5Bridge).toHaveBeenCalledTimes(2)
    expect(result.market_meta).toMatchObject({
      cache_gap_refilled: false,
      cache_boundary_gap_refilled: false,
      cache_internal_gap_detected: true,
      cache_internal_gap_status: 'verified_source_gap',
      cache_internal_gap_verified_source: true,
      cache_internal_gap_refill_attempted: false,
      cache_internal_gap_unresolved: false,
    })
  })

  it('accepts an administrator-cache gap verified by the same Bridge source', async () => {
    db.queryOne.mockResolvedValue({ id:77 })
    let cache = [rate(0, 2000), rate(1, 2001), rate(3, 2003), rate(4, 2004), rate(5, 2005)]
    redis.get.mockImplementation(async () => cache)
    redis.set.mockImplementation(async (_key, value) => { cache = value })
    mt5Bridge
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[rate(3, 2003), rate(4, 2004), rate(5, 2005)] })
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[
        rate(0, 2000), rate(1, 2001), rate(3, 2003), rate(4, 2004), rate(5, 2005), rate(6, 2006),
      ] })
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[rate(4, 2004), rate(5, 2005), rate(6, 2006)] })

    const first = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:5 })
    const second = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:5 })
    expect(first.market_meta).toMatchObject({
      cache_internal_gap_verified_source:true,
      cache_internal_gap_status:'verified_source_gap',
      cache_internal_gap_unresolved:false,
    })
    expect(second.market_meta).toMatchObject({
      cache_internal_gap_verified_source:true,
      cache_internal_gap_status:'verified_source_gap',
      cache_internal_gap_unresolved:false,
    })
    expect(second.market_meta.cache_internal_gap_details).toEqual([expect.objectContaining({ missing_bar_count:1 })])
    expect(mt5Bridge).toHaveBeenCalledTimes(3)
  })

  it('accepts a user-fallback cache gap verified by the same Bridge source', async () => {
    bridge.activeId.mockResolvedValue(null)
    db.queryOne.mockResolvedValue({ id:78 })
    let cache = [rate(0, 2000), rate(1, 2001), rate(3, 2003), rate(4, 2004), rate(5, 2005)]
    redis.get.mockImplementation(async () => cache)
    redis.set.mockImplementation(async (_key, value) => { cache = value })
    mt5Bridge
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[rate(3, 2003), rate(4, 2004), rate(5, 2005)] })
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[
        rate(0, 2000), rate(1, 2001), rate(3, 2003), rate(4, 2004), rate(5, 2005), rate(6, 2006),
      ] })
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[rate(4, 2004), rate(5, 2005), rate(6, 2006)] })

    const first = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:5 })
    const second = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:5 })

    expect(first.market_meta).toMatchObject({
      source:'user_bridge_fallback', cache_internal_gap_verified_source:true,
      cache_internal_gap_status:'verified_source_gap', cache_internal_gap_unresolved:false,
    })
    expect(second.market_meta).toMatchObject({
      source:'user_bridge_fallback', cache_internal_gap_verified_source:true,
      cache_internal_gap_status:'verified_source_gap', cache_internal_gap_unresolved:false,
    })
    expect(second.market_meta.cache_internal_gap_details).toEqual([expect.objectContaining({ missing_bar_count:1 })])
    expect(mt5Bridge).toHaveBeenCalledTimes(3)
  })

  it('persists a candle when Bridge fills a cached gap', async () => {
    db.queryOne.mockResolvedValue({ id:79 })
    redis.get.mockResolvedValue([rate(0, 2000), rate(1, 2001), rate(3, 2003), rate(4, 2004), rate(5, 2005)])
    mt5Bridge
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[rate(3, 2003), rate(4, 2004), rate(5, 2005)] })
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[
        rate(0, 2000), rate(1, 2001), rate(2, 2002), rate(3, 2003), rate(4, 2004),
      ] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:5 })

    expect(result).toMatchObject({ status:'success', market_meta: {
      cache_gap_refilled:true,
      cache_internal_gap_status:'filled',
      cache_internal_gap_verified_source:false,
      cache_internal_gap_unresolved:false,
    } })
    expect(redis.set.mock.calls.at(-1)[1].map(item => item.time_utc_msc))
      .toContain(rate(2, 2002).time_utc_msc)
    expect(mt5Bridge).toHaveBeenCalledTimes(2)
  })

  it('fails closed when Bridge cannot verify a cached gap', async () => {
    db.queryOne.mockResolvedValue({ id:80 })
    redis.get.mockResolvedValue([rate(0, 2000), rate(1, 2001), rate(3, 2003), rate(4, 2004), rate(5, 2005)])
    mt5Bridge
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[rate(3, 2003), rate(4, 2004), rate(5, 2005)] })
      .mockResolvedValueOnce({ status:'error', error:'bridge_unavailable' })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:5 })

    expect(result).toMatchObject({ status:'error', error:'rates_gap_verification_failed' })
    expect(result.market_meta).toBeUndefined()
  })

  it('splits distant cache gaps into bounded exact Bridge windows', async () => {
    db.queryOne.mockResolvedValue({ id:81 })
    const cache = [
      ...Array.from({ length:101 }, (_, index) => historicalRate(index)).filter((_, index) => index !== 2),
      ...Array.from({ length:702 }, (_, index) => historicalRate(1800 + index)),
      ...Array.from({ length:98 }, (_, index) => historicalRate(2503 + index)),
    ]
    redis.get.mockImplementation(async key => key.startsWith('market:verified-source-gap:') ? null : cache)
    mt5Bridge
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[
        historicalRate(2598), historicalRate(2599), historicalRate(2600),
      ] })
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[
        ...cache.filter(item => item.time_utc_msc >= historicalRate(1).time_utc_msc
          && item.time_utc_msc < historicalRate(1801).time_utc_msc),
      ] })
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[
        historicalRate(2501), historicalRate(2503),
      ] })

    const result = await getPlatformRates(7, {
      symbol:'XAUUSD', timeframe:'M1', count:3000, review_window:true,
    })

    expect(result.status).toBe('success')
    const exactCalls = mt5Bridge.mock.calls.filter(([, command, params]) => command === 'rates'
      && Number.isFinite(params.start_utc_msc))
    expect(exactCalls).toHaveLength(2)
    expect(exactCalls[0][2]).toMatchObject({
      start_utc_msc:historicalRate(1).time_utc_msc,
      end_utc_msc:historicalRate(1801).time_utc_msc,
      count:1801,
    })
    expect(exactCalls[1][2]).toMatchObject({
      start_utc_msc:historicalRate(2501).time_utc_msc,
      end_utc_msc:historicalRate(2504).time_utc_msc,
      count:4,
    })
    expect(result.market_meta).toMatchObject({
      cache_internal_gap_detected:true,
      cache_internal_gap_verified_source:true,
      cache_internal_gap_status:'verified_source_gap',
      cache_internal_gap_unresolved:false,
    })
  })

  it('verifies one long cache gap within the Bridge range limit', async () => {
    db.queryOne.mockResolvedValue({ id:86 })
    const cache = [historicalRate(0), historicalRate(3000)]
    redis.get.mockImplementation(async key => key.startsWith('market:verified-source-gap:') ? null : cache)
    mt5Bridge
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[
        historicalRate(3000), historicalRate(3001), historicalRate(3002),
      ] })
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', range_complete:true, rates:[
        historicalRate(0), historicalRate(3000),
      ] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:2000 })

    expect(result.status).toBe('success')
    const exactCalls = mt5Bridge.mock.calls.filter(([, command, params]) => command === 'rates'
      && Number.isFinite(params.start_utc_msc))
    expect(exactCalls).toHaveLength(1)
    expect(exactCalls[0][2]).toMatchObject({
      start_utc_msc:historicalRate(0).time_utc_msc,
      end_utc_msc:historicalRate(3001).time_utc_msc,
    })
    expect(exactCalls[0][2].count).toBeLessThanOrEqual(5000)
    expect(result.market_meta).toMatchObject({
      cache_internal_gap_detected:true,
      cache_internal_gap_verified_source:true,
      cache_internal_gap_status:'verified_source_gap',
      cache_internal_gap_unresolved:false,
    })
  })

  it('fails closed for a cache gap beyond the Bridge range limit', async () => {
    db.queryOne.mockResolvedValue({ id:87 })
    const cache = [historicalRate(0), historicalRate(5001)]
    redis.get.mockImplementation(async key => key.startsWith('market:verified-source-gap:') ? null : cache)
    mt5Bridge.mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[
      historicalRate(5001), historicalRate(5002), historicalRate(5003),
    ] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:2000 })

    expect(result).toMatchObject({ status:'error', error:'rates_gap_verification_window_invalid' })
    expect(mt5Bridge.mock.calls.filter(([, command, params]) => command === 'rates'
      && Number.isFinite(params.start_utc_msc))).toHaveLength(0)
  })

  it('reuses a valid Redis gap marker after the in-memory layer is empty', async () => {
    db.queryOne.mockResolvedValue({ id:82 })
    const cache = [historicalRate(0), historicalRate(1), historicalRate(3), historicalRate(4)]
    const gapFrom = historicalRate(1).time_utc_msc
    const gapTo = historicalRate(3).time_utc_msc
    const missing = historicalRate(2).time_utc_msc
    redis.get.mockImplementation(async key => key.startsWith('market:verified-source-gap:')
      ? {
          source_id:82, source_key:'mt5|demo|123456', symbol:'XAUUSD', timeframe:'M1',
          from_utc_msc:gapFrom, to_utc_msc:gapTo, verified_at:Date.now(), missing_times:[missing],
        }
      : cache)
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', rates:[
      historicalRate(3), historicalRate(4), historicalRate(5),
    ] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:4 })

    expect(result.status).toBe('success')
    expect(mt5Bridge).toHaveBeenCalledTimes(1)
    expect(mt5Bridge.mock.calls.some(([, command, params]) => command === 'rates'
      && Number.isFinite(params.start_utc_msc))).toBe(false)
    expect(redis.set.mock.calls.some(([key]) => key.startsWith('market:verified-source-gap:'))).toBe(false)
    expect(result.market_meta).toMatchObject({
      cache_internal_gap_verified_source:true,
      cache_internal_gap_status:'verified_source_gap',
      cache_internal_gap_unresolved:false,
    })
  })

  it.each(['invalid', 'expired'])('does not trust a Redis %s gap marker', async markerState => {
    const sourceId = markerState === 'invalid' ? 83 : 84
    db.queryOne.mockResolvedValue({ id:sourceId })
    const cache = [historicalRate(0), historicalRate(1), historicalRate(3), historicalRate(4)]
    const gapFrom = historicalRate(1).time_utc_msc
    const gapTo = historicalRate(3).time_utc_msc
    const missing = historicalRate(2).time_utc_msc
    redis.get.mockImplementation(async key => key.startsWith('market:verified-source-gap:')
      ? {
          source_id:sourceId, source_key:'mt5|demo|123456', symbol:'XAUUSD', timeframe:'M1',
          from_utc_msc:gapFrom, to_utc_msc:gapTo,
          verified_at:markerState === 'expired' ? Date.now() - 86400000 : Date.now(),
          missing_times:markerState === 'invalid' ? [gapTo] : [missing],
        }
      : cache)
    mt5Bridge
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[
        historicalRate(3), historicalRate(4), historicalRate(5),
      ] })
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[
        historicalRate(1), historicalRate(3),
      ] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:4 })

    expect(result.status).toBe('success')
    expect(mt5Bridge.mock.calls.some(([, command, params]) => command === 'rates'
      && Number.isFinite(params.start_utc_msc))).toBe(true)
    expect(redis.del).toHaveBeenCalledWith(expect.stringContaining(`market:verified-source-gap:v1:${sourceId}`))
  })

  it('fails closed when a later bounded gap-verification batch fails', async () => {
    db.queryOne.mockResolvedValue({ id:85 })
    const cache = [
      ...Array.from({ length:101 }, (_, index) => historicalRate(index)).filter((_, index) => index !== 2),
      ...Array.from({ length:702 }, (_, index) => historicalRate(1800 + index)),
      ...Array.from({ length:98 }, (_, index) => historicalRate(2503 + index)),
    ]
    redis.get.mockImplementation(async key => key.startsWith('market:verified-source-gap:') ? null : cache)
    mt5Bridge
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[
        historicalRate(2598), historicalRate(2599), historicalRate(2600),
      ] })
      .mockResolvedValueOnce({ status:'success', symbol:'XAUUSD.a', rates:[
        ...cache.filter(item => item.time_utc_msc >= historicalRate(1).time_utc_msc
          && item.time_utc_msc < historicalRate(1801).time_utc_msc),
      ] })
      .mockResolvedValueOnce({ status:'error', error:'bridge_unavailable' })

    const result = await getPlatformRates(7, {
      symbol:'XAUUSD', timeframe:'M1', count:3000, review_window:true,
    })

    expect(result).toMatchObject({ status:'error', error:'rates_gap_verification_failed' })
    expect(result.market_meta).toBeUndefined()
    expect(mt5Bridge.mock.calls.filter(([, command, params]) => command === 'rates'
      && Number.isFinite(params.start_utc_msc))).toHaveLength(2)
  })

  it('uses a partial hot cache as the baseline and refreshes the full window', async () => {
    redis.get.mockResolvedValue([rate(0, 2000)])
    mt5Bridge.mockResolvedValue({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(1, 2001), rate(2, 2002), rate(3, 2003), rate(4, 2004)] })
    const result = await getPlatformRates(7, { symbol: 'XAUUSD', timeframe: 'M1', count: 3 })
    expect(db.queryAll.mock.calls.some(([sql]) => sql.includes('FROM market_candles'))).toBe(true)
    expect(mt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ count: 4 }), expect.any(Object))
    expect(result.market_meta.cache_layer).toBe('redis_partial')
    expect(result.rates.map(item => item.close)).toEqual([2002, 2003, 2004])
  })

  it('falls back to the requesting user only when no administrator market bridge is active', async () => {
    bridge.activeId.mockResolvedValue(null)
    mt5Bridge.mockResolvedValue({ status: 'success', symbol: 'EURUSD', rates: [rate(0, 10.1)] })
    const result = await getPlatformRates(7, { symbol: 'EURUSD', timeframe: 'M5', count: 10 })
    expect(mt5Bridge).toHaveBeenCalledWith(7, 'rates', expect.any(Object), expect.objectContaining({ noFallback: true }))
    expect(result.market_meta).toMatchObject({ source: 'user_bridge_fallback', source_user_id: 7, live_candle_cached: false })
  })

  it('reuses the requesting users cached candles for a three-bar fallback probe', async () => {
    bridge.activeId.mockResolvedValue(null)
    redis.get.mockResolvedValue([rate(0, 2000), rate(1, 2001)])
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a', rates:[rate(1, 2001), rate(2, 2002), rate(3, 2003)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M1', count:3 })

    expect(mt5Bridge).toHaveBeenCalledWith(7, 'rates', expect.objectContaining({ count:3 }), expect.any(Object))
    expect(result.rates.map(item => item.close)).toEqual([2001, 2002, 2003])
    expect(result.market_meta).toMatchObject({
      source:'user_bridge_fallback', cache_layer:'redis', closed_candles_persisted:3,
    })
  })

  it('loads the requesting bridge account Chan anchor on user fallback', async () => {
    bridge.activeId.mockResolvedValue(null)
    db.queryOne.mockImplementation(async sql => {
      if (sql.includes('FROM market_data_sources')) return { id:17 }
      if (sql.includes('FROM chan_structure_anchors')) {
        return {
          anchor_time_utc_msc:1784185200000,
          last_confirmed_segment_time_utc_msc:1784188800000,
          bootstrap_core_stable_id:'core-a',
          bootstrap_entry_segment_stable_id:'entry-a',
          bootstrap_observation_time_utc_msc:1784189100000,
        }
      }
      return null
    })
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a',
      rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M5', count:3 })

    expect(bridge.clock).toHaveBeenCalledWith(7)
    expect(db.queryRun).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO market_data_sources'), [
      7, 'Demo', '123456', 'mt5|demo|123456', 180, 'verified', 15,
    ])
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('algorithm_version = ?'), [
      17, 'XAUUSD', 'M5', 'chan_structure_v8',
    ])
    expect(result.market_meta).toMatchObject({
      source:'user_bridge_fallback', source_user_id:7, source_id:17,
      chan_structure_anchor_utc_msc:1784185200000,
      chan_last_confirmed_segment_utc_msc:1784188800000,
      chan_structure_anchor_core_stable_id:'core-a',
      chan_structure_anchor_entry_segment_stable_id:'entry-a',
      chan_structure_anchor_observation_time_utc_msc:1784189100000,
    })
  })

  it('does not create a source for an unidentified requesting bridge fallback', async () => {
    bridge.activeId.mockResolvedValue(null)
    bridge.clock.mockReturnValue({ connected:true, timezone_offset_minutes:180,
      clock_status:'stale_or_unverified', broker_server:'unknown', account_login:0 })
    mt5Bridge.mockResolvedValue({ status:'success', symbol:'XAUUSD.a',
      rates:[rate(0, 2000), rate(1, 2001), rate(2, 2002)] })

    const result = await getPlatformRates(7, { symbol:'XAUUSD', timeframe:'M5', count:3 })

    expect(result.market_meta).toMatchObject({
      source:'user_bridge_fallback', source_user_id:7, source_id:null,
      chan_structure_anchor_utc_msc:null,
      chan_last_confirmed_segment_utc_msc:null,
    })
    expect(db.queryRun.mock.calls.some(([sql]) => sql.includes('INSERT INTO market_data_sources'))).toBe(false)
  })

  it('does not persist a temporary unknown source before the bridge publishes its account identity', async () => {
    bridge.clock.mockReturnValue({ connected: true, timezone_offset_minutes: 180, clock_status: 'stale_or_unverified', broker_server: 'unknown', account_login: 0 })
    mt5Bridge.mockResolvedValue({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(0, 2000), rate(1, 2001), rate(2, 2002)] })
    const result = await getPlatformRates(7, { symbol: 'XAUUSD', timeframe: 'M5', count: 3 })
    expect(result.rates).toHaveLength(3)
    expect(result.market_meta.source_id).toBeNull()
    expect(db.queryRun.mock.calls.some(([sql]) => sql.includes('INSERT INTO market_data_sources'))).toBe(false)
    expect(db.queryRun.mock.calls.some(([sql]) => sql.includes('INSERT INTO market_candles'))).toBe(false)
    expect(redis.set).not.toHaveBeenCalled()
  })

  it('returns and advances the persisted Chan structure anchor', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id: 9 })
      .mockResolvedValueOnce({
        anchor_time_utc_msc:1784185200000,
        last_confirmed_segment_time_utc_msc:1784188800000,
        bootstrap_core_stable_id:'core-a',
        bootstrap_entry_segment_stable_id:'entry-a',
        bootstrap_observation_time_utc_msc:1784189100000,
      })
      .mockResolvedValueOnce({ id: 9 })
    mt5Bridge.mockResolvedValue({ status: 'success', symbol: 'XAUUSD.a', rates: [rate(0, 2000), rate(1, 2001), rate(2, 2002)] })
    const result = await getPlatformRates(7, { symbol: 'XAUUSD', timeframe: 'M5', count: 3 })
    expect(result.market_meta).toMatchObject({
      chan_structure_anchor_utc_msc: 1784185200000,
      chan_last_confirmed_segment_utc_msc: 1784188800000,
      chan_structure_anchor_core_stable_id:'core-a',
      chan_structure_anchor_entry_segment_stable_id:'entry-a',
      chan_structure_anchor_observation_time_utc_msc:1784189100000,
    })
    await expect(saveChanStructureAnchor(9, 'XAUUSD.a', 'm5', {
      recommended_time_utc_msc: 1784185500000,
      last_confirmed_segment_time_utc_msc: 1784190000000,
      bootstrap_core_stable_id:'core-b',
      bootstrap_entry_segment_stable_id:'entry-b',
      bootstrap_observation_time_utc_msc:1784190300000,
    })).resolves.toBe(true)
    expect(db.queryRun).toHaveBeenCalledWith(expect.stringContaining('algorithm_version = VALUES(algorithm_version)'), [
      9, 'XAUUSD', 'M5', 'chan_structure_v8', 1784185500000, 1784190000000,
      'core-b', 'entry-b', 1784190300000,
    ])
    const anchorWriteSql = db.queryRun.mock.calls.find(([sql]) => sql.includes('INSERT INTO chan_structure_anchors'))?.[0]
    expect(anchorWriteSql).toContain('COALESCE(bootstrap_observation_time_utc_msc, 0) > VALUES(bootstrap_observation_time_utc_msc)')
    expect(anchorWriteSql).toContain('GREATEST(COALESCE(bootstrap_observation_time_utc_msc, 0), VALUES(bootstrap_observation_time_utc_msc))')
  })
})
