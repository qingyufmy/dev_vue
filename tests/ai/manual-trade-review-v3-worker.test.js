import { describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  beijingNow:vi.fn(() => '2026-08-10 12:00:00'), queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
  tracker:{
    taskId:'manual-review-stage-task', signal:null,
    assertOwned:vi.fn(), persistBudget:vi.fn(async () => {}), resultReady:vi.fn(async () => {}),
    applying:vi.fn(async () => {}), succeeded:vi.fn(async () => {}), failed:vi.fn(async () => {}),
    stop:vi.fn(async () => {}), onProviderRequest:vi.fn(), onProviderUsage:vi.fn(),
    onProviderActivity:vi.fn(), onProviderQuiet:vi.fn(),
  },
  createModelTaskTracker:vi.fn(async () => db.tracker),
}))
vi.mock('../../server/db.js', () => db)
vi.mock('../../server/config.js', () => ({ JWT_SECRET:'manual-review-v3-worker-test-secret' }))
vi.mock('../../server/routes/ai/platform-content-access.js', () => ({ canManagePlatformAiContent:() => true }))
vi.mock('../../server/routes/ai/llm.js', () => ({ requestJsonObject:vi.fn() }))
vi.mock('../../server/routes/ai/model-task-tracker.js', () => ({ createModelTaskTracker:db.createModelTaskTracker }))
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

  it('binds the model output to the one frozen server-owned candidate identity', () => {
    const point = evidencePoint({ candidate_key:'anchor_minus_1', offset_bars:-1 })
    const malformedEcho = { ...candidate(), candidate_key:'not-a-candidate' }
    const normalized = __manualTradeReviewTest.normalizeManualTradeReviewV3PointForCandidate(
      malformedEcho, point, { strategySnapshot, allowedEvidenceRefs:[pointRef] })
    expect(normalized.candidate_key).toBe('anchor_minus_1')
    expect(normalized.decision).toBe(malformedEcho.decision)
    expect(normalized.protection_plan).toEqual(malformedEcho.protection_plan)
  })

  it('repairs only invalid point strategy paths from the frozen allow-list', () => {
    const initial = {
      ...candidate(),
      strategy_signals:[{
        ...candidate().strategy_signals[0],
        strategy_rule_path:'frozen_strategy.strategy_policy.entry.trend.enabled',
      }],
    }
    const validateOutput = value => normalizeManualTradeReviewCounterfactualPoint(value, {
      strategySnapshot, allowedEvidenceRefs:[pointRef],
    })
    const repair = __manualTradeReviewTest.manualTradeReviewPointPathRepairContext(strategySnapshot, validateOutput)
    const validationError = new Error('manual_trade_review_v3_strategy_rule_path_invalid')
    const validationContext = repair.validationContext({ validationError, initialObject:initial })
    expect(validationContext.targets).toEqual([{
      kind:'strategy_path', path:'strategy_signals[0].strategy_rule_path', signal_index:0,
      current_value:'frozen_strategy.strategy_policy.entry.trend.enabled',
    }])
    expect(validationContext.allowed_strategy_rule_paths).toContain('strategy_policy.entry.trend.enabled')
    const repairInput = repair.repairInput({ initialObject:initial, validationContext })
    expect(repairInput.repair_targets[0].strategy_signal.observation).toBe('冻结证据显示条件成立')
    const repaired = repair.applyRepairPatch({
      initialObject:initial, validationContext,
      repairPatch:{ changes:[{
        path:'strategy_signals[0].strategy_rule_path', value:'strategy_policy.entry.trend.enabled',
      }] },
    })
    expect(repaired.strategy_signals[0].strategy_rule_path).toBe('strategy_policy.entry.trend.enabled')
    expect(repaired.decision).toBe(initial.decision)
    expect(repaired.protection_plan).toEqual(initial.protection_plan)
  })

  it('rejects path repair patches outside the reported targets or frozen allow-list', () => {
    const initial = {
      ...candidate(),
      strategy_signals:[{ ...candidate().strategy_signals[0], strategy_rule_path:'$.strategy_policy.entry' }],
    }
    const validateOutput = value => normalizeManualTradeReviewCounterfactualPoint(value, {
      strategySnapshot, allowedEvidenceRefs:[pointRef],
    })
    const repair = __manualTradeReviewTest.manualTradeReviewPointPathRepairContext(strategySnapshot, validateOutput)
    const validationError = new Error('manual_trade_review_v3_strategy_rule_path_invalid')
    const validationContext = repair.validationContext({ validationError, initialObject:initial })
    expect(() => repair.applyRepairPatch({
      initialObject:initial, validationContext,
      repairPatch:{ changes:[{ path:'decision', value:'strategy_policy.entry.trend.enabled' }] },
    })).toThrow('point_repair_invalid')
    expect(() => repair.applyRepairPatch({
      initialObject:initial, validationContext,
      repairPatch:{ changes:[{
        path:'strategy_signals[0].strategy_rule_path', value:'strategy_policy.not_real',
      }] },
    })).toThrow('point_repair_invalid')
    const unrelatedError = new Error('manual_trade_review_v3_confidence_invalid')
    expect(() => repair.validationContext({ validationError:unrelatedError, initialObject:initial }))
      .toThrow('manual_trade_review_v3_confidence_invalid')
  })

  it('keeps non-final model task transitions in result-ready/applying/succeeded order', async () => {
    const review = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../../server/routes/ai/manual-trade-review.js', import.meta.url), 'utf8'))
    const stageStart = review.indexOf('async function runManualTradeReviewStage')
    const stageEnd = review.indexOf('function manualTradeReviewV3PointFailureStatus')
    const stageBlock = review.slice(stageStart, stageEnd)
    const stageReady = stageBlock.indexOf('await tracker.resultReady({ resultHash:normalized.normalizedOutputHash })')
    const finalApplyReturn = stageBlock.indexOf(
      'return { output:normalized.output, outputHash:normalized.normalizedOutputHash, skipped:false, tracker }')
    const nonFinalBlock = stageBlock.slice(finalApplyReturn)
    const stageApplying = finalApplyReturn + nonFinalBlock.indexOf('await tracker.applying()')
    const stageSucceeded = finalApplyReturn + nonFinalBlock.indexOf('await tracker.succeeded({ resultRef:`manual_trade_review_stage:')
    expect(stageReady).toBeGreaterThanOrEqual(0)
    expect(finalApplyReturn).toBeGreaterThan(stageReady)
    expect(stageReady).toBeLessThan(stageApplying)
    expect(stageApplying).toBeLessThan(stageSucceeded)

    const pointStart = review.indexOf('async function runManualTradeReviewV3Point')
    const pointEnd = review.indexOf('async function runManualTradeReviewV3Counterfactual')
    const pointBlock = review.slice(pointStart, pointEnd)
    const pointReady = pointBlock.indexOf('await tracker.resultReady({ resultHash:savedPoint.normalizedOutputHash })')
    const pointApplying = pointBlock.indexOf('await tracker.applying()', pointReady)
    const pointSucceeded = pointBlock.indexOf('await tracker.succeeded({ resultRef:`manual_trade_review_counterfactual:')
    expect(pointReady).toBeGreaterThanOrEqual(0)
    expect(pointReady).toBeLessThan(pointApplying)
    expect(pointApplying).toBeLessThan(pointSucceeded)
  })

  it('compares persisted point output canonically and keeps real conflicts', () => {
    const first = { candidate_key:'anchor', decision:'buy', protection_plan:{ stop_loss_price:1_990, take_profit_prices:[2_020] } }
    const reordered = { protection_plan:{ take_profit_prices:[2_020], stop_loss_price:1_990 }, decision:'buy', candidate_key:'anchor' }
    expect(__manualTradeReviewTest.manualTradeReviewCounterfactualValuesEqual(first, reordered)).toBe(true)
    expect(__manualTradeReviewTest.manualTradeReviewCounterfactualValuesEqual(first, { ...reordered, decision:'sell' })).toBe(false)
  })

  it('refreshes the generation ledger after point completion before selecting the bundle task', async () => {
    const review = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../../server/routes/ai/manual-trade-review.js', import.meta.url), 'utf8'))
    const pointCompleted = review.indexOf('normalizedCandidates.push(result.output)')
    const refreshedLedger = review.indexOf('const refreshedLedgerRows = await readManualTradeReviewCounterfactualPoints', pointCompleted)
    const bundleTask = review.indexOf('const bundleTaskId = refreshedLedgerRows.find', refreshedLedger)
    expect(pointCompleted).toBeGreaterThanOrEqual(0)
    expect(refreshedLedger).toBeGreaterThan(pointCompleted)
    expect(bundleTask).toBeGreaterThan(refreshedLedger)
    expect(review.slice(refreshedLedger, bundleTask)).not.toContain('ledgerRows.find(row => row.model_task_id || row.modelTaskId)')
  })

  it('marks a failed stage task and propagates the original request error', async () => {
    vi.clearAllMocks()
    const requestError = new Error('terminated')
    const requestModel = vi.fn(async () => { throw requestError })
    const lease = { signal:null, assertOwned:vi.fn() }
    const job = { id:19, case_id:7, generation_no:2, user_id:11, strategy_id:13, lease_token:'lease-1',
      attempt_count:2, max_attempts:3, task_deadline_at:'2099-01-01 00:00:00' }
    await expect(__manualTradeReviewTest.runManualTradeReviewStage({
      stage:'counterfactual', job, runtime:{ runtimeHash:'a'.repeat(64) }, runtimeHash:'a'.repeat(64),
      memorySnapshot:{}, stageRows:[{ stage:'counterfactual', status:'pending', model_task_id:null }],
      endpoint:{ url:'https://model.test', protocol:'chat' },
      resolved:{ model:{ provider:'openai', model:'model-a' }, model_profile_id:5, credential_source:'platform' },
      budget:{ selectedMaxOutputTokens:128 }, messages:{ user:'request' }, requestModel, lease,
      outputContractHash:'b'.repeat(64),
      validateOutput:value => value,
    })).rejects.toBe(requestError)
    expect(db.tracker.failed).toHaveBeenCalledWith(requestError, false)
    expect(db.tracker.stop).toHaveBeenCalled()

    db.tracker.failed.mockClear(); db.tracker.stop.mockClear()
    await expect(__manualTradeReviewTest.runManualTradeReviewStage({
      stage:'counterfactual', job:{ ...job, attempt_count:3 }, runtime:{ runtimeHash:'a'.repeat(64) }, runtimeHash:'a'.repeat(64),
      memorySnapshot:{}, stageRows:[{ stage:'counterfactual', status:'pending', model_task_id:null }],
      endpoint:{ url:'https://model.test', protocol:'chat' },
      resolved:{ model:{ provider:'openai', model:'model-a' }, model_profile_id:5, credential_source:'platform' },
      budget:{ selectedMaxOutputTokens:128 }, messages:{ user:'request' }, requestModel, lease,
      outputContractHash:'b'.repeat(64),
      validateOutput:value => value,
    })).rejects.toBe(requestError)
    expect(db.tracker.failed).toHaveBeenCalledWith(requestError, true)
    expect(db.tracker.stop).toHaveBeenCalled()

    db.tracker.failed.mockRejectedValueOnce(new Error('tracker update failed'))
    db.tracker.stop.mockClear()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(__manualTradeReviewTest.runManualTradeReviewStage({
      stage:'counterfactual', job, runtime:{ runtimeHash:'a'.repeat(64) }, runtimeHash:'a'.repeat(64),
      memorySnapshot:{}, stageRows:[{ stage:'counterfactual', status:'pending', model_task_id:null }],
      endpoint:{ url:'https://model.test', protocol:'chat' },
      resolved:{ model:{ provider:'openai', model:'model-a' }, model_profile_id:5, credential_source:'platform' },
      budget:{ selectedMaxOutputTokens:128 }, messages:{ user:'request' }, requestModel, lease,
      outputContractHash:'b'.repeat(64),
      validateOutput:value => value,
    })).rejects.toBe(requestError)
    expect(consoleError).toHaveBeenCalledWith('[ManualTradeReview] stage task failure update failed:', 'tracker update failed')
    expect(db.tracker.stop).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('only synchronizes a failed point after business retries are exhausted', () => {
    const status = __manualTradeReviewTest.manualTradeReviewV3PointFailureStatus
    expect(status({ saved:false, hold:false, businessAttemptsExhausted:false })).toBeNull()
    expect(status({ saved:false, hold:false, businessAttemptsExhausted:true })).toBe('failed')
    expect(status({ saved:false, hold:true, businessAttemptsExhausted:true })).toBe('status_unknown')
    expect(status({ saved:true, hold:false, businessAttemptsExhausted:true })).toBeNull()
    expect(status({ saved:true, hold:true, businessAttemptsExhausted:true })).toBeNull()
  })

  it('repairs only reported v3 outcome path fields and preserves review content', () => {
    const initial = {
      review_summary:'保持原复盘结论',
      technical_analysis_chain:[{
        method_label:'趋势规则', strategy_rule_paths:['frozen_strategy.strategy_policy.entry.trend.enabled'],
      }],
      rule_comparisons:[{ status:'unknown', rule_path:null, rule_summary:'保持原比较' }],
      strategy_optimization_hypotheses:[{
        target_path:'$.strategy_policy.entry.trend.enabled', proposed_change:'保持原建议',
      }],
    }
    const validateOutput = vi.fn(value => value)
    const repair = __manualTradeReviewTest.manualTradeReviewOutcomePathRepairContext(strategySnapshot, validateOutput)
    const validationError = new Error('manual_trade_review_v3_strategy_rule_path_invalid')
    const validationContext = repair.validationContext({ validationError, initialObject:initial })
    expect(validationContext.targets.map(target => target.path)).toEqual([
      'technical_analysis_chain[0].strategy_rule_paths[0]',
      'strategy_optimization_hypotheses[0].target_path',
    ])
    const repaired = repair.applyRepairPatch({
      initialObject:initial, validationContext,
      repairPatch:{ changes:validationContext.targets.map(target => ({
        path:target.path, value:'strategy_policy.entry.trend.enabled',
      })) },
    })
    expect(repaired.technical_analysis_chain[0].strategy_rule_paths[0])
      .toBe('strategy_policy.entry.trend.enabled')
    expect(repaired.strategy_optimization_hypotheses[0].target_path)
      .toBe('strategy_policy.entry.trend.enabled')
    expect(repaired.review_summary).toBe('保持原复盘结论')
    expect(repaired.rule_comparisons[0]).toEqual(initial.rule_comparisons[0])
    expect(validateOutput).toHaveBeenCalledOnce()
  })

  it('uses a full-object v3 repair fallback for non-path outcome validation errors', () => {
    const repair = __manualTradeReviewTest.manualTradeReviewOutcomePathRepairContext(strategySnapshot, value => value, {
      allowedEvidenceRefs:[pointRef], allowedSourceRefs:['trade-a'],
    })
    const validationContext = repair.validationContext({
      validationError:Object.assign(new Error('manual_trade_review_v3_supporting_review_refs_invalid'), {
        code:'manual_trade_review_v3_supporting_review_refs_invalid',
      }),
      initialObject:{ review_summary:'原始结论' },
    })
    expect(validationContext.targets).toEqual([])
    expect(validationContext.allowed_evidence_refs).toEqual([pointRef])
    expect(validationContext.allowed_source_refs).toEqual(['trade-a'])
    expect(validationContext.allowed_strategy_rule_paths)
      .toContain('strategy_policy.entry.trend.enabled')
    expect(repair.outputFormat).toContain('manual-trade-review-v3')
    expect(repair.repairInstructions).toContain('allowed_evidence_refs')
    expect(repair.repairInstructions).toContain('不得改变原复盘结论')
  })

  it('marks the current stage failed only after the final business attempt', async () => {
    const requestError = Object.assign(new Error('manual_trade_review_v3_technical_evidence_refs_invalid'), {
      code:'manual_trade_review_v3_technical_evidence_refs_invalid',
    })
    const requestModel = vi.fn(async () => { throw requestError })
    const lease = { signal:null, assertOwned:vi.fn() }
    const job = { id:19, case_id:7, generation_no:2, user_id:11, strategy_id:13, lease_token:'lease-1',
      attempt_count:3, max_attempts:3, task_deadline_at:'2099-01-01 00:00:00' }
    vi.clearAllMocks()
    const stageWrites = []
    db.withTransaction.mockImplementation(async callback => callback(async (sql, params) => {
      stageWrites.push({ sql, params })
      return [{ affectedRows:1 }, []]
    }))
    await expect(__manualTradeReviewTest.runManualTradeReviewStage({
      stage:'outcome_review', job, runtime:{ runtimeHash:'a'.repeat(64) }, runtimeHash:'a'.repeat(64),
      memorySnapshot:{}, stageRows:[{ stage:'outcome_review', status:'running', model_task_id:null }],
      endpoint:{ url:'https://model.test', protocol:'chat' },
      resolved:{ model:{ provider:'openai', model:'model-a' }, model_profile_id:5, credential_source:'platform' },
      budget:{ selectedMaxOutputTokens:128 }, messages:{ user:'request' }, requestModel, lease,
      outputContractHash:'b'.repeat(64), validateOutput:value => value,
    })).rejects.toBe(requestError)
    expect(db.withTransaction).toHaveBeenCalledOnce()
    expect(stageWrites[0].sql).toContain("SET stages.status = ?")
    expect(stageWrites[0].sql).toContain('jobs.lease_token = ?')
    expect(stageWrites[0].params).toEqual(expect.arrayContaining([
      'failed', 'manual_trade_review_v3_technical_evidence_refs_invalid', 19, 2, 'outcome_review', 'lease-1',
    ]))
    expect(db.tracker.failed).toHaveBeenCalledWith(requestError, true)

    vi.clearAllMocks()
    await expect(__manualTradeReviewTest.runManualTradeReviewStage({
      stage:'outcome_review', job:{ ...job, attempt_count:2 }, runtime:{ runtimeHash:'a'.repeat(64) }, runtimeHash:'a'.repeat(64),
      memorySnapshot:{}, stageRows:[{ stage:'outcome_review', status:'running', model_task_id:null }],
      endpoint:{ url:'https://model.test', protocol:'chat' },
      resolved:{ model:{ provider:'openai', model:'model-a' }, model_profile_id:5, credential_source:'platform' },
      budget:{ selectedMaxOutputTokens:128 }, messages:{ user:'request' }, requestModel, lease,
      outputContractHash:'b'.repeat(64), validateOutput:value => value,
    })).rejects.toBe(requestError)
    expect(db.withTransaction).not.toHaveBeenCalled()
    expect(db.tracker.failed).toHaveBeenCalledWith(requestError, false)

    vi.clearAllMocks()
    const terminalTaskError = Object.assign(new Error('manual_trade_review_model_task_terminal_requires_retry'), {
      code:'manual_trade_review_model_task_terminal_requires_retry', manualTradeReviewTerminalTask:true,
    })
    const terminalRequestModel = vi.fn(async () => { throw terminalTaskError })
    await expect(__manualTradeReviewTest.runManualTradeReviewStage({
      stage:'outcome_review', job:{ ...job, attempt_count:2 }, runtime:{ runtimeHash:'a'.repeat(64) }, runtimeHash:'a'.repeat(64),
      memorySnapshot:{}, stageRows:[{ stage:'outcome_review', status:'running', model_task_id:null }],
      endpoint:{ url:'https://model.test', protocol:'chat' },
      resolved:{ model:{ provider:'openai', model:'model-a' }, model_profile_id:5, credential_source:'platform' },
      budget:{ selectedMaxOutputTokens:128 }, messages:{ user:'request' }, requestModel:terminalRequestModel, lease,
      outputContractHash:'b'.repeat(64), validateOutput:value => value,
    })).rejects.toBe(terminalTaskError)
    expect(db.withTransaction).toHaveBeenCalledOnce()
    expect(db.tracker.failed).toHaveBeenCalledWith(terminalTaskError, true)

    vi.clearAllMocks()
    db.createModelTaskTracker.mockRejectedValueOnce(new Error('tracker unavailable'))
    await expect(__manualTradeReviewTest.runManualTradeReviewStage({
      stage:'outcome_review', job, runtime:{ runtimeHash:'a'.repeat(64) }, runtimeHash:'a'.repeat(64),
      memorySnapshot:{}, stageRows:[{ stage:'outcome_review', status:'running', model_task_id:null }],
      endpoint:{ url:'https://model.test', protocol:'chat' },
      resolved:{ model:{ provider:'openai', model:'model-a' }, model_profile_id:5, credential_source:'platform' },
      budget:{ selectedMaxOutputTokens:128 }, messages:{ user:'request' }, requestModel, lease,
      outputContractHash:'b'.repeat(64), validateOutput:value => value,
    })).rejects.toThrow('tracker unavailable')
    expect(db.withTransaction).toHaveBeenCalledOnce()
  })

  it('keeps the original business error when final stage synchronization fails', async () => {
    const requestError = Object.assign(new Error('manual_trade_review_v3_json_invalid'), {
      code:'manual_trade_review_v3_json_invalid',
    })
    const requestModel = vi.fn(async () => { throw requestError })
    const lease = { signal:null, assertOwned:vi.fn() }
    const job = { id:19, case_id:7, generation_no:2, user_id:11, strategy_id:13, lease_token:'lease-1',
      attempt_count:3, max_attempts:3, task_deadline_at:'2099-01-01 00:00:00' }
    vi.clearAllMocks()
    db.withTransaction.mockImplementation(async callback => callback(async () => [{ affectedRows:1 }, []]))
    db.withTransaction.mockImplementationOnce(() => { throw new Error('stage sync unavailable') })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(__manualTradeReviewTest.runManualTradeReviewStage({
      stage:'outcome_review', job, runtime:{ runtimeHash:'a'.repeat(64) }, runtimeHash:'a'.repeat(64),
      memorySnapshot:{}, stageRows:[{ stage:'outcome_review', status:'running', model_task_id:null }],
      endpoint:{ url:'https://model.test', protocol:'chat' },
      resolved:{ model:{ provider:'openai', model:'model-a' }, model_profile_id:5, credential_source:'platform' },
      budget:{ selectedMaxOutputTokens:128 }, messages:{ user:'request' }, requestModel, lease,
      outputContractHash:'b'.repeat(64), validateOutput:value => value,
    })).rejects.toBe(requestError)
    expect(consoleError).toHaveBeenCalledWith('[ManualTradeReview] stage status failure update failed:', 'stage sync unavailable')
    consoleError.mockRestore()
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
    expect(review).toContain('allowFollowupRequests:true')
    expect(review).toContain('repairContext:createManualTradeReviewPointRepairContext({')
    expect(review).toContain('strategyDeclaredTimeframes:deriveManualTradeReviewDeclaredTimeframes(strategySnapshot)')
    expect(review).toContain('evidenceAvailableTimeframes:deriveManualTradeReviewEvidenceTimeframes(point.market_data)')
    expect(review).toContain('repairContext:outcomeRepairContext')
    expect(review).toContain('allowFollowupRequests:Boolean(repairContext)')
    expect(review).toContain('idempotencyKey, inputHash, snapshotHash:runtimeHash')
    const memoryUsageKinds = [
      'manual_review_cf_point', 'manual_review_counterfactual', 'manual_review_outcome',
    ]
    for (const usageKind of memoryUsageKinds) {
      expect(review).toContain(usageKind)
      expect(usageKind.length).toBeLessThanOrEqual(32)
    }
    expect(review).not.toContain('manual_trade_review_counterfactual_point_${point.candidate_key}')
    expect(review).not.toContain('injectionKind:`manual_trade_review_${stage}`')
  })
})
