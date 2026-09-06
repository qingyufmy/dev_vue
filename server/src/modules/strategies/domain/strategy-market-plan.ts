export interface StrategyMarketDataPlan {
  version: 1
  primary_timeframe: string
  timeframes: Array<{ timeframe: string; kline_count: number }>
}

export function parseStrategyMarketDataPlan(raw: unknown): StrategyMarketDataPlan {
  const fail = (): never => { throw new Error('strategy_market_data_plan_invalid') }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail()
  const value = raw as Record<string, unknown>
  if (Object.keys(value).sort().join(',') !== 'primary_timeframe,timeframes,version' || value.version !== 1
    || typeof value.primary_timeframe !== 'string' || !Array.isArray(value.timeframes) || value.timeframes.length < 1 || value.timeframes.length > 7) return fail()
  const seen = new Set<string>()
  const timeframes = value.timeframes.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'kline_count,timeframe'
      || !['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].includes(item.timeframe)
      || !Number.isSafeInteger(item.kline_count) || item.kline_count < 10 || item.kline_count > 1000 || seen.has(item.timeframe)) return fail()
    seen.add(item.timeframe)
    return { timeframe: item.timeframe as string, kline_count: item.kline_count as number }
  })
  if (!seen.has(value.primary_timeframe)) return fail()
  return { version: 1, primary_timeframe: value.primary_timeframe, timeframes }
}
