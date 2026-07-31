import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ queryAll:vi.fn(), mt5Bridge:vi.fn() }))
vi.mock('../../server/db.js', () => ({ queryAll:mocks.queryAll }))
vi.mock('../../server/routes/ai/market-data.js', () => ({ mt5Bridge:mocks.mt5Bridge }))

import { loadPlatformReferencePortfolio } from '../../server/routes/ai/reference-portfolio.js'

describe('platform reference portfolio', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps only strategy-attributed system orders and strips account-sensitive fields', async () => {
    mocks.queryAll.mockResolvedValue([
      { outcome_id:21, signal_id:11, position_id:'P501', signal_type:'buy', original_stop_loss:1990,
        original_take_profits_json:'[2020,2030]', thesis_id:'thesis-11', management_group_id:'group-11', created_at:'2026-07-22 10:00:00' },
      { outcome_id:22, signal_id:12, pending_ticket:'601', signal_type:'sell_limit', original_stop_loss:2030,
        original_take_profits_json:'[1980]', thesis_id:'thesis-12', management_group_id:'group-12' },
    ])
    mocks.mt5Bridge.mockImplementation(async (_userId, action) => action === 'positions'
      ? { status:'success', positions:[
          { ticket:501, position_id:'P501', symbol:'XAUUSD.s', type:'buy', magic:234000, volume:0.5, profit:123, open_price:2000, price_current:2005, sl:1990, tp:2020 },
          { ticket:502, symbol:'XAUUSD.s', type:'buy', magic:999, volume:3, profit:999 },
        ] }
      : { status:'success', orders:[
          { ticket:601, symbol:'XAUUSD.s', pending_type:'sell_limit', magic:234000, volume:0.7, price:2020, sl:2030, tp:1980 },
          { ticket:602, symbol:'XAUUSD.s', pending_type:'buy_limit', magic:234000, volume:1, price:1900 },
        ] })

    const result = await loadPlatformReferencePortfolio({ strategyId:3, sourceUserId:7, symbol:'XAUUSD' })
    expect(result).toMatchObject({ strategy_id:3, symbol:'XAUUSD', position_count:1, pending_count:1 })
    expect(result.positions[0]).toMatchObject({ origin_signal_id:11, side:'buy', entry_price:2000,
      actual_stop_loss:1990, original_stop_loss:1990, thesis_id:'thesis-11' })
    expect(result.pending_orders[0]).toMatchObject({ origin_signal_id:12, side:'sell', trigger_price:2020,
      actual_stop_loss:2030, original_stop_loss:2030, thesis_id:'thesis-12' })
    expect(String(mocks.queryAll.mock.calls[0][0])).toContain("outcomes.status IN ('open','closing')")
    expect(String(mocks.queryAll.mock.calls[0][0])).not.toContain('LIMIT 200')
    expect(mocks.mt5Bridge).toHaveBeenNthCalledWith(1, 7, 'positions', {}, { timeoutMs:5000, noFallback:true })
    expect(mocks.mt5Bridge).toHaveBeenNthCalledWith(2, 7, 'pending_list', {}, { timeoutMs:5000, noFallback:true })
    const keys = JSON.stringify(result).match(/"([^"]+)":/g)?.map(key => key.slice(1, -2)) || []
    expect(keys).not.toEqual(expect.arrayContaining(['volume', 'profit', 'ticket', 'account', 'balance', 'equity']))
  })

  it.each([
    ['XAUUSD', 'XAUUSD.s'],
    ['XAUUSD.s', 'XAUUSD.c'],
    ['XAUUSD.c', 'XAUUSD.pro'],
    ['XAUUSD.pro', 'XAUUSD.std'],
    ['XAUUSD.std', 'XAUUSD.z'],
    ['XAUUSD.z', 'XAUUSD.ecn'],
    ['XAUUSD.ecn', 'XAUUSD.m'],
    ['XAUUSD.m', 'XAUUSD.raw'],
    ['XAUUSD.raw', 'XAUUSD.mini'],
    ['XAUUSD.mini', 'XAUUSD.a'],
  ])('matches strategy symbol %s to terminal broker symbol %s', async (strategySymbol, terminalSymbol) => {
    mocks.queryAll.mockResolvedValue([
      { outcome_id:31, signal_id:21, position_id:'701', pending_ticket:'801', signal_type:'sell_limit',
        original_stop_loss:2050, original_take_profits_json:'[1980]', thesis_id:'thesis-21',
        management_group_id:'group-21', created_at:'2026-07-22 10:00:00' },
    ])
    mocks.mt5Bridge.mockImplementation(async (_userId, action) => action === 'positions'
      ? { status:'success', positions:[
          { ticket:701, symbol:terminalSymbol, type:'sell', magic:234000,
            open_price:2020, price_current:2010, sl:2050, tp:1980 },
        ] }
      : { status:'success', orders:[
          { ticket:801, symbol:terminalSymbol, pending_type:'sell_limit', magic:234000,
            price:2020, sl:2050, tp:1980 },
        ] })

    const result = await loadPlatformReferencePortfolio({ strategyId:3, sourceUserId:7, symbol:strategySymbol })
    expect(result).toMatchObject({ symbol:'XAUUSD', position_count:1, pending_count:1 })
  })

  it('fails closed when either live source snapshot is unavailable', async () => {
    mocks.queryAll.mockResolvedValue([])
    mocks.mt5Bridge.mockImplementation(async (_userId, action) => action === 'positions'
      ? { status:'error' }
      : { status:'success', orders:[] })
    await expect(loadPlatformReferencePortfolio({ strategyId:3, sourceUserId:7, symbol:'XAUUSD' }))
      .rejects.toThrow('reference_positions_unavailable')
  })
})
