import { describe, expect, it } from 'vitest'
import { buildManualReviewEvidenceCatalog, requiredManualReviewArray, requiredManualReviewConfidence,
  requiredManualReviewText, validateFrozenStrategyPath, validateManualReviewEvidenceRefs,
} from '../../server/routes/ai/manual-trade-review-contract.js'

const identity = 'a'.repeat(64)
const snapshot = {
  strategy_policy:{ entry:{ pullback:true } },
  market_data_plan:{ timeframes:[{ timeframe:'M15' }] },
  entry_methods:['limit'], symbols:['XAUUSD'], use_chan_analysis:true,
}

describe('manual trade review strict output contract helpers', () => {
  it('accepts only paths that resolve inside the frozen strategy snapshot', () => {
    expect(validateFrozenStrategyPath('strategy_policy.entry.pullback', snapshot)).toBe('strategy_policy.entry.pullback')
    expect(validateFrozenStrategyPath('market_data_plan.timeframes[0].timeframe', snapshot)).toBe('market_data_plan.timeframes[0].timeframe')
    expect(() => validateFrozenStrategyPath('strategy_policy_json.entry', snapshot)).toThrow('manual_trade_review_output_rule_path_invalid')
    expect(() => validateFrozenStrategyPath('strategy_policy.missing', snapshot)).toThrow('manual_trade_review_output_rule_path_unknown')
    expect(() => validateFrozenStrategyPath('strategy_policy.__proto__', snapshot)).toThrow('manual_trade_review_output_rule_path_invalid')
  })

  it('builds separate blind and outcome evidence reference catalogs', () => {
    const catalog = buildManualReviewEvidenceCatalog([{ source_identity_hash:identity }], { market_data:{ trades:{
      [identity]:{
        pre_entry:{ timeframes:{ M15:{ chan:{ status:'complete' } } } },
        outcome_path:{ timeframes:{ M15:{} } },
      },
    } } })
    expect(catalog.pre_entry_refs).toEqual([
      `chan:${identity}:pre_entry:M15`, `market:${identity}:pre_entry:M15`, `trade:${identity}`,
    ])
    expect(catalog.outcome_refs).toContain(`market:${identity}:outcome:M15`)
    expect(catalog.pre_entry_refs).not.toContain(`market:${identity}:outcome:M15`)
    expect(validateManualReviewEvidenceRefs([`trade:${identity}`], catalog.pre_entry_refs, { required:true }))
      .toEqual([`trade:${identity}`])
    expect(() => validateManualReviewEvidenceRefs([`market:${identity}:outcome:M15`], catalog.pre_entry_refs))
      .toThrow('manual_trade_review_output_reference_invalid')
  })

  it('requires explicitly present non-empty text, arrays and bounded confidence', () => {
    expect(requiredManualReviewText('  review\u0000 ', 'review_summary')).toBe('review')
    expect(() => requiredManualReviewText('', 'review_summary')).toThrow('manual_trade_review_output_review_summary_required')
    expect(requiredManualReviewArray([], 'issues')).toEqual([])
    expect(() => requiredManualReviewArray(null, 'issues')).toThrow('manual_trade_review_output_issues_required')
    expect(requiredManualReviewConfidence(0.7)).toBe(0.7)
    expect(() => requiredManualReviewConfidence('missing')).toThrow('manual_trade_review_output_confidence_invalid')
  })
})
