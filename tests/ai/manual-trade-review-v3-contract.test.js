import { describe, expect, it } from 'vitest'
import {
  MANUAL_TRADE_REVIEW_AGGREGATE_V1_VERSION,
  MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION,
  MANUAL_TRADE_REVIEW_V3_VERSION,
  buildManualTradeReviewAggregateSourceSummary,
  deriveManualTradeReviewDirectionSummary,
  evaluateManualTradeReviewProtectionPlan,
  normalizeManualTradeReviewAggregateOutput,
  normalizeManualTradeReviewCounterfactualPoint,
  normalizeManualTradeReviewV3Content,
} from '../../server/routes/ai/manual-trade-review-v3-contract.js'

const strategySnapshot = {
  strategy_policy:{ entry:{ trend:{ enabled:true } }, protection:{ mode:'structure' } },
  market_data_plan:{ primary_timeframe:'M15' },
  entry_methods:['market', 'limit'], symbols:['XAUUSD'], use_chan_analysis:true,
}
const refs = ['bar:a:pre:M15', 'bar:a:outcome:M15', 'bar:b:outcome:M15', 'bar:c:outcome:M15']

function point(overrides = {}) {
  return {
    output_contract_version:MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION,
    candidate_key:'anchor', decision:'buy', entry_allowed:true, entry_method:'market',
    entry_price_reference:2000,
    strategy_signals:[{
      strategy_rule_path:'strategy_policy.entry.trend.enabled', timeframe:'M15',
      observation:'价格位于冻结趋势条件一侧', inference:'允许观察多头入场', evidence_refs:[refs[0]],
    }],
    blocking_rules:[],
    protection_plan:{ invalidation_logic:'跌破结构低点失效', stop_loss_price:1990,
      take_profit_prices:[2020, 2040], recommended_take_profit_tier:'first_target', position_size_tier:'probe' },
    confidence:.8,
    ...overrides,
  }
}

function whyProfitable() {
  return {
    direction_contribution:'方向与行情推进一致', entry_timing_contribution:'入场位于可观察结构附近',
    holding_contribution:'持仓期间没有提前退出', exit_contribution:'退出完成了目标兑现',
    luck_or_uncontrolled_factors:'后续波动仍有不可控部分',
  }
}

function v3Content(overrides = {}) {
  return {
    output_contract_version:MANUAL_TRADE_REVIEW_V3_VERSION,
    review_summary:'这笔交易的方向和保护计划分别进行复盘。', why_profitable:whyProfitable(),
    technical_analysis_chain:[{
      origin:'strategy_derived', method_label:'冻结策略条件', timeframes:['M15'],
      observations:['价格满足冻结策略条件'], reasoning:'该条件在结果未知时支持多头观察。',
      would_support_same_direction_without_outcome:true,
      strategy_rule_paths:['strategy_policy.entry.trend.enabled'], evidence_refs:[refs[1]],
      limitations:'只有一个历史样本，不能证明策略有效。',
    }],
    counterfactual_summary:{ protection_quality:'partial' },
    rule_comparisons:[{ rule_path:'strategy_policy.entry.trend.enabled', rule_summary:'趋势条件',
      observed_evidence:'冻结证据显示条件成立', status:'aligned', evidence_refs:[refs[1]] }],
    strengths:['方向判断有证据'], issues:[], strategy_optimization_hypotheses:[], confidence:.7,
    limitations:['需要更多样本验证。'],
    ...overrides,
  }
}

function aggregateSources() {
  return [
    { ref:'case:1:version:1:hash:h1', confirmed:true },
    { ref:'case:2:version:1:hash:h2', confirmed:true },
    { ref:'case:3:version:1:hash:h3', confirmed:true },
    { ref:'case:4:version:1:hash:h4', confirmed:false },
  ]
}

function aggregateContent(overrides = {}) {
  const sources = aggregateSources()
  return {
    output_contract_version:MANUAL_TRADE_REVIEW_AGGREGATE_V1_VERSION,
    recurring_patterns:[{ pattern:'相同方向逻辑', supporting_review_refs:[sources[0].ref],
      counterexample_review_refs:[sources[3].ref], confidence:.6 }],
    strategy_gaps:['保护规则需要更多样本'], protection_findings:['执行约束缺少历史规格'], version_comparisons:[],
    strategy_optimization_hypotheses:[{
      target_path:'strategy_policy.protection.mode', current_rule_summary:'结构保护', observed_gap:'保护条件覆盖不足',
      proposed_change:'增加边界验证', supporting_review_refs:sources.slice(0, 3).map(item => item.ref),
      counterexample_review_refs:[sources[3].ref], applicable_when:{ market:'同类行情' },
      risk_if_applied:'可能减少机会', validation_needed:'回放更多样本', recommendation_state:'ready_for_human_review', confidence:.6,
    }], limitations:['仅为待人工验证建议。'],
    ...overrides,
  }
}

