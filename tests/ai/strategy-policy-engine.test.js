import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { compileStrategyPolicy, StrategyPolicyValidationError } from '../../server/routes/ai/strategy-policy-compiler.js'
import { calculateIndicator, calculatePolicyIndicators } from '../../server/routes/ai/indicator-registry.js'
import { applyConstraintAction, evaluateStrategyConstraints } from '../../server/routes/ai/strategy-constraint-engine.js'
import { evaluateFrozenStrategyPolicyForSubmission, evaluateSignalStrategyPolicyBeforeSubmission } from '../../server/routes/ai/strategy-policy-execution.js'
import { validateWorkflowTrace, workflowGateEvaluation } from '../../server/routes/ai/strategy-workflow-engine.js'
import { renderStrategyPolicyPrompt } from '../../server/routes/ai/strategy-prompt-renderer.js'
import { parseStrategyPolicy } from '../../server/routes/ai/strategy-policy.js'

function plan(...timeframes) {
  return { timeframes:timeframes.map(timeframe => ({ timeframe, kline_count:100 })) }
}

function policyFixture({ indicatorKind = 'ema', period = 3 } = {}) {
  return {
    schema_version:'strategy-policy-v1',
    mode:'enforce',
    indicators:[{
      id:'entry_average', kind:indicatorKind, enabled:true,
      source:{ timeframe:'M30', field:'close', bar_scope:'closed_only' },
      params:{ period, minimum_bars:period, warmup_target_bars:period + 2 },
    }],
    workflow:{
      stages:[
        { id:'primary', kind:'model_assessment', source:{ timeframe:'M30' }, output_states:['up','down','unclear','unavailable'] },
        { id:'fallback', kind:'model_assessment', source:{ timeframe:'D1' }, output_states:['up','down','unclear','unavailable'],
          run_if:{ left:{ ref:'stages.primary.state' }, op:'eq', right:'unclear' }, on_skipped:'primary_resolved' },
      ],
      selectors:[
        { when:{ left:{ ref:'stages.primary.state' }, op:'in', right:['up','down'] },
          select_direction_from:'stages.primary.state', select_timeframe_from:'stages.primary.source.timeframe' },
        { when:{ all:[
          { left:{ ref:'stages.primary.state' }, op:'eq', right:'unclear' },
          { left:{ ref:'stages.fallback.state' }, op:'in', right:['up','down'] },
        ] }, select_direction_from:'stages.fallback.state', select_timeframe_from:'stages.fallback.source.timeframe' },
      ],
      default_decision:'hold_new_entry',
    },
    constraints:[{
      id:'average_ready', scope:'new_entry', phases:['post_inference','pre_submit'],
      require:{ left:{ ref:'indicators.entry_average.ready' }, op:'eq', right:true },
      on_fail:'hold_new_entry', counts_as_trigger:false,
    }],
    prompt_rules:[], ui:{ groups:[] },
  }
}

