import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ queryAll:vi.fn(), mt5Bridge:vi.fn() }))
vi.mock('../../server/db.js', () => ({ queryAll:mocks.queryAll }))
vi.mock('../../server/routes/ai/market-data.js', () => ({ mt5Bridge:mocks.mt5Bridge }))

import { loadPlatformReferencePortfolio } from '../../server/routes/ai/reference-portfolio.js'

describe('platform reference portfolio', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps only strategy-attributed system orders and strips account-sensitive fields', async () => {
    mocks.queryAll.mockResolvedValue([
      { signal_id:11, trade_ticket:'501', signal_type:'buy', stop_loss_price:1990, take_profit_1_price:2020, created_at:'2026-07-22 10:00:00' },
      { signal_id:12, pending_ticket:'601', signal_type:'sell_limit', stop_loss_price:2030, take_profit_1_price:1980 },
    ])
    mocks.mt5Bridge.mockImplementation(async (_userId, action) => action === 'positions'
      ? { status:'success', positions:[
          { ticket:501, symbol:'XAUUSD.s', type:'buy', magic:234000, volume:0.5, profit:123, open_price:2000, price_current:2005, sl:1990, tp:2020 },
          { ticket:502, symbol:'XAUUSD.s', type:'buy', magic:999, volume:3, profit:999 },
        ] }
      : { status:'success', orders:[
          { ticket:601, symbol:'XAUUSD.s', pending_type:'sell_limit', magic:234000, volume:0.7, price:2020, sl:2030, tp:1980 },
          { ticket:602, symbol:'XAUUSD.s', pending_type:'buy_limit', magic:234000, volume:1, price:1900 },
        ] })

    const result = await loadPlatformReferencePortfolio({ strategyId:3, sourceUserId:7, symbol:'XAUUSD' })
    expect(result).toMatchObject({ strategy_id:3, symbol:'XAUUSD', position_count:1, pending_count:1 })
    expect(result.positions[0]).toMatchObject({ origin_signal_id:11, side:'buy', entry_price:2000 })
    expect(result.pending_orders[0]).toMatchObject({ origin_signal_id:12, side:'sell', trigger_price:2020 })
    const keys = JSON.stringify(result).match(/"([^"]+)":/g)?.map(key => key.slice(1, -2)) || []
    expect(keys).not.toEqual(expect.arrayContaining(['volume', 'profit', 'ticket', 'account', 'balance', 'equity']))
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
