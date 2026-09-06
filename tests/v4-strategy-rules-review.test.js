import { describe, expect, it } from 'vitest'
import { reviewStrategyRules } from '../scripts/lib/v4-strategy-rules-review.mjs'
const source = changes => ({ scope: 'platform', entry_methods_json: null, strategy_policy_json: null, use_chan_analysis: '1', use_ema34_filter: '1', include_portfolio_context: '1', ...changes })
describe('legacy strategy rule review', () => {
  it('records explicit default and legacy normalization without enabling portfolio context for a platform strategy', () => {
    expect(reviewStrategyRules(source())).toMatchObject({ entryMethodsDefaultApplied: true, portfolioContextEnabled: false, chanEnabled: true })
    expect(reviewStrategyRules(source({ entry_methods_json: '[" LIMIT ","limit","market"]' })).entryMethods).toEqual(['limit', 'market'])
    expect(reviewStrategyRules(source({ scope: 'private' })).portfolioContextEnabled).toBe(true)
  })
  it('does not silently drop unknown methods or policy JSON errors', () => {
    expect(reviewStrategyRules(source({ entry_methods_json: '["future","market"]' })).status).toBe('blocked')
    expect(reviewStrategyRules(source({ strategy_policy_json: '{bad' })).status).toBe('blocked')
  })
  it('keeps policy presence and mode as evidence without claiming runtime conversion', () => {
    const result = reviewStrategyRules(source({ strategy_policy_json: '{"mode":"shadow","indicators":[{"kind":"ema","enabled":true}]}' }))
    expect(result.policy).toMatchObject({ mode: 'shadow', indicators: [{ kind: 'ema', enabled: true }] })
    expect(result.executable).toBe(false)
    expect(result.blockers).toContain('indicator_and_policy_runtime_mapping')
  })
})