describe('generic strategy policy compiler', () => {
  it('compiles an arbitrary timeframe and moving-average policy deterministically', () => {
    const input = policyFixture({ indicatorKind:'sma', period:7 })
    const a = compileStrategyPolicy(input, { marketDataPlan:plan('M30', 'D1') })
    const b = compileStrategyPolicy(structuredClone(input), { marketDataPlan:plan('M30', 'D1') })
    expect(a.policy_hash).toBe(b.policy_hash)
    expect(a.indicators[0]).toMatchObject({ kind:'sma', params:{ period:7 } })
  })

  it('rejects unknown capabilities and paths without executing user code', () => {
    const input = policyFixture()
    input.indicators[0].kind = 'custom-module'
    expect(() => compileStrategyPolicy(input, { marketDataPlan:plan('M30', 'D1') }))
      .toThrowError(StrategyPolicyValidationError)
  })

  it('rejects references outside the explicit field whitelist', () => {
    const input = policyFixture()
    input.constraints[0].require.left.ref = 'market.constructor.prototype'
    expect(() => compileStrategyPolicy(input, { marketDataPlan:plan('M30', 'D1') }))
      .toThrow(/policy_reference_field_forbidden/)
  })

  it('compiles explicit policy JSON independently of the legacy EMA34 switch', () => {
    const disabled = policyFixture()
    const parsed = parseStrategyPolicy({
      market_data_plan_json:JSON.stringify(plan('M30', 'D1')),
      strategy_policy_json:JSON.stringify(disabled),
      use_ema34_filter:0,
    })
    expect(parsed).toMatchObject({ useEma34Filter:false, policyMode:'enforce', strategyPolicy:disabled,
      compiledPolicy:{ mode:'enforce', indicators:[{ id:'entry_average' }] } })
  })

  it.each([
    ['ema', 5], ['ema', 20], ['ema', 34], ['ema', 200], ['sma', 50],
  ])('compiles %s period %i without engine changes', (kind, period) => {
    const input = policyFixture({ indicatorKind:kind, period })
    expect(compileStrategyPolicy(input, { marketDataPlan:plan('M30', 'D1') }).indicators[0])
      .toMatchObject({ kind, params:{ period } })
  })

  it('keeps the legacy EMA34 switch as read-only metadata without creating runtime policy', () => {
    const parsed = parseStrategyPolicy({
      market_data_plan_json:JSON.stringify({ primary_timeframe:'M15', timeframes:[
        { timeframe:'M15', kline_count:100 }, { timeframe:'M5', kline_count:50 },
      ] }),
      use_ema34_filter:1,
    })
    expect(parsed).toMatchObject({ useEma34Filter:true, policyMode:'off', strategyPolicy:null, compiledPolicy:null })
    expect(parsed.marketDataPlan.timeframes.find(item => item.timeframe === 'M5')).toMatchObject({ kline_count:50 })
  })

  it('does not add an M5 model window when the legacy EMA34 switch is enabled', () => {
    const parsed = parseStrategyPolicy({
      market_data_plan_json:JSON.stringify({ primary_timeframe:'M15', timeframes:[{ timeframe:'M15', kline_count:100 }] }),
      use_ema34_filter:1,
    })
    expect(parsed.marketDataPlan.timeframes).toEqual([{ timeframe:'M15', kline_count:100 }])
    expect(parsed).toMatchObject({ useEma34Filter:true, compiledPolicy:null, policyMode:'off' })
  })

  it('does not retain the retired EMA34 runtime symbols', () => {
    const source = readFileSync(new URL('../../server/routes/ai/strategy-policy.js', import.meta.url), 'utf8')
    expect(source).not.toContain('HARDCODED_EMA34_POLICY')
    expect(source).not.toContain('ensureEma34MarketData')
  })

  it('keeps legacy snapshots while migrating active strategies to the dedicated EMA34 switch', () => {
    const db = readFileSync(new URL('../../server/db.js', import.meta.url), 'utf8')
    const migrations = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    const block153 = migrations.slice(
      migrations.indexOf("id: '153_strategy_policy_runtime'"),
      migrations.indexOf("id: '154_hardcoded_ema34_filter'"),
    )
    const block154 = migrations.slice(migrations.indexOf("id: '154_hardcoded_ema34_filter'"))
    expect(db).toContain('strategy_policy_json LONGTEXT DEFAULT NULL')
    expect(db).toContain('use_ema34_filter TINYINT NOT NULL DEFAULT 0')
    expect(block153).toContain('ADD COLUMN strategy_policy_json LONGTEXT DEFAULT NULL')
    expect(block153).toContain('ADD COLUMN strategy_runtime_json LONGTEXT DEFAULT NULL')
    expect(block153).not.toContain('UPDATE auto_prompt_types')
    expect(block154).toContain('ADD COLUMN use_ema34_filter TINYINT NOT NULL DEFAULT 0')
    expect(block154).toContain('UPDATE auto_prompt_types SET use_ema34_filter = 1')
  })

  it('rejects workflow cycles', () => {
    const input = policyFixture()
    input.workflow.stages[0].run_if = { left:{ ref:'stages.fallback.state' }, op:'eq', right:'up' }
    expect(() => compileStrategyPolicy(input, { marketDataPlan:plan('M30', 'D1') }))
      .toThrow(/policy_workflow_cycle/)
  })

  it('rejects forward stage references in the sequential workflow', () => {
    const input = policyFixture()
    input.workflow.stages[0].run_if = { left:{ ref:'stages.fallback.state' }, op:'eq', right:'up' }
    input.workflow.stages[1].run_if = undefined
    expect(() => compileStrategyPolicy(input, { marketDataPlan:plan('M30', 'D1') }))
      .toThrow(/policy_workflow_forward_reference/)
  })
})

