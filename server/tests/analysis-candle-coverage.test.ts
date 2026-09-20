import { describe, expect, it } from 'vitest'
import { candleCoverage } from '../src/modules/inference/domain/candle-coverage.js'
import { TradingAnalysisMarketSource } from '../src/modules/inference/infrastructure/trading-analysis-market-source.js'

describe('frozen analysis candle coverage', () => {
  it('marks partial histories without treating a nonempty frame as complete', () => {
    expect(candleCoverage([{ timeframe: 'H1', count: 3 }], { H1: [{}, {}] })).toEqual({
      version: 1, status: 'partial', frames: [{ timeframe: 'H1', requested_bars: 3, available_bars: 2 }],
    })
    expect(candleCoverage([{ timeframe: 'H1', count: 2 }], { H1: [{}, {}] }).status).toBe('complete')
  })
  it('rejects missing frames and ambiguous plans', () => {
    expect(() => candleCoverage([{ timeframe: 'H1', count: 2 }], {})).toThrow('candle_coverage_frame_missing')
    expect(() => candleCoverage([{ timeframe: 'H1', count: 2 }, { timeframe: 'H1', count: 3 }], {})).toThrow('candle_coverage_plan_invalid')
    expect(() => candleCoverage([{ timeframe: 'H1', count: NaN }], {})).toThrow('candle_coverage_plan_invalid')
  })
  it('the actual market source freezes requested and selected counts with the model input', async () => {
    const reader = {
      async findOwnedAccount() { return null },
      async listAccounts() { return [{ id: '1', bridgeState: 'online', platform: 'mt5', server: 'fixture' }] },
      async getQuote() { return { bid: '1', ask: '2', last: '1', spread: '1', tradeMode: 'full', observedAt: '2026-09-09T00:00:00.000Z', revision: 1 } },
      async listCandles() { return Array.from({ length: 2 }, (_, i) => ({ openTime: `2026-09-08T0${i}:00:00.000Z`,
        open: '1', high: '2', low: '1', close: '2', tickVolume: '1', closed: true, revision: 1 })) },
    } as unknown as ConstructorParameters<typeof TradingAnalysisMarketSource>[0]
    const source = new TradingAnalysisMarketSource(reader)
    const input = await source.read({ userId: 7, preferredAccountId: null, symbol: 'XAUUSD', referenceTime: '2026-09-09T00:00:00.000Z',
      plan: { timeframes: ['H1', 'M5'], candleLimit: 3, candleLimits: { H1: 3, M5: 1 } } })
    expect(input.candle_coverage).toEqual({ version: 1, status: 'partial', frames: [
      { timeframe: 'H1', requested_bars: 3, available_bars: 2 }, { timeframe: 'M5', requested_bars: 1, available_bars: 1 },
    ] })
    expect(input.candles.M5).toHaveLength(1)
  })
})
