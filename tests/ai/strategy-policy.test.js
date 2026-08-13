import { describe, expect, it } from 'vitest'
import {
  normalizeEntryMethods,
  normalizeMarketDataPlan,
  normalizeUseChanAnalysis,
  parseStrategyPolicy,
  prepareStrategyDataRuntime,
  buildStrategyRuntimeSnapshot,
  signalTypesForEntryMethods,
} from '../../server/routes/ai/strategy-policy.js'

function declaredEmaPolicy(mode = 'enforce') {
  return {
    schema_version:'strategy-policy-v1', mode,
    indicators:[{
      id:'entry_ema34', kind:'ema', enabled:true,
      source:{ timeframe:'M5', field:'close', bar_scope:'closed_only' },
      params:{ period:34, minimum_bars:34, warmup_target_bars:34 },
    }],
    workflow:{ stages:[], selectors:[], default_decision:'allow' },
    constraints:[], prompt_rules:[], ui:{ groups:[] },
  }
}

describe('strategy policy', () => {
  it('normalizes and deduplicates supported entry methods', () => {
    expect(normalizeEntryMethods(['MARKET', 'limit', 'market', 'invalid'])).toEqual(['market', 'limit'])
    expect(signalTypesForEntryMethods(['market', 'stop'])).toEqual(['buy_stop', 'sell_stop', 'buy', 'sell', 'hold'])
  })

  it('rejects a strategy without any supported entry method', () => {
    expect(() => normalizeEntryMethods([])).toThrow('entry_methods_required')
  })

  it('normalizes structured K-line plans and keeps the requested primary timeframe first', () => {
    expect(normalizeMarketDataPlan({
      primary_timeframe: 'H1',
      timeframes: [
        { timeframe: 'M15', kline_count: 2 },
        { timeframe: 'H1', kline_count: 900 },
        { timeframe: 'M15', kline_count: 200 },
        { timeframe: 'INVALID', kline_count: 100 },
      ],
    })).toEqual({
      primary_timeframe: 'H1',
      timeframes: [
        { timeframe: 'H1', kline_count: 500 },
        { timeframe: 'M15', kline_count: 10 },
      ],
    })
  })

  it('migrates legacy timeframe tags when structured plan is absent', () => {
    const policy = parseStrategyPolicy({
      system_prompt: '分析黄金 {{ATF:M15:120}} 和 {{CTF:H1:80}} {{USE_CHAN}}',
      entry_methods_json: '["limit"]',
    })
    expect(policy.entryMethods).toEqual(['limit'])
    expect(policy.useChanAnalysis).toBe(true)
    expect(policy.marketDataPlan).toEqual({
      primary_timeframe: 'M15',
      timeframes: [
        { timeframe: 'M15', kline_count: 120 },
        { timeframe: 'H1', kline_count: 80 },
      ],
    })
  })

  it('uses the structured Chan switch as the authority over legacy prompt tags', () => {
    expect(normalizeUseChanAnalysis(1)).toBe(true)
    expect(parseStrategyPolicy({ system_prompt: '{{USE_CHAN}}', use_chan_analysis: 0 }).useChanAnalysis).toBe(false)
  })

  it('rejects unsupported Chan periods while retaining them for ordinary market data when disabled', () => {
    expect(() => parseStrategyPolicy({ use_chan_analysis:1, market_data_plan:{ timeframes:[{ timeframe:'M1', kline_count:100 }] } }))
      .toThrow('chan_timeframe_unsupported')
    expect(parseStrategyPolicy({ use_chan_analysis:0, market_data_plan:{ timeframes:[{ timeframe:'M1', kline_count:100 }] } }).marketDataPlan.timeframes[0].timeframe)
      .toBe('M1')
  })

  it('compiles an explicit declaration and computes only its generic indicator data', () => {
    const strategyPolicy = declaredEmaPolicy()
    const strategy = {
      market_data_plan:{ primary_timeframe:'M5', timeframes:[{ timeframe:'M5', kline_count:60 }] },
      strategy_policy_json:JSON.stringify(strategyPolicy), use_ema34_filter:0,
    }
    const parsed = parseStrategyPolicy(strategy)
    expect(parsed.policyMode).toBe('enforce')
    expect(parsed.compiledPolicy).toMatchObject({ mode:'enforce', indicators:[{ id:'entry_ema34', kind:'ema', source:{ timeframe:'M5' } }] })
    const bars = Array.from({ length:34 }, (_, index) => ({
      time_utc_msc:1_000 + index * 300_000, open:index + 1, high:index + 1, low:index + 1, close:index + 1,
    }))
    const context = { policyIndicatorSources:{ M5:{ bars, lastBarClosed:true, marketSource:'fixture' } } }
    const runtime = prepareStrategyDataRuntime(parsed, context)
    expect(runtime).toMatchObject({ data_runtime_version:'strategy-data-runtime-v1', mode:'enforce', policy_hash:parsed.compiledPolicy.policy_hash,
      indicators:{ entry_ema34:{ ready:true, source:{ timeframe:'M5', market_source:'fixture' } } },
      input_sources:{ M5:{ timeframe:'M5', bar_count:34, market_source:'fixture', last_bar_closed:true } },
      audit_identity:{ policy_hash:parsed.compiledPolicy.policy_hash, indicator_algorithm_version:expect.any(String) } })
    expect(context).not.toHaveProperty('indicators')
  })

  it('does not inject data for an undeclared policy or the legacy EMA switch', () => {
    const parsed = parseStrategyPolicy({
      market_data_plan:{ primary_timeframe:'M5', timeframes:[{ timeframe:'M5', kline_count:60 }] },
      use_ema34_filter:1,
    })
    expect(parsed).toMatchObject({ policyMode:'off', strategyPolicy:null, compiledPolicy:null, useEma34Filter:true })
    expect(prepareStrategyDataRuntime(parsed, { policyIndicatorSources:{} })).toBeNull()
  })

  it('fails closed for an explicitly invalid policy instead of treating it as off', () => {
    expect(() => parseStrategyPolicy({
      market_data_plan:{ primary_timeframe:'M5', timeframes:[{ timeframe:'M5', kline_count:60 }] },
      strategy_policy_json:JSON.stringify({ schema_version:'unsupported', mode:'enforce' }),
    })).toThrow('policy_schema_unsupported')
    expect(() => parseStrategyPolicy({
      strategy_policy_json:'{not-json',
    })).toThrow('policy_json_invalid')
  })

  it('does not calculate indicators for an explicitly off policy', () => {
    const parsed = parseStrategyPolicy({ strategy_policy_json:JSON.stringify(declaredEmaPolicy('off')),
      market_data_plan:{ primary_timeframe:'M5', timeframes:[{ timeframe:'M5', kline_count:60 }] } })
    expect(parsed.policyMode).toBe('off')
    expect(parsed.compiledPolicy).toMatchObject({ mode:'off' })
    expect(prepareStrategyDataRuntime(parsed, { policyIndicatorSources:{} })).toBeNull()
  })

  it('freezes the data runtime in the strategy snapshot without adding policy decisions', () => {
    const parsed = parseStrategyPolicy({
      market_data_plan:{ primary_timeframe:'M5', timeframes:[{ timeframe:'M5', kline_count:60 }] },
      strategy_policy_json:JSON.stringify(declaredEmaPolicy()),
    })
    const bars = Array.from({ length:34 }, (_, index) => ({
      time_utc_msc:1_000 + index * 300_000, open:index + 1, high:index + 1, low:index + 1, close:index + 1,
    }))
    const dataRuntime = prepareStrategyDataRuntime(parsed, { policyIndicatorSources:{
      M5:{ bars, lastBarClosed:true, marketSource:'fixture' },
    } })
    const snapshot = buildStrategyRuntimeSnapshot({ strategy:{ id:1, version:2 }, policy:parsed, strategyDataRuntime:dataRuntime })
    expect(snapshot).toMatchObject({ data_runtime_version:'strategy-data-runtime-v1', compiled_policy:{ policy_hash:parsed.compiledPolicy.policy_hash },
      indicators:{ entry_ema34:{ ready:true } }, input_sources:{ M5:{ bar_count:34 } } })
    expect(snapshot.workflow_state).toBeUndefined()
    expect(snapshot.constraint_results).toBeUndefined()
    expect(snapshot.prompt_renderer).toBeUndefined()
  })

  it('builds a frozen base runtime even when the policy compiler is off', () => {
    const runtime = buildStrategyRuntimeSnapshot({ strategy:{ id:7, version:3, scope:'private' }, policy:{
      marketDataPlan:{ primary_timeframe:'M1', timeframes:[{ timeframe:'M1', kline_count:100 }] },
      entryMethods:['market'], useChanAnalysis:false, policyMode:'off', compiledPolicy:null,
    } })
    expect(runtime).toMatchObject({ strategy_id:7, strategy_version:3, scope:'private', use_chan_analysis:false,
      entry_methods:['market'], window_policy_version:'chan_window_v6' })
    expect(runtime.runtime_config_hash).toMatch(/^[a-f0-9]{64}$/)
  })
})
