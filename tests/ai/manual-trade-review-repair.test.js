import { describe, expect, it } from 'vitest'
import { createManualTradeReviewPointRepairContext,
  manualTradeReviewPointRepairTargets } from '../../server/routes/ai/manual-trade-review-repair.js'
import { MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION,
  normalizeManualTradeReviewCounterfactualPoint } from '../../server/routes/ai/manual-trade-review-v3-contract.js'

const strategySnapshot = {
  strategy_policy:{ entry:{ trend:{ enabled:true } } },
  market_data_plan:{ primary_timeframe:'M15', timeframes:[{ timeframe:'M15' }, { timeframe:'H1' }] },
  entry_methods:['market'], symbols:['XAUUSD'], use_chan_analysis:false,
}
const m15Ref = 'market:trade-a:counterfactual:anchor:M15'
const h1Ref = 'market:trade-a:counterfactual:anchor:H1'
const options = {
  strategySnapshot, strategyDeclaredTimeframes:['M15', 'H1'], evidenceAvailableTimeframes:['M15', 'H1'],
  allowedEvidenceRefs:[m15Ref, h1Ref],
}

function point(overrides = {}) {
  return {
    output_contract_version:MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION,
    candidate_key:'anchor', decision:'buy', entry_allowed:true, entry_method:'market', entry_price_reference:2_000,
    strategy_signals:[{ strategy_rule_path:'strategy_policy.entry.trend.enabled', timeframe:'M15',
      observation:'M15 趋势条件成立', inference:'允许观察多头', evidence_refs:[m15Ref] }],
    blocking_rules:[], protection_plan:{ invalidation_logic:'结构失效', stop_loss_price:1_990,
      take_profit_prices:[2_020], recommended_take_profit_tier:'first', position_size_tier:'probe' },
    confidence:.8, ...overrides,
  }
}

function validator(value) {
  return normalizeManualTradeReviewCounterfactualPoint(value, options)
}

describe('manual trade review point repair', () => {
  it('identifies only signals whose timeframe and evidence refs disagree', () => {
    const initial = point({ strategy_signals:[
      point().strategy_signals[0],
      { ...point().strategy_signals[0], timeframe:'M15', evidence_refs:[m15Ref, h1Ref] },
    ] })
    const context = manualTradeReviewPointRepairTargets(initial, options)
    expect(context.targets).toEqual([{
      kind:'timeframe_evidence', path:'strategy_signals[1].timeframe_evidence_refs', signal_index:1,
      current_timeframe:'M15', current_evidence_refs:[m15Ref, h1Ref],
    }])
    expect(context.allowedEvidenceRefsByTimeframe).toEqual({ H1:[h1Ref], M15:[m15Ref] })
  })

  it('repairs a timeframe mismatch without changing the signal analysis or trade decision', () => {
    const initial = point({ strategy_signals:[{
      ...point().strategy_signals[0], timeframe:'M15', evidence_refs:[m15Ref, h1Ref],
    }] })
    expect(() => validator(initial)).toThrow('strategy_signal_timeframe_evidence_timeframe_invalid')
    const repair = createManualTradeReviewPointRepairContext({ ...options, validateOutput:validator })
    const validationError = new Error('manual_trade_review_v3_strategy_signal_timeframe_evidence_timeframe_invalid')
    const validationContext = repair.validationContext({ validationError, initialObject:initial })
    const repaired = repair.applyRepairPatch({ initialObject:initial, validationContext,
      repairPatch:{ changes:[{ path:'strategy_signals[0].timeframe_evidence_refs',
        timeframe:'M15', evidence_refs:[m15Ref] }] } })
    expect(repaired.strategy_signals[0]).toMatchObject({
      timeframe:'M15', evidence_refs:[m15Ref], observation:'M15 趋势条件成立', inference:'允许观察多头',
    })
    expect(repaired.decision).toBe('buy')
    expect(repaired.protection_plan).toEqual(validator(point()).protection_plan)
  })

  it('rejects cross-timeframe, unknown and unrelated repair patches', () => {
    const initial = point({ strategy_signals:[{
      ...point().strategy_signals[0], timeframe:'M15', evidence_refs:[m15Ref, h1Ref],
    }] })
    const repair = createManualTradeReviewPointRepairContext({ ...options, validateOutput:validator })
    const validationError = new Error('manual_trade_review_v3_strategy_signal_timeframe_evidence_timeframe_invalid')
    const validationContext = repair.validationContext({ validationError, initialObject:initial })
    expect(() => repair.applyRepairPatch({ initialObject:initial, validationContext,
      repairPatch:{ changes:[{ path:'strategy_signals[0].timeframe_evidence_refs',
        timeframe:'M15', evidence_refs:[h1Ref] }] } })).toThrow('point_repair_invalid')
    expect(() => repair.applyRepairPatch({ initialObject:initial, validationContext,
      repairPatch:{ changes:[{ path:'decision', timeframe:'M15', evidence_refs:[m15Ref] }] } }))
      .toThrow('point_repair_invalid')
    const unrelated = new Error('manual_trade_review_v3_confidence_invalid')
    expect(() => repair.validationContext({ validationError:unrelated, initialObject:initial }))
      .toThrow('manual_trade_review_v3_confidence_invalid')
  })
})
