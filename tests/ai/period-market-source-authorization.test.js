import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ queryAll:vi.fn(), queryOne:vi.fn() }))
const market = vi.hoisted(() => ({
  calculateMarketData:vi.fn(() => ({})),
  platformRates:vi.fn(),
}))

vi.mock('../../server/db.js', () => db)
vi.mock('../../server/routes/ai/market-data.js', () => market)

import { loadPeriodMarketWindow, periodMarketSourceAuthorization } from '../../server/routes/ai/period-market-evidence.js'

describe('period review market source authorization', () => {
  const start = Date.parse('2026-07-20T00:00:00Z')
  const end = start + 2 * 3600000

  beforeEach(() => vi.clearAllMocks())

  it('binds private review data to the review owner and exact trading account', () => {
    const result = periodMarketSourceAuthorization({
      userId:7,
      strategyId:3,
      strategyScope:'private',
      tradingAccountId:12,
    })
    expect(result.mode).toBe('private_account')
    expect(result.sql).toContain('mds.bridge_user_id = ?')
    expect(result.sql).toContain('review_account.id = ?')
    expect(result.sql).toContain('review_account.user_id = ?')
    expect(result.params).toEqual([7, 12, 7])
  })

  it('treats platform review candles as shared market evidence, not observer-account data', () => {
    const result = periodMarketSourceAuthorization({
      userId:29,
      strategyId:3,
      strategyScope:'platform',
      tradingAccountId:12,
    })
    expect(result.mode).toBe('platform_shared_market')
    expect(result.sql).toContain('mds.clock_status IN')
    expect(result.sql).not.toContain('ai_observer_sources')
    expect(result.sql).not.toContain('account_login')
    expect(result.params).toEqual(['verified', 'calibrated', 'observer_bootstrap', 'mt4_current_offset'])
  })

  it('allows a complete cached candle window when its source identity differs from the observer', async () => {
    db.queryOne.mockResolvedValueOnce({ id:17, broker_server:'Broker-Demo', account_login:9001,
      source_key:'mt5|broker-demo|9001', timezone_offset_minutes:180, clock_status:'verified' })
    db.queryAll.mockResolvedValueOnce([
      { source_id:17, broker_time:'2026-07-20 03:00:00', time_utc_msc:start,
        open:1, high:2, low:0.5, close:1.5, tick_volume:10, spread:1 },
      { source_id:17, broker_time:'2026-07-20 04:00:00', time_utc_msc:start + 3600000,
        open:1.5, high:2.5, low:1, close:2, tick_volume:12, spread:1 },
    ])

    await loadPeriodMarketWindow(29, 'XAUUSD', 'H1', start, end, {
      sourceId:17,
      strategyId:3,
      strategyScope:'platform',
      tradingAccountId:12,
      strictSessionPolicy:true,
    })

    const [sql, params] = db.queryOne.mock.calls[0]
    expect(sql).toContain('mds.clock_status IN')
    expect(sql).not.toContain('ai_observer_sources')
    expect(params).toEqual(['verified', 'calibrated', 'observer_bootstrap', 'mt4_current_offset', 'XAUUSD', 'H1', 17])
    expect(market.platformRates).not.toHaveBeenCalled()
  })

  it('uses a complete canonical platform fallback and records the source change', async () => {
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id:91, broker_server:'Other-Broker', account_login:9002,
      source_key:'mt5|other-broker|9002', timezone_offset_minutes:180, clock_status:'verified' })
    market.platformRates.mockResolvedValueOnce({ status:'success', market_meta:{ source_id:91,
      source_key:'mt5|other-broker|9002' } })

    db.queryAll.mockResolvedValueOnce([
      { source_id:91, broker_time:'2026-07-20 03:00:00', time_utc_msc:start,
        open:1, high:2, low:0.5, close:1.5, tick_volume:10, spread:1 },
      { source_id:91, broker_time:'2026-07-20 04:00:00', time_utc_msc:start + 3600000,
        open:1.5, high:2.5, low:1, close:2, tick_volume:12, spread:1 },
    ])

    const loaded = await loadPeriodMarketWindow(29, 'XAUUSD', 'H1', start, end, {
      sourceId:17,
      strategyId:3,
      strategyScope:'platform',
      tradingAccountId:12,
      strictSessionPolicy:true,
    })

    expect(loaded.sourceId).toBe(91)
    expect(loaded.marketMeta.source_selection_changed).toBe(true)
    expect(loaded.marketMeta.source_selection_reason).toBe('canonical_platform_fallback')
    expect(loaded.marketMeta.selected_source_identity.source_id).toBe(91)
    const [sql, params] = db.queryOne.mock.calls[1]
    expect(sql).toContain('mds.clock_status IN')
    expect(sql).toContain("u.role = 'admin'")
    expect(sql).toContain('AND mds.id = ?')
    expect(sql).not.toContain('mds.source_key = ?')
    expect(params).toEqual(['verified', 'calibrated', 'observer_bootstrap', 'mt4_current_offset', 91])
    expect(db.queryAll).toHaveBeenCalledOnce()
    expect(db.queryAll.mock.calls[0][1][0]).toBe(91)
  })

  it('rechecks a canonical fallback source and keeps one source per window', async () => {
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id:17, broker_server:'Broker-Demo',
      account_login:9001, source_key:'mt5|broker-demo|9001', timezone_offset_minutes:180,
      clock_status:'verified' })
    market.platformRates.mockResolvedValueOnce({ status:'success', market_meta:{ source_id:17,
      source_key:'mt5|broker-demo|9001' } })
    db.queryAll.mockResolvedValueOnce([
      { source_id:17, broker_time:'2026-07-20 03:00:00', time_utc_msc:start,
        open:1, high:2, low:0.5, close:1.5, tick_volume:10, spread:1 },
      { source_id:17, broker_time:'2026-07-20 04:00:00', time_utc_msc:start + 3600000,
        open:1.5, high:2.5, low:1, close:2, tick_volume:12, spread:1 },
    ])

    const loaded = await loadPeriodMarketWindow(29, 'XAUUSD', 'H1', start, end, {
      sourceKey:'mt5|broker-demo|9001',
      strategyId:3,
      strategyScope:'platform',
      tradingAccountId:12,
      strictSessionPolicy:true,
    })

    expect(loaded.sourceId).toBe(17)
    expect(loaded.marketMeta.source_policy_version).toBe('shared-canonical-v1')
    expect(loaded.marketMeta.source_selection_changed).toBe(false)
    expect(loaded.marketMeta.selected_source_identity.source_id).toBe(17)
    const [sql, params] = db.queryOne.mock.calls[1]
    expect(sql).toContain('mds.clock_status IN')
    expect(sql).toContain('AND mds.id = ?')
    expect(sql).not.toContain('mds.source_key = ?')
    expect(params).toEqual(['verified', 'calibrated', 'observer_bootstrap', 'mt4_current_offset', 17])
    const candleQuery = db.queryAll.mock.calls[0]
    expect(candleQuery[0]).toContain('source_id IN (?)')
    expect(candleQuery[1][0]).toBe(17)
  })

  it('returns incomplete coverage instead of mixing another source into the same window', async () => {
    db.queryOne.mockResolvedValueOnce({ id:17, broker_server:'Broker-Demo', account_login:9001,
      source_key:'mt5|broker-demo|9001', timezone_offset_minutes:180, clock_status:'verified' })
    db.queryAll.mockResolvedValueOnce([
      { source_id:17, broker_time:'2026-07-20 03:00:00', time_utc_msc:start,
        open:1, high:2, low:0.5, close:1.5, tick_volume:10, spread:1 },
      // A different source is intentionally present in the mock response. The
      // SQL must select only source 17, and the loader must remain fail-closed.
    ])
    market.platformRates.mockResolvedValueOnce({ status:'error', error:'canonical_source_unavailable' })

    await expect(loadPeriodMarketWindow(29, 'XAUUSD', 'H1', start, end, {
      sourceCandidates:[{ source_id:17, source_key:'mt5|broker-demo|9001' }, { source_id:91, source_key:'mt5|other-broker|9002' }],
      strategyId:3,
      strategyScope:'platform',
      strictSessionPolicy:true,
    })).rejects.toThrow('canonical_source_unavailable')

    expect(db.queryAll.mock.calls[0][1][0]).toBe(17)
    expect(db.queryAll.mock.calls[0][1]).not.toContain(91)
  })

  it('restricts an unpinned shared-market cache lookup to the platform source', async () => {
    db.queryOne.mockResolvedValueOnce({ id:91, broker_server:'Platform-Broker', account_login:9002,
      source_key:'mt5|platform-broker|9002', timezone_offset_minutes:180, clock_status:'calibrated' })
    db.queryAll.mockResolvedValueOnce([
      { source_id:91, broker_time:'2026-07-20 03:00:00', time_utc_msc:start,
        open:1, high:2, low:0.5, close:1.5, tick_volume:10, spread:1 },
      { source_id:91, broker_time:'2026-07-20 04:00:00', time_utc_msc:start + 3600000,
        open:1.5, high:2.5, low:1, close:2, tick_volume:12, spread:1 },
    ])

    await loadPeriodMarketWindow(29, 'XAUUSD', 'H1', start, end, {
      strategyId:3,
      strategyScope:'platform',
      strictSessionPolicy:true,
    })

    const [sql] = db.queryOne.mock.calls[0]
    expect(sql).toContain("u.role = 'admin'")
  })
})