describe('manual trade review v3 contract', () => {
  it('normalizes candidate points and rejects unstructured or unreferenced signals', () => {
    const normalized = normalizeManualTradeReviewCounterfactualPoint(point(), {
      strategySnapshot, allowedEvidenceRefs:refs,
    })
    expect(normalized.output_contract_version).toBe(MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION)
    expect(normalized.strategy_signals[0].timeframe).toBe('M15')
    expect(normalized.protection_plan.take_profit_prices).toEqual([2020, 2040])
    expect(() => normalizeManualTradeReviewCounterfactualPoint({ ...point(), strategy_signals:[{
      ...point().strategy_signals[0], strategy_rule_path:'strategy_policy.not_real',
    }] }, { strategySnapshot, allowedEvidenceRefs:refs })).toThrow('strategy_rule_path_unknown')
    expect(() => normalizeManualTradeReviewCounterfactualPoint({ ...point(), strategy_signals:[{
      ...point().strategy_signals[0], evidence_refs:['invented-ref'],
    }] }, { strategySnapshot, allowedEvidenceRefs:refs })).toThrow('strategy_signal_evidence_refs_invalid')
  })

  it('derives direction relationships independently of model supplied match fields', () => {
    const candidates = [
      point({ candidate_key:'anchor_minus_1', decision:'sell', direction_match:'same_direction_entry' }),
      point({ candidate_key:'anchor', decision:'buy', direction_match:'opposite_direction' }),
      point({ candidate_key:'anchor_plus_1', decision:'buy', entry_allowed:false, entry_method:'observe' }),
    ].map(item => normalizeManualTradeReviewCounterfactualPoint(item, { strategySnapshot, allowedEvidenceRefs:refs }))
    const summary = deriveManualTradeReviewDirectionSummary(candidates, 'buy', {
      protectionByCandidate:{ anchor:{ execution_feasibility:'pass' } },
    })
    expect(summary.direction_match).toBe('same_direction_entry')
    expect(summary.first_same_direction_candidate).toBe('anchor')
    expect(summary.same_direction_candidate_count).toBe(2)
    expect(summary.candidates[0].direction_match).toBe('opposite_direction')
    expect(summary.candidates[1].execution_feasibility).toBe('pass')
    expect(summary.candidates[2].direction_match).toBe('same_direction_observe')
  })

  it('evaluates protection direction, RR and ATR while failing closed on missing contract facts', () => {
    const result = evaluateManualTradeReviewProtectionPlan(point().protection_plan, {
      direction:'buy', entryPrice:2000, atr:10,
    })
    expect(result.stop_loss_direction_valid).toBe(true)
    expect(result.take_profit_direction_valid).toBe(true)
    expect(result.risk_reward_ratios).toEqual([2, 4])
    expect(result.stop_distance_atr).toBe(1)
    expect(result.take_profit_distance_atr).toEqual([2, 4])
    expect(result.execution_feasibility).toBe('unknown')
    expect(result.protection_quality).toBe('partial')

    const invalid = evaluateManualTradeReviewProtectionPlan({ ...point().protection_plan,
      stop_loss_price:2010 }, { direction:'buy', entryPrice:2000, contractSpec:{ price_step:.01 } })
    expect(invalid.stop_loss_direction_valid).toBe(false)
    expect(invalid.protection_quality).toBe('unreasonable')
    expect(invalid.execution_feasibility).toBe('pass')
  })

  it('requires evidence-backed technical chains and true strategy paths', () => {
    const derivedSummary = deriveManualTradeReviewDirectionSummary([point()], 'buy')
    const normalized = normalizeManualTradeReviewV3Content(v3Content(), {
      strategySnapshot, allowedEvidenceRefs:refs, serverDerivedSummary:derivedSummary,
    })
    expect(normalized.technical_analysis_chain[0].origin).toBe('strategy_derived')
    expect(normalized.counterfactual_summary.server_derived_direction_match).toBe('same_direction_entry')
    expect(() => normalizeManualTradeReviewV3Content(v3Content({
      technical_analysis_chain:[{ ...v3Content().technical_analysis_chain[0], evidence_refs:[] }],
    }), { strategySnapshot, allowedEvidenceRefs:refs, serverDerivedSummary:derivedSummary })).toThrow('technical_evidence_refs_required')
    expect(() => normalizeManualTradeReviewV3Content(v3Content({
      technical_analysis_chain:[{ ...v3Content().technical_analysis_chain[0], origin:'strategy_derived', strategy_rule_paths:['strategy_policy.missing'] }],
    }), { strategySnapshot, allowedEvidenceRefs:refs, serverDerivedSummary:derivedSummary })).toThrow('strategy_rule_path_unknown')
  })

  it('does not allow model output to supply the direction summary', () => {
    expect(() => normalizeManualTradeReviewV3Content(v3Content({
      counterfactual_summary:{ server_derived_direction_match:'same_direction_entry', protection_quality:'partial' },
    }), { strategySnapshot, allowedEvidenceRefs:refs })).toThrow('server_derived_summary_required')
  })

  it('downgrades aggregate recommendations without three confirmed supports and a counterexample', () => {
    const sources = aggregateSources()
    const normalized = normalizeManualTradeReviewAggregateOutput(aggregateContent(), {
      sources, strategySnapshot,
    })
    expect(normalized.source_summary).toEqual({ total:4, confirmed:3, evidence_complete:0, strategy_versions:[] })
    expect(normalized.strategy_optimization_hypotheses[0].recommendation_state).toBe('ready_for_human_review')
    const downgraded = normalizeManualTradeReviewAggregateOutput(aggregateContent({
      strategy_optimization_hypotheses:[{
        ...aggregateContent().strategy_optimization_hypotheses[0], supporting_review_refs:[sources[0].ref, sources[1].ref],
        counterexample_review_refs:[],
      }],
    }), { sources, strategySnapshot })
    expect(downgraded.strategy_optimization_hypotheses[0].recommendation_state).toBe('insufficient_evidence')
  })

  it('bounds aggregate sources and produces a server-derived source summary', () => {
    expect(buildManualTradeReviewAggregateSourceSummary(aggregateSources(), {
      evidenceComplete:2, strategyVersions:[3],
    })).toEqual({ total:4, confirmed:3, evidence_complete:2, strategy_versions:[3] })
    expect(() => normalizeManualTradeReviewAggregateOutput(aggregateContent(), {
      sources:aggregateSources().slice(0, 1), strategySnapshot,
    })).toThrow('aggregate_source_count_invalid')
  })
})
