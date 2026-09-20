import { describe, expect, it } from 'vitest'
import { TerminalMarketService } from '../src/modules/trading/application/terminal-market-service.js'
import { publicChanChart } from '../src/modules/market/application/public-chan-chart.js'
import { TradingAccessError } from '../src/modules/trading/domain/trading.js'

const durations: Record<string, number> = { M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000 }

describe('terminal market Chan chart', () => {
  it('retries a transient bridge query collision before loading the terminal directory', async () => {
    let reads = 0
    const reader = { read: async () => {
      reads += 1
      if (reads === 1) throw new TradingAccessError('terminal_market_busy', 503)
      return { items: [{ symbol: 'BTCUST', description: 'Bitcoin', selected: true, visible: true, trade_mode: 4 }], nextCursor: null, observedAt: Date.now() }
    } }
    const service = new TerminalMarketService({ ownedAccount: async () => ({ id: '8', platform: 'mt5' }) } as never,
      reader as never, undefined, async () => {})
    await expect(service.symbols(9, '8', null)).resolves.toMatchObject({ items: [{ symbol: 'BTCUST' }] })
    expect(reads).toBe(2)
  })

  it.each(Object.keys(durations))('calculates %s structure for a non-public terminal symbol', async timeframe => {
    const before = Date.now()
    const duration = durations[timeframe]!
    const rows = Array.from({ length: 100 }, (_, index) => {
      const base = 80_000 + Math.sin(index / 4) * 2_000 + index * 10
      return { symbol: 'BTCUST', timeframe, open_time_utc_msc: before - (100 - index) * duration,
        open: base, high: base + 500, low: base - 500, close: base + Math.sin(index) * 200, tick_volume: 10, closed: true }
    })
    const reader = { read: async (_userId: number, _accountId: string, query: { kind: string }) => query.kind === 'symbols'
      ? { items: [{ symbol: 'BTCUST', description: 'Bitcoin', selected: true, visible: true, trade_mode: 4 }], nextCursor: null, observedAt: before }
      : { items: rows, nextCursor: null, observedAt: before } }
    const accounts = { ownedAccount: async () => ({ id: '8', platform: 'mt5' as const }) }
    const service = new TerminalMarketService(accounts as never, reader as never, {
      calculate: input => publicChanChart({ ...input, clock: null }),
    })

    const result = await service.candles(9, '8', 'BTCUST', timeframe, before, 500)

    expect(result.structure).toMatchObject({ algorithm: 'chan_structure_v8', based_on_closed_bars: 100 })
    expect(result.structure).toHaveProperty('lines')
  })
})
