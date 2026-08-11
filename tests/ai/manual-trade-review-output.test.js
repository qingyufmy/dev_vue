import { describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  beijingNow:vi.fn(() => '2026-08-10 12:00:00'), queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
}))
vi.mock('../../server/db.js', () => db)
vi.mock('../../server/routes/ai/platform-content-access.js', () => ({ canManagePlatformAiContent:() => true }))
vi.mock('../../server/routes/ai/llm.js', () => ({ requestJsonObject:vi.fn() }))
vi.mock('../../server/routes/ai/model-providers.js', () => ({ MODEL_PROVIDER_DEFAULTS:{}, modelProviderProtocol:() => 'chat' }))
vi.mock('../../server/routes/ai/model-profiles.js', () => ({ resolveAiTaskModel:vi.fn() }))
vi.mock('../../server/routes/ai/inference-snapshots.js', () => ({ sha256:value => `hash:${String(value)}` }))
vi.mock('../../server/routes/ai/manual-trade-evidence.js', () => ({
  MANUAL_TRADE_SELECTION_MAX:1,
  getCurrentManualReviewAccount:vi.fn(), listEligibleManualTrades:vi.fn(), readManualTradeEvidence:vi.fn(),
  normalizedTradeHash:value => `hash:${String(value)}`,
}))

import { __manualTradeReviewTest, manualTradeReviewOutputContract, validateCounterfactualAnalysis,
  validateManualTradeReviewContent, validateManualTradeSelection, recoverAbandonedManualTradeReviewJobs } from '../../server/routes/ai/manual-trade-review.js'

const source = { source_identity_hash:'trade-a', normalized_trade_json:JSON.stringify({
  symbol:'EURUSD', direction:'buy', entry_time_utc_msc:1_000, close_time_utc_msc:2_000, net_profit:10,
}) }
const counterfactual = { decision:'buy', reasoning:'strategy allowed long', strategy_signals:['trend'], blocking_rules:[], confidence:.7 }

function validContent(overrides = {}) {
  return {
    counterfactual_analysis:counterfactual, evidence_quality:'complete', review_summary:'review',
    strategy_alignment:'partial', decision_quality:'mixed', counterfactual_match:'same_direction',
    why_profitable:'trend continuation', profit_attribution:{ market_fit:'fit' },
    strategy_optimization_hypotheses:[{ hypothesis_id:'h1', supporting_trade_refs:['trade-a'],
      state:'hypothesis', target_path:'strategy_policy_json.entry', proposed_change:'observe pullback' }],
    ...overrides,
  }
}

describe('manual profitable trade counterfactual review contract', () => {
  it('uses the v2 two-stage contract and only hypothesis-level optimization', () => {
    expect(manualTradeReviewOutputContract(1)).toMatchObject({
      output_contract_version:'manual-trade-review-v2', strategy_optimization_state:'hypothesis|insufficient_evidence',
    })
    expect(validateCounterfactualAnalysis(counterfactual)).toMatchObject({
      output_contract_version:'manual-trade-counterfactual-v1', decision:'buy', confidence:.7,
    })
  })

  it('normalizes one frozen source and never emits experience candidates', () => {
    const content = validateManualTradeReviewContent(validContent({ review_summary:'  user text\u0000 ' }), [source], { version:4 }, { evidenceStatus:'complete' })
    expect(content.review_summary).toBe('user text')
    expect(content.counterfactual_analysis.decision).toBe('buy')
    expect(content.strategy_optimization_hypotheses[0]).toMatchObject({ state:'hypothesis', target_path:'strategy_policy_json.entry' })
    expect(content).not.toHaveProperty('experience_candidates')
  })

  it('requires exactly one source and one selected trade', () => {
    expect(() => validateManualTradeSelection([])).toThrow('manual_trade_review_selection_invalid')
    expect(() => validateManualTradeSelection([
      { source_identity_hash:'a', trade_source_hash:'h1' }, { source_identity_hash:'b', trade_source_hash:'h2' },
    ])).toThrow('manual_trade_review_selection_invalid')
    expect(() => validateManualTradeReviewContent(validContent(), [source, { source_identity_hash:'trade-b' }], {}, { evidenceStatus:'complete' }))
      .toThrow('manual_trade_review_selection_invalid')
  })

  it('rejects unknown references, rule paths, and enum drift', () => {
    expect(() => validateManualTradeReviewContent(validContent({ strategy_optimization_hypotheses:[{
      supporting_trade_refs:['other'], state:'hypothesis', proposed_change:'x',
    }] }), [source], {}, { evidenceStatus:'complete' })).toThrow('manual_trade_review_output_reference_invalid')
    expect(() => validateManualTradeReviewContent(validContent({ rule_comparisons:[{ rule_path:'system_prompt', status:'conflict' }] }),
      [source], {}, { evidenceStatus:'complete' })).toThrow('manual_trade_review_output_rule_path_invalid')
    expect(() => validateManualTradeReviewContent(validContent({ counterfactual_match:'invented' }),
      [source], {}, { evidenceStatus:'complete' })).toThrow('manual_trade_review_output_enum_invalid')
  })

  it('downgrades optimization hypotheses when frozen evidence is incomplete', () => {
    const content = validateManualTradeReviewContent(validContent({ evidence_quality:'partial' }), [source], {}, { evidenceStatus:'partial' })
    expect(content.strategy_optimization_hypotheses[0]).toMatchObject({ state:'insufficient_evidence' })
  })

  it('keeps future outcome and user thesis out of the counterfactual prompt', () => {
    const reviewCase = {
      strategy_snapshot_json:JSON.stringify({ id:3, version:2 }), user_thesis_text:'I knew it would profit',
      evidence_json:JSON.stringify({ market_data:{ trades:{ 'trade-a':{
        pre_entry:{ status:'complete', timeframes:{ M15:{ candles:[{ time_utc_msc:900 }] } } },
        outcome_path:{ status:'complete', metrics:{ exit_price:1.2 } },
      } } } }),
    }
    const messages = __manualTradeReviewTest.counterfactualPrompt(reviewCase, [source])
    expect(messages[1].content).toContain('pre_entry_market_data')
    expect(messages[1].content).not.toContain('I knew it would profit')
    expect(messages[1].content).not.toContain('exit_price')
    expect(messages[1].content).not.toContain('"direction":"buy"')
    expect(messages[1].content).not.toContain('net_profit')
  })

  it('freezes stage A into the outcome prompt together with actual outcome evidence', () => {
    const messages = __manualTradeReviewTest.outcomeReviewPrompt({
      strategy_snapshot_json:'{}', user_thesis_text:'my thesis', evidence_status:'complete',
      evidence_json:JSON.stringify({ market_data:{ hash:'market-hash', trades:{ 'trade-a':{ outcome_path:{ metrics:{ exit_price:1.2 } } } } } }),
    }, [source], validateCounterfactualAnalysis(counterfactual))
    expect(messages[1].content).toContain('frozen_counterfactual')
    expect(messages[1].content).toContain('exit_price')
    expect(messages[1].content).toContain('my thesis')
  })

  it('fails closed after an expired two-stage provider lease', async () => {
    db.queryAll.mockResolvedValueOnce([{ id:19, case_id:23, attempt_count:1, max_attempts:3, progress_stage:'counterfactual_analysis' }])
    db.queryRun.mockResolvedValue({ changes:1 })
    const result = await recoverAbandonedManualTradeReviewJobs({ now:'2026-08-10 12:00:00', limit:10 })
    expect(result).toMatchObject({ scanned:1, requeued:0, failed:1, manual_retry_required:1 })
  })
})
