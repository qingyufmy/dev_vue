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

  it('binds platform review data to the active observer source for that strategy', () => {
    const result = periodMarketSourceAuthorization({
      userId:29,
      strategyId:3,
      strategyScope:'platform',
      tradingAccountId:12,
    })
    expect(result.mode).toBe('platform_observer_source')
    expect(result.sql).toContain('ai_observer_sources')
    expect(result.sql).toContain("review_source.status = 'active'")
    expect(result.sql).toContain('review_source.bridge_user_id = mds.bridge_user_id')
    expect(result.params).toEqual([3])
    expect(result.sql).not.toContain("u.role = 'admin'")
  })

  it('uses the scope-aware authorization before reading an exact cached source', async () => {
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
    expect(sql).toContain('review_source.strategy_id = ?')
    expect(sql).not.toContain("WHERE u.role = 'admin'")
    expect(params).toEqual([3, 'XAUUSD', 'H1', 17])
    expect(market.platformRates).not.toHaveBeenCalled()
  })

  it('rejects a Bridge-hydrated source that is outside the frozen observer authorization', async () => {
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    market.platformRates.mockResolvedValueOnce({ status:'success', market_meta:{ source_id:91,
      source_key:'mt5|other-broker|9002' } })

    await expect(loadPeriodMarketWindow(29, 'XAUUSD', 'H1', start, end, {
      sourceId:17,
      strategyId:3,
      strategyScope:'platform',
      tradingAccountId:12,
      strictSessionPolicy:true,
    })).rejects.toThrow('period_market_source_unauthorized')

    const [sql, params] = db.queryOne.mock.calls[1]
    expect(sql).toContain('review_source.strategy_id = ?')
    expect(sql).toContain('AND mds.id = ? AND mds.id = ?')
    expect(params).toEqual([3, 91, 17])
    expect(db.queryAll).not.toHaveBeenCalled()
  })

  it('re-authorizes an exact Bridge-hydrated source before reading its candles', async () => {
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
    const [sql, params] = db.queryOne.mock.calls[1]
    expect(sql).toContain('review_source.strategy_id = ?')
    expect(sql).toContain('AND mds.id = ? AND mds.source_key = ?')
    expect(params).toEqual([3, 17, 'mt5|broker-demo|9001'])
  })
})
