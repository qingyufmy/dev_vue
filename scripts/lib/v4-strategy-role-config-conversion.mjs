import { hash } from './v4-backfill-contract.mjs'
import { convertStrategyMarketPlan } from './v4-strategy-market-plan-conversion.mjs'
import { reviewStrategyRules } from './v4-strategy-rules-review.mjs'
import { convertStrategyPolicy } from './v4-strategy-policy-conversion.mjs'
import { compileStrategy } from '../../server/dist-v4/modules/strategies/application/strategy-service.js'
import { reviewStrategyPortfolio } from './v4-strategy-portfolio-conversion.mjs'

// Configuration conversion is independent of prompt splitting and ID allocation.
// Keep unmapped source bytes for backfill; accepting arbitrary trader JSON does
// not establish that the trader runtime implements a legacy policy.
export function convertStrategyRoleConfig(row) {
  const fields = ['market_data_plan_json', 'entry_methods_json', 'strategy_policy_json',
    'use_chan_analysis', 'use_ema34_filter', 'include_portfolio_context', 'scope']
  const retainedSource = Object.fromEntries(fields.map(field => [field, row[field]]))
  const rules = reviewStrategyRules(row)
  const portfolioContext = reviewStrategyPortfolio(row)
  const market = convertStrategyMarketPlan(row.market_data_plan_json)
  const policy = ['0', '1'].includes(row.use_ema34_filter) ? convertStrategyPolicy(row.strategy_policy_json, row.use_ema34_filter) : null
  const problems = [...rules.problems, ...market.problems, ...(policy?.problems ?? [])]
  const analysis = market.candidate ? compileStrategy('analysis', 'configuration validation', {
    ...market.candidate, ...policy?.analysisConfig,
    ...(['0', '1'].includes(row.use_chan_analysis) ? { chan_evidence: { version: 1, enabled: rules.chanEnabled } } : {}),
  }) : null
  const trader = rules.entryMethods ? compileStrategy('trader', 'configuration validation', {
    entry_methods: rules.entryMethods,
    ...portfolioContext.targetConfig,
  }) : null
  for (const compiled of [analysis, trader]) {
    if (compiled && !compiled.valid) problems.push(...compiled.issues.filter(item => item.level === 'error').map(item => ({ code: item.code, field: item.path })))
  }
  // M1 may coexist with H1/H4 for EMA and raw-candle evidence. It does not get a
  // made-up Chan window, and must not block the supported frames in the same plan.
  if (rules.chanEnabled && market.candidate && !market.candidate.market_data_plan.timeframes.some(item => ['M5', 'M15', 'H1', 'H4'].includes(item.timeframe))) {
    problems.push({ field: 'market_data_plan_json', code: 'chan_timeframe_not_supported' })
  }
  problems.push(...portfolioContext.problems)
  // The legacy flag alone never creates an EMA declaration or implies M1.
  // An explicit policy must be mapped as a whole, including its timeframe.
  return {
    sourceHash: hash(retainedSource), retainedSource,
    status: problems.length ? 'partial' : 'converted', problems,
    analysisConfig: analysis?.valid ? analysis.normalizedConfig : null,
    traderConfig: trader?.valid ? trader.normalizedConfig : null,
    portfolioContext,
    executable: false, remainingChecks: ['role_specific_prompts', 'target_identity_mapping', 'restore_backfill_reconciliation'],
  }
}
