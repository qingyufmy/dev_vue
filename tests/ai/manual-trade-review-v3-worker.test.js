import { describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  beijingNow:vi.fn(() => '2026-08-10 12:00:00'), queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
}))
vi.mock('../../server/db.js', () => db)
vi.mock('../../server/config.js', () => ({ JWT_SECRET:'manual-review-v3-worker-test-secret' }))
vi.mock('../../server/routes/ai/platform-content-access.js', () => ({ canManagePlatformAiContent:() => true }))
vi.mock('../../server/routes/ai/llm.js', () => ({ requestJsonObject:vi.fn() }))
vi.mock('../../server/routes/ai/model-providers.js', () => ({ MODEL_PROVIDER_DEFAULTS:{}, modelProviderProtocol:() => 'chat' }))
vi.mock('../../server/routes/ai/model-profiles.js', () => ({ resolveAiTaskModel:vi.fn() }))
vi.mock('../../server/routes/ai/inference-snapshots.js', () => ({ sha256:value => `hash:${String(value)}` }))
vi.mock('../../server/routes/ai/strategy-memory-library.js', () => ({
  getStrategyMemoryLibraryForRuntime:vi.fn(), createStrategyMemoryInjectionLog:vi.fn(),
}))
vi.mock('../../server/routes/ai/manual-trade-evidence.js', () => ({
  MANUAL_TRADE_SELECTION_MAX:1, getCurrentManualReviewAccount:vi.fn(), listEligibleManualTrades:vi.fn(),
  readManualTradeEvidence:vi.fn(), normalizedTradeHash:value => `hash:${String(value)}`,
}))

import { __manualTradeReviewTest } from '../../server/routes/ai/manual-trade-review.js'
import { MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION,
  MANUAL_TRADE_REVIEW_V3_VERSION, normalizeManualTradeReviewCounterfactualPoint,
  normalizeManualTradeReviewV3Content } from '../../server/routes/ai/manual-trade-review-v3-contract.js'

const source = { source_identity_hash:'trade-a' }
const strategySnapshot = {
  strategy_policy:{ entry:{ trend:{ enabled:true } } }, market_data_plan:{ primary_timeframe:'M15' },
  entry_methods:['market'], symbols:['XAUUSD'], use_chan_analysis:false,
}
const snapshotHash = 'a'.repeat(64)
const inputHash = 'b'.repeat(64)
const pointRef = 'market:trade-a:counterfactual:anchor:M15'

function evidencePoint(overrides = {}) {
  return {
    status:'complete', candidate_key:'anchor', decision_time_utc_msc:1_000, offset_bars:0,
    market_snapshot_hash:snapshotHash, input_hash:inputHash,
    market_data:{ status:'complete', timeframes:{ M15:{ status:'complete', candles:[] } } },
    allowed_evidence_refs:[pointRef], ...overrides,
  }
}

function frozenEvidence(point = evidencePoint()) {
  return { market_data:{ trades:{ 'trade-a':{ counterfactual_points:[point] } } } }
}

function candidate(overrides = {}) {
  return normalizeManualTradeReviewCounterfactualPoint({
    output_contract_version:MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION,
    candidate_key:'anchor', decision:'buy', entry_allowed:true, entry_method:'market',
    entry_price_reference:2_000, strategy_signals:[{
      strategy_rule_path:'strategy_policy.entry.trend.enabled', timeframe:'M15',
      observation:'冻结证据显示条件成立', inference:'允许观察多头', evidence_refs:[pointRef],
    }], blocking_rules:[], protection_plan:{ invalidation_logic:'结构失效', stop_loss_price:1_990,
      take_profit_prices:[2_020], recommended_take_profit_tier:'first', position_size_tier:'probe' },
    confidence:.8, ...overrides,
  }, { strategySnapshot, allowedEvidenceRefs:[pointRef] })
}

