import { describe, expect, it } from 'vitest'
import { createManualTradeReviewPrompts } from '../../server/routes/ai/manual-trade-review-prompts.js'

function parse(value, fallback = null) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function text(value, max = 6_000) {
  return String(value == null ? '' : value).trim().slice(0, max)
}

const prompts = createManualTradeReviewPrompts({
  parse,
  text,
  maxThesis:2_000,
  counterfactualOutputVersion:'manual-trade-counterfactual-v1',
  buildManualReviewEvidenceCatalog:() => ({
    pre_entry_refs:['pre:trade-a:anchor'],
    outcome_refs:['outcome:trade-a'],
  }),
  manualTradeReviewOutputContract:() => ({ output_contract_version:'manual-trade-review-v2' }),
})

const reviewCase = {
  strategy_snapshot_json:JSON.stringify({ version:4, strategy_policy:{ entry:{ mode:'declared_by_strategy' } } }),
  user_thesis_text:'hindsight thesis must stay out of stage A',
  evidence_status:'complete',
  evidence_reason:null,
  evidence_json:JSON.stringify({ market_data:{ trades:{ 'trade-a':{
    pre_entry:{ status:'complete' },
    candidate_points:{ anchor_minus_1:{ market_data:{ status:'complete' } } },
    outcome_path:{ status:'complete', metrics:{ exit_price:1.2222 } },
  } } } }),
}

const source = {
  source_identity_hash:'trade-a',
  normalized_trade_json:JSON.stringify({ direction:'buy', entry_price:1.1111, stop_loss:1.1,
    take_profit:1.2, net_profit:42, close_price:1.2222 }),
}

describe('manual trade review v3 prompts', () => {
  it('keeps each point blind to actual trade fields and contains one frozen candidate', () => {
    const messages = prompts.counterfactualPointPrompt(reviewCase, [source], {
      candidate_key:'anchor_minus_1', decision_time_utc_msc:900, terminal_time:'2026-08-10 12:00:00',
      primary_timeframe:'M15', offset_bars:-1, market_snapshot_hash:'snapshot-point', input_hash:'input-point',
      allowed_evidence_refs:['pre:trade-a:anchor_minus_1'],
      closed_market_data:{ status:'complete', timeframes:{ M15:{ closed_bar_time_utc_msc:900 } } },
    }, { version_no:8, content_hash:'memory-hash', content_text:'经验参考' })
    const system = messages[0].content
    const user = messages[1].content
    expect(user).toContain('<frozen_candidate_point>')
    expect(user).toContain('anchor_minus_1')
    expect(user).not.toContain('anchor_plus_1')
    expect(system).toContain('strategy_signals')
    expect(system).toContain('protection_plan')
    expect(system).toContain('真实手动订单的方向')
    expect(user).not.toContain('"direction":"buy"')
    expect(user).not.toContain('1.1111')
    expect(user).not.toContain('1.1')
    expect(user).not.toContain('1.2')
    expect(user).not.toContain('42')
    expect(user).not.toContain('hindsight thesis')
    expect(user).not.toContain('outcome_path')
  })

  it('freezes all point outputs and server-derived facts for the v3 outcome prompt', () => {
    const messages = prompts.outcomeReviewV3Prompt(reviewCase, [source], [
      { candidate_key:'anchor_minus_1', decision:'hold', protection_plan:{ position_size_tier:'none' } },
      { candidate_key:'anchor', decision:'buy', protection_plan:{ position_size_tier:'probe' } },
    ], {
      server_derived_direction_match:'same_direction_entry',
      first_same_direction_candidate:'anchor', timing_difference_bars:0,
      protection_quality:'partial', execution_feasibility:'pass',
    }, { version_no:8, content_hash:'memory-hash', content_text:'经验参考' })
    const system = messages[0].content
    const user = messages[1].content
    expect(user).toContain('<frozen_candidate_points>')
    expect(user).toContain('anchor_minus_1')
    expect(user).toContain('anchor')
    expect(user).toContain('<server_derived_summary>')
    expect(user).toContain('same_direction_entry')
    expect(system).toContain('technical_analysis_chain')
    expect(system).toContain('rule_comparisons')
    expect(system).toContain('strategy_optimization_hypotheses')
    expect(system).toContain('不得返回、修改、覆盖或重新解释')
    expect(system).toContain('server_derived_direction_match')
    expect(user).toContain('<frozen_trade_outcome>')
    expect(user).toContain('exit_price')
    expect(user).toContain('hindsight thesis')
  })
})
