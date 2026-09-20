import test from 'node:test'
import assert from 'node:assert/strict'
import { convertStrategyPolicy } from './v4-strategy-policy-conversion.mjs'
import { marketPlan } from '../../server/dist-v4/modules/inference/application/analysis-context-builder.js'
import { compileStrategy } from '../../server/dist-v4/modules/strategies/application/strategy-service.js'

const source = () => ({ constraints: [], engine_version: 'strategy-policy-engine-v2', features: [],
  indicators: [{ enabled: true, id: 'ema34', kind: 'ema', params: { evidence_window: 5, minimum_bars: 34, period: 34, warmup_target_bars: 60 },
    source: { bar_scope: 'closed_only', field: 'close', timeframe: 'M1' } }], mode: 'shadow', prompt_rules: [], schema_version: 'strategy-policy-v1',
  ui: { groups: [], simple_data_capabilities: { managed_indicator_ids: ['ema34'], version: 'strategy-data-capabilities-v1' } },
  workflow: { default_decision: 'allow', selectors: [], stages: [] } })

test('managed EMA declaration reaches the actual V4 analysis market plan', () => {
  const result = convertStrategyPolicy(JSON.stringify(source()), '1')
  assert.equal(result.status, 'converted')
  const compiled = compileStrategy('analysis', 'test', result.analysisConfig)
  assert.equal(compiled.valid, true)
  assert.deepEqual(marketPlan(compiled.normalizedConfig).ema34, { version: 1, timeframe: 'M1' })
  const other = source(); other.indicators[0].source.timeframe = 'H4'
  assert.equal(convertStrategyPolicy(JSON.stringify(other), '1').analysisConfig.ema34_evidence.timeframe, 'H4')
})
test('all legacy provider gates remain effective', () => {
  assert.deepEqual(convertStrategyPolicy(JSON.stringify(source()), '0').analysisConfig, {})
  for (const mutate of [p => { p.mode = 'off' }, p => { p.indicators[0].enabled = false }]) {
    const policy = source(); mutate(policy)
    const result = convertStrategyPolicy(JSON.stringify(policy), '1')
    assert.equal(result.status, 'converted')
    assert.deepEqual(result.analysisConfig, {})
  }
})
test('additional rules and changed indicator semantics cannot silently disappear', () => {
  for (const mutate of [p => { p.constraints.push({ id: 'risk' }) }, p => { p.features.push({ id: 'feature' }) },
    p => { p.prompt_rules.push('rule') }, p => { p.workflow.stages.push({ id: 'entry' }) },
    p => { p.workflow.default_decision = 'deny' }, p => { p.mode = 'enforce' },
    p => { p.indicators[0].params.period = 55 }, p => { p.indicators.push(p.indicators[0]) },
    p => { p.indicators[0].source.bar_scope = 'all' }, p => { p.unknown = true }]) {
    const policy = source(); mutate(policy)
    const result = convertStrategyPolicy(JSON.stringify(policy), '1')
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.analysisConfig, {})
  }
})
test('malformed persisted JSON and unsupported timeframe remain unresolved even when disabled', () => {
  assert.equal(convertStrategyPolicy('{', '0').status, 'partial')
  const policy = source(); policy.indicators[0].source.timeframe = 'W1'
  assert.equal(convertStrategyPolicy(JSON.stringify(policy), '0').status, 'partial')
  assert.deepEqual(convertStrategyPolicy(null, '1').analysisConfig, {})
})
