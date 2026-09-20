import test from 'node:test'
import assert from 'node:assert/strict'
import { bindStrategyRoleCandidateConfig as bind } from './strategy-role-candidate-config.mjs'
import { convertStrategyRoleConfig } from './v4-strategy-role-config-conversion.mjs'

const base = () => convertStrategyRoleConfig({ market_data_plan_json: JSON.stringify({ primary_timeframe: 'M5', timeframes: [{ timeframe: 'M5', kline_count: 300 }] }),
  entry_methods_json: '["market"]', strategy_policy_json: null, use_chan_analysis: '0', use_ema34_filter: '0', include_portfolio_context: '0', scope: 'private' })
const additions = () => ({ analysis: { price_action_evidence: { version: 1, enabled: true } },
  trader: { entry_event_policy: { version: 1, mode: 'required', timeframe: 'M5' }, risk_budget: { version: 1, max_risk_per_trade_percent: '1' } } })

test('binds reviewed controls without altering source, old conversion or admission', () => {
  const original = base(), before = structuredClone(original), extra = additions(), copy = structuredClone(extra)
  assert.deepEqual(bind(original), original)
  const result = bind(original, extra)
  assert.deepEqual(original, before); assert.deepEqual(extra, copy)
  assert.equal(result.traderConfig.risk_budget.max_risk_per_trade_percent, '1')
  assert.equal(result.executable, false)
  assert.deepEqual(result.problems, original.problems)
  assert.deepEqual(result.retainedSource, original.retainedSource)
  assert.notEqual(result.reviewedAdditions.baseConfigHash, result.reviewedAdditions.resultConfigHash)
  assert.deepEqual(bind(result, extra).traderConfig, result.traderConfig)
})
test('rejects relaxing an existing declaration and unrelated configuration overrides', () => {
  const configured = bind(base(), additions())
  const changed = additions(); changed.trader.risk_budget.max_risk_per_trade_percent = '2'
  assert.throws(() => bind(configured, changed), { code: 'role_config_override_forbidden' })
  for (const invalid of [null, [], { other: {} }, { trader: { entry_methods: ['limit'] } }, { analysis: { risk_budget: {} } }]) {
    assert.throws(() => bind(base(), invalid), { code: 'role_config_additions_invalid' })
  }
})
test('uses runtime compiler and rejects missing objective event source or timeframe', () => {
  for (const value of ['0', '101', 1, '-1', 'not-a-number']) {
    const extra = additions(); extra.trader.risk_budget.max_risk_per_trade_percent = value
    assert.throws(() => bind(base(), extra), { code: 'role_config_compile_failed' })
  }
  const noSource = additions(); delete noSource.analysis
  assert.throws(() => bind(base(), noSource), { code: 'role_config_event_source_missing' })
  const noFrame = additions(); noFrame.trader.entry_event_policy.timeframe = 'H4'
  assert.throws(() => bind(base(), noFrame), { code: 'role_config_event_timeframe_missing' })
  assert.throws(() => bind({ ...base(), analysisConfig: null }, additions()), { code: 'role_config_base_missing' })
})
