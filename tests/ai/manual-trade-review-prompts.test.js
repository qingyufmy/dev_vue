import { describe, expect, it } from 'vitest'
import { createManualTradeReviewPrompts } from '../../server/routes/ai/manual-trade-review-prompts.js'
import { buildFrozenStrategyPaths, validateFrozenStrategyPath } from '../../server/routes/ai/manual-trade-review-contract.js'

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

const strategySnapshot = {
  version:4,
  strategy_policy:{ entry:{ mode:'declared_by_strategy', filters:[{ id:'trend', enabled:true }, { id:'trend', enabled:true }] },
    protection:{ mode:'structure' }, ['constructor']:'must not become a path', ['$bad']:'must not become a path' },
  market_data_plan:{ timeframes:[{ timeframe:'M15' }, { timeframe:'H1' }] },
  entry_methods:['market', 'limit'], symbols:['XAUUSD', 'XAUUSD'], use_chan_analysis:true,
  other_root:{ ignored:'not an allowed strategy root' },
}

const reviewCase = {
  strategy_snapshot_json:JSON.stringify(strategySnapshot),
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
  it('enumerates stable legal frozen strategy paths across objects and arrays', () => {
    const paths = buildFrozenStrategyPaths(strategySnapshot)
    expect(paths).toEqual([...paths].sort())
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).toEqual(expect.arrayContaining([
      'strategy_policy', 'strategy_policy.entry', 'strategy_policy.entry.mode',
      'strategy_policy.entry.filters', 'strategy_policy.entry.filters[0]',
      'strategy_policy.entry.filters[0].enabled', 'strategy_policy.entry.filters[0].id',
      'market_data_plan.timeframes[1].timeframe', 'entry_methods[0]', 'symbols[1]',
      'use_chan_analysis',
    ]))
    expect(paths.some(path => path.startsWith('other_root'))).toBe(false)
    expect(paths.some(path => path.includes('constructor') || path.includes('$bad'))).toBe(false)
    expect(() => validateFrozenStrategyPath('strategy_policy.entry.not_present', strategySnapshot))
      .toThrow('manual_trade_review_output_rule_path_unknown')
    expect(() => validateFrozenStrategyPath('frozen_strategy.strategy_policy.entry', strategySnapshot))
      .toThrow('manual_trade_review_output_rule_path_invalid')
  })

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
    expect(system).toContain('每条 strategy_signal 的全部 evidence_refs 必须与该条 timeframe 完全同周期')
    expect(system).toContain('一个观察涉及多个周期时必须拆成多条 strategy_signal')
    expect(system).toContain('严禁在同一条中混用不同周期引用')
    expect(system).toContain('strategy_rule_path、rule_path、target_path 必须逐字复制')
    expect(system).toContain('frozen_strategy.')
    expect(system).toContain('$')
    expect(system).toContain('/')
    expect(user).toContain(`<allowed_strategy_rule_paths>${JSON.stringify(buildFrozenStrategyPaths(strategySnapshot))}</allowed_strategy_rule_paths>`)
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
    expect(system).toContain('strategy_rule_path、rule_path、target_path 必须逐字复制')
    expect(system).toContain('origin 为 strategy_derived 时 strategy_rule_paths 必须至少包含一项')
    expect(system).toContain('origin 为 manual_logic_inferred 或 unexplained 时 strategy_rule_paths 必须是空数组')
    expect(system).toContain('frozen_strategy.')
    expect(system).toContain('$')
    expect(system).toContain('/')
    expect(user).toContain(`<allowed_strategy_rule_paths>${JSON.stringify(buildFrozenStrategyPaths(strategySnapshot))}</allowed_strategy_rule_paths>`)
    expect(user).toContain('<frozen_trade_outcome>')
    expect(user).toContain('exit_price')
    expect(user).toContain('hindsight thesis')
  })
})
