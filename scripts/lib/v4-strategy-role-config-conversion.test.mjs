import test from 'node:test'
import assert from 'node:assert/strict'
import { convertStrategyRoleConfig } from './v4-strategy-role-config-conversion.mjs'

const source = () => ({ market_data_plan_json: JSON.stringify({ primary_timeframe: 'H1', timeframes: [{ timeframe: 'H1', kline_count: 300 }] }),
  entry_methods_json: '["LIMIT","market","limit"]', strategy_policy_json: null,
  use_chan_analysis: '0', use_ema34_filter: '0', include_portfolio_context: '0', scope: 'platform' })

test('maps the verified required platform reference while keeping business admission separate', () => {
  const row = source(), result = convertStrategyRoleConfig(row)
  assert.equal(result.status, 'converted')
  assert.deepEqual(result.problems, [])
  assert.equal(result.portfolioContext.status, 'mapped')
  assert.equal(result.portfolioContext.mode, 'strategy_reference')
  assert.deepEqual(result.traderConfig, { entry_methods: ['limit', 'market'], strategy_reference_portfolio: { version: 1, mode: 'required' } })
  assert.equal(result.analysisConfig.market_data_plan.primary_timeframe, 'H1')
  assert.deepEqual(result.analysisConfig.macro_evidence, { mode: 'off' })
  assert.deepEqual(result.retainedSource, row)
  assert.equal(result.executable, false)
  assert.deepEqual(result.remainingChecks,['role_specific_prompts','target_identity_mapping','restore_backfill_reconciliation'])
})
test('keeps policy bytes and reports unsupported semantics instead of hiding them in trader JSON', () => {
  const row = source(); row.strategy_policy_json = '{"mode":"off", "indicators":[]}'
  row.use_chan_analysis = '1'; row.scope = 'private'; row.include_portfolio_context = '1'
  const result = convertStrategyRoleConfig(row)
  assert.equal(result.status, 'partial')
  assert.equal(result.retainedSource.strategy_policy_json, row.strategy_policy_json)
  assert.deepEqual(result.problems.map(item => item.code).sort(), ['portfolio_context_runtime_mapping_required', 'structured_policy_runtime_mapping_required'])
  assert.deepEqual(result.analysisConfig.chan_evidence, { version: 1, enabled: true })
  assert.deepEqual(Object.keys(result.traderConfig), ['entry_methods'])
})
test('legacy EMA gate without a declaration does not invent an indicator or timeframe', () => {
  const row = source(); row.use_ema34_filter = '1'
  const result = convertStrategyRoleConfig(row)
  assert.equal(result.status, 'converted')
  assert.deepEqual(result.problems, [])
  assert.equal(result.analysisConfig.ema34_evidence, undefined)
  assert.deepEqual(result.analysisConfig.chan_evidence, { version: 1, enabled: false })
  assert.equal(result.retainedSource.use_ema34_filter, '1')
})

test('disabled private portfolio needs no reference input, unlike a platform strategy with the same flag', () => {
  const row = source(); row.scope = 'private'
  const result = convertStrategyRoleConfig(row)
  assert.equal(result.status, 'converted')
  assert.equal(result.portfolioContext.mode, 'off')
  assert.equal(result.portfolioContext.status, 'not_requested')
})
test('invalid source and missing market plan cannot produce a complete config', () => {
  const row = source(); row.market_data_plan_json = null; row.entry_methods_json = '["unknown"]'
  const result = convertStrategyRoleConfig(row)
  assert.equal(result.status, 'partial')
  assert.equal(result.analysisConfig, null)
  assert.equal(result.traderConfig, null)
  assert.ok(result.problems.some(item => item.code === 'legacy_market_plan_fallback_requires_prompt'))
})
test('source hash changes even when distinct legacy bytes normalize to the same target', () => {
  const row = source(), first = convertStrategyRoleConfig(row)
  row.entry_methods_json = '["limit","market"]'
  const second = convertStrategyRoleConfig(row)
  assert.deepEqual(first.traderConfig, second.traderConfig)
  assert.notEqual(first.sourceHash, second.sourceHash)
})

test('Chan on an unsupported history timeframe remains explicitly partial', () => {
  const row = source()
  row.use_chan_analysis = '1'
  row.market_data_plan_json = JSON.stringify({ primary_timeframe: 'M1', timeframes: [{ timeframe: 'M1', kline_count: 300 }] })
  const result = convertStrategyRoleConfig(row)
  assert.equal(result.status, 'partial')
  assert.ok(result.problems.some(item => item.code === 'chan_timeframe_not_supported'))
  assert.equal(result.executable, false)
})

test('a separate M1 evidence frame does not disable supported H1 Chan history', () => {
  const row = source()
  row.use_chan_analysis = '1'
  row.market_data_plan_json = JSON.stringify({ primary_timeframe: 'H1', timeframes: [{ timeframe: 'H1', kline_count: 300 }, { timeframe: 'M1', kline_count: 100 }] })
  const result = convertStrategyRoleConfig(row)
  assert.equal(result.status, 'converted')
  assert.deepEqual(result.analysisConfig.chan_evidence, { version: 1, enabled: true })
  assert.equal(result.analysisConfig.market_data_plan.timeframes[1].timeframe, 'M1')
})
