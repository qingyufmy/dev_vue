import { describe, expect, it } from 'vitest'
import {
  normalizeEntryMethods,
  normalizeMarketDataPlan,
  normalizeUseChanAnalysis,
  parseStrategyPolicy,
  signalTypesForEntryMethods,
} from '../../server/routes/ai/strategy-policy.js'

describe('strategy policy', () => {
  it('normalizes and deduplicates supported entry methods', () => {
    expect(normalizeEntryMethods(['MARKET', 'limit', 'market', 'invalid'])).toEqual(['market', 'limit'])
    expect(signalTypesForEntryMethods(['market', 'stop'])).toEqual(['buy_stop', 'sell_stop', 'buy', 'sell', 'hold'])
  })

  it('rejects a strategy without any supported entry method', () => {
    expect(() => normalizeEntryMethods([])).toThrow('entry_methods_required')
  })

  it('normalizes structured K-line plans and keeps the requested primary timeframe first', () => {
    expect(normalizeMarketDataPlan({
      primary_timeframe: 'H1',
      timeframes: [
        { timeframe: 'M15', kline_count: 2 },
        { timeframe: 'H1', kline_count: 900 },
        { timeframe: 'M15', kline_count: 200 },
        { timeframe: 'INVALID', kline_count: 100 },
      ],
    })).toEqual({
      primary_timeframe: 'H1',
      timeframes: [
        { timeframe: 'H1', kline_count: 500 },
        { timeframe: 'M15', kline_count: 10 },
      ],
    })
  })

  it('migrates legacy timeframe tags when structured plan is absent', () => {
    const policy = parseStrategyPolicy({
      system_prompt: '分析黄金 {{ATF:M15:120}} 和 {{CTF:H1:80}} {{USE_CHAN}}',
      entry_methods_json: '["limit"]',
    })
    expect(policy.entryMethods).toEqual(['limit'])
    expect(policy.useChanAnalysis).toBe(true)
    expect(policy.marketDataPlan).toEqual({
      primary_timeframe: 'M15',
      timeframes: [
        { timeframe: 'M15', kline_count: 120 },
        { timeframe: 'H1', kline_count: 80 },
      ],
    })
  })

  it('uses the structured Chan switch as the authority over legacy prompt tags', () => {
    expect(normalizeUseChanAnalysis(1)).toBe(true)
    expect(parseStrategyPolicy({ system_prompt: '{{USE_CHAN}}', use_chan_analysis: 0 }).useChanAnalysis).toBe(false)
  })
})