describe('generic execution boundary', () => {
  it('does not run strategy indicator constraints as an order-send gate', () => {
    const configSource = readFileSync(new URL('../../server/routes/ai/config.js', import.meta.url), 'utf8')
    const strategySource = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')
    const schedulerSource = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')
    expect(configSource).not.toContain('evaluateSignalStrategyPolicyBeforeSubmission')
    expect(configSource).not.toContain('strategy_policy_pre_submit_blocked')
    expect(configSource).toContain('evaluateCoreRisk')
    expect(configSource).toContain('evaluateStatefulRiskTx')
    for (const source of [strategySource, schedulerSource]) {
      expect(source).not.toContain('evaluateStrategyConstraints')
      expect(source).not.toContain('validateWorkflowTrace')
      expect(source).not.toContain('_strategyPolicyPrompt')
      expect(source).not.toContain('strategy_policy_decision')
      expect(source).toContain('prepareStrategyDataRuntime')
    }
  })
})

describe('generic indicator registry', () => {
  const bars = [1, 2, 3, 4, 5, 6].map((close, index) => ({
    time_utc_msc:1_000 + index * 60_000, open:close, high:close, low:close, close,
  }))

  it('uses only closed bars and keeps warmup independent from the visible model window', () => {
    const definition = compileStrategyPolicy(policyFixture(), { marketDataPlan:plan('M30', 'D1') }).indicators[0]
    const evidence = calculateIndicator(definition, bars, { lastBarClosed:false, marketSource:'fixture' })
    expect(evidence).toMatchObject({ ready:true, value:4, bars_used:5, reason:'ready' })
    expect(evidence.bar.close).toBe(5)
    expect(evidence.analysis).toMatchObject({
      warmup_complete:true,
      evidence_quality:'reliable',
      field_value:5,
      previous_value:3,
      relation:'above',
      slope:1,
      slope_direction:'rising',
      bars_above:3,
    })
    expect(evidence.evidence_hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('marks partial warmup as limited evidence without discarding a valid average', () => {
    const definition = compileStrategyPolicy(policyFixture(), { marketDataPlan:plan('M30', 'D1') }).indicators[0]
    const evidence = calculateIndicator(definition, bars.slice(0, 4), { lastBarClosed:true, marketSource:'fixture' })
    expect(evidence).toMatchObject({
      ready:true,
      bars_used:4,
      analysis:{ warmup_complete:false, evidence_quality:'limited' },
    })
  })

  it('describes a newly confirmed cross without using the live bar', () => {
    const definition = compileStrategyPolicy(policyFixture(), { marketDataPlan:plan('M30', 'D1') }).indicators[0]
    const crossingBars = [1, 1, 1, 1, 4, 20].map((close, index) => ({
      time_utc_msc:1_000 + index * 60_000, open:close, high:close, low:close, close,
    }))
    const evidence = calculateIndicator(definition, crossingBars, { lastBarClosed:false, marketSource:'fixture' })
    expect(evidence).toMatchObject({
      value:2.5,
      bar:{ close:4 },
      analysis:{ relation:'above', latest_cross:'crossed_above', cross_bars_ago:0 },
    })
  })

  it('fails closed when bar closure is unknown', () => {
    const compiled = compileStrategyPolicy(policyFixture(), { marketDataPlan:plan('M30', 'D1') })
    expect(calculatePolicyIndicators(compiled, { M30:{ bars, lastBarClosed:null } }).entry_average)
      .toMatchObject({ ready:false, reason:'indicator_bar_close_state_unknown' })
  })

  it('fails closed instead of silently sorting disordered market evidence', () => {
    const definition = compileStrategyPolicy(policyFixture(), { marketDataPlan:plan('M30', 'D1') }).indicators[0]
    const disordered = [bars[1], bars[0], ...bars.slice(2)]
    expect(calculateIndicator(definition, disordered, { lastBarClosed:true }))
      .toMatchObject({ ready:false, reason:'indicator_bar_time_not_strictly_increasing' })
  })

  it('fails closed when the latest closed indicator bar is stale for the decision time', () => {
    const compiled = compileStrategyPolicy(policyFixture(), { marketDataPlan:plan('M30', 'D1') })
    const definition = { ...compiled.indicators[0], source:{ ...compiled.indicators[0].source, timeframe:'M1' } }
    const stale = calculateIndicator(definition, bars, {
      lastBarClosed:true, marketSource:'fixture', referenceTimeUtcMs:600_000_000,
    })
    expect(stale).toMatchObject({
      ready:false, reason:'indicator_source_stale', bars_used:6,
      analysis:{ reference_time_utc_msc:600_000_000, latest_closed_bar_time_utc_msc:301_060_000,
        source_age_ms:298_940_000, stale_tolerance_ms:120_000 },
    })
    const fresh = calculateIndicator(definition, bars, {
      lastBarClosed:true, marketSource:'fixture', referenceTimeUtcMs:301_120_000,
    })
    expect(fresh).toMatchObject({ ready:true, reason:'ready' })
  })
})

describe('workflow and constraint execution', () => {
  const compiled = compileStrategyPolicy(policyFixture(), { marketDataPlan:plan('M30', 'D1') })

  it('skips fallback when primary is resolved and rejects authority from the inactive stage', () => {
    const trace = validateWorkflowTrace(compiled, { strategy_policy_trace:{ stages:{
      primary:{ state:'up' }, fallback:{ state:'down' },
    } } })
    expect(trace.compliant).toBe(false)
    expect(trace.stages.fallback).toMatchObject({ skipped:true })
    expect(trace.decision).toMatchObject({ final_direction:'up', effective_timeframe:'M30' })
  })

  it('runs fallback only when its configured condition is true', () => {
    const trace = validateWorkflowTrace(compiled, { strategy_policy_trace:{ stages:{
      primary:{ state:'unclear' }, fallback:{ state:'down' },
    } } })
    expect(trace.compliant).toBe(true)
    expect(trace.decision).toMatchObject({ final_direction:'down', effective_timeframe:'D1' })
  })

  it('honors allow as the default decision for an indicator-only policy', () => {
    const configured = policyFixture()
    configured.workflow = { stages:[], selectors:[], default_decision:'allow' }
    const policy = compileStrategyPolicy(configured, { marketDataPlan:plan('M30', 'D1') })
    const trace = validateWorkflowTrace(policy, { signal_type:'buy' })
    const gate = workflowGateEvaluation(trace)
    const applied = applyConstraintAction({ signal_type:'buy', entry_method:'market', recommended_volume:1 }, gate)
    expect(trace.decision).toMatchObject({ final_direction:null, defaulted:true, default_action:'allow' })
    expect(gate).toMatchObject({ passed:true, action:'allow' })
    expect(applied.signal).toMatchObject({ signal_type:'buy', entry_method:'market', recommended_volume:1 })
  })

  it('still fails closed when an indicator-only policy explicitly defaults to hold', () => {
    const configured = policyFixture()
    configured.workflow = { stages:[], selectors:[], default_decision:'hold_new_entry' }
    const policy = compileStrategyPolicy(configured, { marketDataPlan:plan('M30', 'D1') })
    const gate = workflowGateEvaluation(validateWorkflowTrace(policy, { signal_type:'buy' }))
    expect(applyConstraintAction({ signal_type:'buy', recommended_volume:1 }, gate).signal)
      .toMatchObject({ signal_type:'hold', recommended_volume:0 })
  })

  it('renders generic policy instructions only when an explicit compiled policy is supplied', () => {
    const configured = policyFixture()
    configured.workflow = { stages:[], selectors:[], default_decision:'allow' }
    const policy = compileStrategyPolicy(configured, { marketDataPlan:plan('M30', 'D1') })
    const prompt = renderStrategyPolicyPrompt(policy, { indicators:{} })
    expect(prompt.text).toContain('策略显式声明的结构化数据')
    expect(prompt.text).toContain(policy.policy_hash)
    expect(prompt.text).not.toContain('EMA34')
    expect(prompt.text).not.toContain('M5')
    expect(prompt.text).not.toContain('必须 HOLD')
  })

  it('allows later stages to depend on an incrementally selected decision', () => {
    const input = policyFixture()
    input.workflow.stages.push({
      id:'confirmation', kind:'model_confirmation', source:{ timeframe:'M30' }, minimum_evidence_count:1,
      run_if:{ left:{ ref:'decision.final_direction' }, op:'in', right:['up','down'] },
    })
    const policy = compileStrategyPolicy(input, { marketDataPlan:plan('M30', 'D1') })
    const trace = validateWorkflowTrace(policy, { strategy_policy_trace:{ stages:{
      primary:{ state:'up' }, fallback:{ skipped:true }, confirmation:{ passed:true, evidence_count:1, evidence_refs:['fixture'] },
    } } })
    expect(trace.compliant).toBe(true)
    expect(trace.stages.confirmation).toMatchObject({ passed:true, evidence_count:1 })
  })

  it('holds only new-entry fields and preserves independent management output', () => {
    const evaluation = evaluateStrategyConstraints(compiled, {
      indicators:{ entry_average:{ ready:false } }, signal:{ side:'buy' }, stages:{}, decision:{},
    }, 'post_inference')
    const signal = {
      signal_type:'buy_limit', entry_method:'limit', limit_price:12, stop_loss_price:10,
      pending_action:'cancel', position_management_evaluations:[{ action:'hold' }],
    }
    const applied = applyConstraintAction(signal, evaluation)
    expect(applied.signal).toMatchObject({
      signal_type:'hold', entry_method:'observe', limit_price:null,
      pending_action:'cancel', position_management_evaluations:[{ action:'hold' }],
    })
  })

  it('rechecks frozen evidence before submission and only observes in shadow mode', () => {
    const configured = policyFixture()
    configured.constraints.push({
      id:'entry_above_average', scope:'new_entry', phases:['pre_submit'],
      when:{ left:{ ref:'signal.side' }, op:'eq', right:'buy' },
      require:{ left:{ ref:'indicators.entry_average.bar.close' }, op:'gt', right:{ ref:'indicators.entry_average.value' } },
      on_fail:'reject_submission', counts_as_trigger:true,
    })
    const policy = compileStrategyPolicy(configured, { marketDataPlan:plan('M30', 'D1') })
    const runtime = { mode:'enforce', policy_hash:policy.policy_hash, compiled_policy:policy, workflow_state:{} }
    const bars = [5, 4, 3, 2, 1].map((close, index) => ({
      time_utc_msc:1_000 + index * 60_000, open:close, high:close, low:close, close,
    }))
    const blocked = evaluateFrozenStrategyPolicyForSubmission(runtime, {
      M30:{ bars, lastBarClosed:true, marketSource:'fixture' },
    }, { symbol:'XAUUSD', order_type:'buy' })
    expect(blocked).toMatchObject({ allowed:false, action:'reject_submission', would_allow:false })

    const shadow = evaluateFrozenStrategyPolicyForSubmission({ ...runtime, mode:'shadow' }, {
      M30:{ bars, lastBarClosed:true, marketSource:'fixture' },
    }, { symbol:'XAUUSD', order_type:'buy' })
    expect(shadow).toMatchObject({ allowed:true, action:'reject_submission', would_allow:false })
  })

  it('loads the policy frozen with the signal and bypasses direct manual orders', async () => {
    const policy = compileStrategyPolicy(policyFixture(), { marketDataPlan:plan('M30', 'D1') })
    const runtime = { mode:'enforce', policy_hash:policy.policy_hash, compiled_policy:policy, workflow_state:{} }
    let snapshotReads = 0
    const snapshotLoader = async () => { snapshotReads += 1; return { strategy_runtime_json:JSON.stringify(runtime) } }
    const now = Date.now()
    const ratesProvider = async () => ({
      status:'success',
      rates:[1, 2, 3, 4, 5].map((close, index) => ({
        time_utc_msc:now - (5 - index) * 1_800_000, open:close, high:close, low:close, close,
      })),
      market_meta:{ last_bar_closed:true, source:'fixture' },
    })
    const gate = await evaluateSignalStrategyPolicyBeforeSubmission({
      userId:7, signalId:99, request:{ symbol:'XAUUSD', order_type:'buy' }, snapshotLoader, ratesProvider,
    })
    expect(snapshotReads).toBe(1)
    expect(gate).toMatchObject({ mode:'enforce', policy_hash:policy.policy_hash, allowed:true })

    const manual = await evaluateSignalStrategyPolicyBeforeSubmission({
      userId:7, signalId:null, request:{ symbol:'XAUUSD', order_type:'buy' }, snapshotLoader, ratesProvider,
    })
    expect(snapshotReads).toBe(1)
    expect(manual).toMatchObject({ mode:'legacy_implicit', allowed:true })
  })
})
