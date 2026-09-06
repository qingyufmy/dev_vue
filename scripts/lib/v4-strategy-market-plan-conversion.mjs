import { hash } from './v4-backfill-contract.mjs'
import { parseStrategyMarketDataPlan } from '../../server/dist-v4/modules/strategies/domain/strategy-market-plan.js'

export function convertStrategyMarketPlan(raw) {
  if (raw !== null && typeof raw !== 'string') throw new Error('strategy_market_source_shape')
  const result = { sourceHash: hash(raw), executable: false }
  try {
    if (raw === null) throw new Error('legacy_market_plan_fallback_requires_prompt')
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'primary_timeframe,timeframes') throw new Error('legacy_market_plan_shape')
    const plan = parseStrategyMarketDataPlan({ version: 1, ...value })
    if (plan.timeframes.some(item => item.kline_count > 500)) throw new Error('legacy_market_plan_clamp_requires_review')
    // The old normalizer placed the primary timeframe first, preserving the
    // relative order of all remaining requested frames.
    plan.timeframes.sort((a, b) => a.timeframe === plan.primary_timeframe ? -1 : b.timeframe === plan.primary_timeframe ? 1 : 0)
    return { ...result, status: 'converted', candidate: { market_data_plan: plan }, problems: [] }
  } catch (error) {
    return { ...result, status: 'blocked', candidate: null, problems: [{ code: error instanceof SyntaxError ? 'legacy_market_plan_json_invalid' : error.message }] }
  }
}
