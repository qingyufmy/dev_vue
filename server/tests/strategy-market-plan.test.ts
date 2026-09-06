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


describe('EMA34 frozen analysis evidence', () => {
  const referenceTime = '2026-09-07T01:01:00.000Z'
  function fixture() {
    const rows = Array.from({ length: 61 }, (_, i) => ({ openTime: new Date(Date.parse(referenceTime) - (61 - i) * 60_000).toISOString(),
      open: '1', high: '2', low: '1', close: String(100 + i), tickVolume: '1', closed: i < 60, revision: i + 1 }))
    const trading = { listAccounts: async () => [{ id: '7', platform: 'mt5', server: 'test', bridgeState: 'online' }],
      getQuote: async () => ({ bid: '1', ask: '2', last: '1', spread: '1', tradeMode: 'full', observedAt: referenceTime, revision: 1 }),
      listCandles: vi.fn().mockResolvedValue(rows) }
    return { rows, trading, source: new TradingAnalysisMarketSource(trading as unknown as TradingReadRepository) }
  }
  const config = { market_data_plan: { version: 1, primary_timeframe: 'M1', timeframes: [{ timeframe: 'M1', kline_count: 30 }] }, ema34_evidence: { version: 1, timeframe: 'M1' } }
  it('compiles explicit evidence and rejects malformed contracts', () => {
    expect(compileStrategy('analysis', '分析', config).normalizedConfig.ema34_evidence).toEqual(config.ema34_evidence)
    for (const invalid of [null, { version: 2, timeframe: 'M1' }, { version: 1, timeframe: 'M1', period: 12 }]) {
      expect(compileStrategy('analysis', '分析', { ...config, ema34_evidence: invalid }).valid).toBe(false)
      expect(() => marketPlan({ ...config, ema34_evidence: invalid })).toThrow('ema34_plan_invalid')
    }
  })
  it('reads once, preserves 30 model bars and freezes 60 closed warmup bars plus open tail', async () => {
    const { source, trading } = fixture()
    const result = await source.read({ userId: 1, preferredAccountId: null, symbol: 'XAUUSD', referenceTime, plan: marketPlan(config) })
    expect(trading.listCandles.mock.calls).toEqual([['7', 'XAUUSD', 'M1', 61]])
    expect((result.candles.M1 as unknown[]).length).toBe(30)
    expect(result.indicators?.ema34).toMatchObject({ ready: true, barsUsed: 60, source_account_id: '7', reference_time: referenceTime, analysis: { warmup_complete: true } })
    expect((result.indicators?.ema34 as { input_bars: unknown[] }).input_bars).toHaveLength(61)
  })
  it('keeps indicator-only history out of the model candle windows', async () => {
    const { source, trading } = fixture()
    const result = await source.read({ userId: 1, preferredAccountId: null, symbol: 'XAUUSD', referenceTime,
      plan: marketPlan({ ...config, market_data_plan: { version: 1, primary_timeframe: 'H1', timeframes: [{ timeframe: 'H1', kline_count: 100 }] } }) })
    expect(Object.keys(result.candles)).toEqual(['H1'])
    expect(trading.listCandles.mock.calls.map(call => call.slice(2))).toEqual([['H1', 100], ['M1', 61]])
  })
  it.each(['gap', 'stale', 'short'])('does not present %s history as usable EMA', async failure => {
    const { source, rows } = fixture()
    if (failure === 'gap') rows.splice(10, 1)
    if (failure === 'short') rows.splice(0, 40)
    const result = await source.read({ userId: 1, preferredAccountId: null, symbol: 'XAUUSD',
      referenceTime: failure === 'stale' ? '2026-09-08T01:01:00.000Z' : referenceTime, plan: marketPlan(config) })
    expect(result.indicators?.ema34).toMatchObject({ ready: false, value: null, reason: failure === 'gap' ? 'indicator_internal_gap_unresolved' : failure === 'stale' ? 'indicator_source_stale' : 'indicator_history_insufficient' })
  })
})
