import { describe, expect, it } from 'vitest'
import { convertStrategyMarketPlan } from '../scripts/lib/v4-strategy-market-plan-conversion.mjs'

describe('legacy market plan conversion', () => {
  it('retains counts and legacy primary-first ordering', () => {
    const result = convertStrategyMarketPlan(JSON.stringify({ primary_timeframe: 'H1', timeframes: [{ timeframe: 'M1', kline_count: 30 }, { timeframe: 'H1', kline_count: 150 }] }))
    expect(result.candidate.market_data_plan.timeframes).toEqual([{ timeframe: 'H1', kline_count: 150 }, { timeframe: 'M1', kline_count: 30 }])
    expect(result.executable).toBe(false)
  })
  it.each([null, '{bad', '{}', '{"primary_timeframe":"H1","timeframes":[{"timeframe":"H1","kline_count":501}]}'])('blocks missing, malformed or legacy-clamped source %s', raw => {
    expect(convertStrategyMarketPlan(raw).status).toBe('blocked')
  })
})