describe('manual trade review v3 worker wiring', () => {
  it('falls back to v2 only when the frozen evidence has no point field', () => {
    expect(__manualTradeReviewTest.manualTradeReviewV3PointEvidence({}, [source], {
      market_data:{ trades:{ 'trade-a':{ pre_entry:{ timeframes:{} } } } },
    })).toBeNull()
  })

  it('fails closed for a declared but incomplete point batch', () => {
    expect(() => __manualTradeReviewTest.manualTradeReviewV3PointEvidence({}, [source],
      frozenEvidence(evidencePoint({ status:'unavailable', market_data:{ status:'unavailable' }, market_snapshot_hash:null }))))
      .toThrow('manual_trade_review_counterfactual_point_0_incomplete')
    expect(() => __manualTradeReviewTest.manualTradeReviewV3PointEvidence({}, [source],
      { market_data:{ trades:{ 'trade-a':{ counterfactual_points:[] } } } }))
      .toThrow('manual_trade_review_counterfactual_points_invalid')
  })

  it('keeps each point allow-list scoped to its exact candidate cutoff', () => {
    const points = __manualTradeReviewTest.manualTradeReviewV3PointEvidence({}, [source], frozenEvidence())
    expect(points).toHaveLength(1)
    expect(points[0].allowed_evidence_refs).toEqual([pointRef])
    expect(() => __manualTradeReviewTest.manualTradeReviewV3PointEvidence({}, [source],
      frozenEvidence(evidencePoint({ allowed_evidence_refs:['trade:trade-a'] }))))
      .toThrow('manual_trade_review_counterfactual_point_0_evidence_refs_invalid')
  })

  it('derives direction from frozen candidate output and ignores a forged model match', () => {
    const point = evidencePoint({ contract_spec:{ price_step:.01, minimum_stop_distance:5, minimum_take_profit_distance:5 } })
    const modelOutput = { ...candidate({ direction_match:'same_direction_entry' }) }
    const summary = __manualTradeReviewTest.manualTradeReviewV3ServerSummary([point], [modelOutput], 'sell')
    expect(summary.direction_match).toBe('opposite_direction')
    expect(summary.candidates[0].direction_match).toBe('opposite_direction')
    expect(summary.candidates[0].execution_feasibility).toBe('pass')
  })

  it('uses only the strategy-declared ATR from the candidate primary timeframe', () => {
    const point = evidencePoint({ primary_timeframe:'M15', market_data:{ status:'complete', timeframes:{
      M15:{ status:'complete', candles:[], indicators:{ atr_14:10 } },
      H1:{ status:'complete', candles:[], indicators:{ atr_14:100 } },
    } } })
    const strategy = { market_data_plan:{ primary_timeframe:'M15', timeframes:[{ timeframe:'M15' }, { timeframe:'H1' }] },
      strategy_policy:{ indicators:[{ id:'atr_14', kind:'atr', source:{ timeframe:'M15' }, params:{ period:14 } }] } }
    expect(__manualTradeReviewTest.manualTradeReviewV3FindAtrEvidence(point, strategy)).toMatchObject({
      atr_timeframe:'M15', atr_period:14, atr_value:10, atr_evidence_ref:pointRef,
    })
    expect(__manualTradeReviewTest.manualTradeReviewV3FindAtrEvidence(point, {
      ...strategy, strategy_policy:{ indicators:[{ id:'atr_14', kind:'atr', source:{ timeframe:'H1' }, params:{ period:14 } }] },
    })).toMatchObject({ atr_value:null })
    expect(__manualTradeReviewTest.manualTradeReviewV3FindAtrEvidence(point, {
      ...strategy, strategy_policy:{ indicators:[
        { id:'atr_14', kind:'atr', source:{ timeframe:'M15' }, params:{ period:14 } },
        { id:'atr_20', kind:'atr', source:{ timeframe:'M15' }, params:{ period:20 } },
      ] },
    })).toMatchObject({ atr_value:null })
  })

  it('accepts v3 optimization references only from the frozen source set', () => {
    const normalized = normalizeManualTradeReviewV3Content({
      output_contract_version:MANUAL_TRADE_REVIEW_V3_VERSION, review_summary:'复盘摘要',
      why_profitable:{ direction_contribution:'方向', entry_timing_contribution:'时机', holding_contribution:'持仓',
        exit_contribution:'退出', luck_or_uncontrolled_factors:'不确定因素' }, technical_analysis_chain:[{
        origin:'manual_logic_inferred', method_label:'人工逻辑', timeframes:['M15'], observations:['观察'],
        reasoning:'结果未知时仍可复核', would_support_same_direction_without_outcome:true,
        strategy_rule_paths:[], evidence_refs:[pointRef], limitations:'样本有限',
      }],
      counterfactual_summary:{ protection_quality:'partial' }, rule_comparisons:[], strengths:[], issues:[],
      strategy_optimization_hypotheses:[{ target_path:'strategy_policy.entry.trend.enabled', current_rule_summary:'趋势规则',
        observed_gap:'样本不足', proposed_change:'继续观察', supporting_review_refs:['trade-a'], counter_evidence:[],
        applicable_when:{}, risk_if_applied:'可能过滤机会', validation_needed:'复核更多样本', confidence:.5 }],
      confidence:.6, limitations:[],
    }, { strategySnapshot, allowedEvidenceRefs:[pointRef], sourceRefs:['trade-a'], sourceRefSet:new Set(['trade-a']),
      serverDerivedSummary:{ direction_match:'same_direction_entry', first_same_direction_candidate:'anchor', timing_difference_bars:0 },
      serverProtectionAssessment:{ protection_quality:'partial' } })
    expect(normalized.strategy_optimization_hypotheses[0].supporting_review_refs).toEqual(['trade-a'])
  })

  it('freezes point task idempotency and passes source refs to v3 output validation', async () => {
    const review = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../../server/routes/ai/manual-trade-review.js', import.meta.url), 'utf8'))
    expect(review).toContain('counterfactual:${point.candidate_key}')
    expect(review).toContain('sourceRefSet:new Set(evidenceCatalog.trade_refs)')
    expect(review).toContain('counterfactual_points:currentContent.counterfactual_points')
    expect(review).toContain('normalized_output:normalized')
    expect(review).toContain('allowed_evidence_refs:point.allowed_evidence_refs')
    expect(review).toContain('direction_match:derived.direction_match')
    expect(review).toContain('protection_assessment:derived.protection_assessment')
    expect(review).toContain('outputContractHash:isV3 ? manualTradeReviewV3OutputContractHash() : null')
    expect(review).toContain('resultRef:`manual_trade_review_counterfactual:${job.id}')
    expect(review).toContain('resultHash:pointRow.normalizedOutputHash')
    expect(review).toMatch(/candidateKey:point\.candidate_key, modelTaskId:taskId, inputHash:point\.input_hash, leaseToken:job\.lease_token/)
    expect(review).toContain('promptHash:sha256(JSON.stringify(messages)), outputContractHash:pointOutputContractHash')
    expect(review).toContain('idempotencyKey, inputHash, snapshotHash:runtimeHash')
  })
})
