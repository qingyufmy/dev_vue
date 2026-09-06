import { describe, expect, it, vi } from 'vitest'
import { compileStrategy } from '../src/modules/strategies/application/strategy-service.js'
import { marketPlan } from '../src/modules/inference/application/analysis-context-builder.js'
import { TradingAnalysisMarketSource } from '../src/modules/inference/infrastructure/trading-analysis-market-source.js'
import type { TradingReadRepository } from '../src/modules/trading/application/trading-ports.js'

const plan = { version: 1, primary_timeframe: 'H1', timeframes: [{ timeframe: 'H1', kline_count: 150 }, { timeframe: 'M1', kline_count: 30 }] }

describe('explicit strategy market data plan', () => {
  it('preserves per-frame counts below the old uniform minimum and primary frame', () => {
    const compiled = compileStrategy('analysis', '分析', { market_data_plan: plan })
    expect(compiled.valid).toBe(true)
    expect(compiled.normalizedConfig.market_data_plan).toEqual(plan)
    expect(marketPlan(compiled.normalizedConfig)).toMatchObject({ timeframes: ['H1', 'M1'], primaryTimeframe: 'H1', candleLimits: { H1: 150, M1: 30 } })
  })
  it.each([{ timeframes: ['H1'] }, { candle_limit: 300 }])('rejects two competing plan sources %j', legacy => {
    expect(compileStrategy('analysis', '分析', { market_data_plan: plan, ...legacy }).valid).toBe(false)
    expect(() => marketPlan({ market_data_plan: plan, ...legacy })).toThrow('market_data_plan_conflict')
  })
  it.each([{ ...plan, primary_timeframe: 'D1' }, { ...plan, version: 2 }, { ...plan, timeframes: [...plan.timeframes, plan.timeframes[0]] },
    { ...plan, timeframes: [{ timeframe: 'H1', kline_count: 9 }] }])('rejects invalid plans without runtime fallback', invalid => {
    expect(compileStrategy('analysis', '分析', { market_data_plan: invalid }).valid).toBe(false)
    expect(() => marketPlan({ market_data_plan: invalid })).toThrow('strategy_market_data_plan_invalid')
  })
  it('passes each exact count to the data reader and freezes the requested plan with the market', async () => {
    const trading = { listAccounts: async () => [{ id: '7', platform: 'mt5', server: 'test', bridgeState: 'online' }],
      getQuote: async () => ({ bid: '1', ask: '2', last: '1', spread: '1', tradeMode: 'full', observedAt: '2026-09-07T00:00:00Z', revision: 1 }),
      listCandles: vi.fn().mockResolvedValue([{ openTime: '2026-09-07T00:00:00Z', open: '1', high: '2', low: '1', close: '2', tickVolume: '1', closed: true, revision: 1 }]) }
    const result = await new TradingAnalysisMarketSource(trading as unknown as TradingReadRepository).read({ userId: 1, preferredAccountId: null, symbol: 'XAUUSD', plan: marketPlan({ market_data_plan: plan }) })
    expect(trading.listCandles.mock.calls.map(call => call.slice(2))).toEqual([['H1', 150], ['M1', 30]])
    expect(result.primary_timeframe).toBe('H1')
    expect(result.market_data_plan).toEqual(plan)
  })
})
