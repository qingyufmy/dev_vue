import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { hash } from './v4-backfill-contract.mjs'
import { legacyStrategyFields, legacySubscriptionFields } from './v4-strategy-source-review.mjs'
import { projectStrategySubscriptionTransition } from './strategy-subscription-transition.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
function fixture() {
  const blank = fields => Object.fromEntries(fields.map(field => [field, null]))
  const time = '2026-09-01 10:20:30.123'
  const strategy = { ...blank(legacyStrategyFields), id: '4', version: '12', title: 'Example', description: '', system_prompt: 'Source rule',
    scope: 'platform', owner_user_id: '0', created_by: '7', is_active: '1', visibility_status: 'active',
    created_at: time, updated_at: time, symbols_json: '["XAUUSD","EURUSD"]', interval_minutes: '5',
    use_chan_analysis: '0', use_ema34_filter: '0', include_portfolio_context: '0', entry_methods_json: '["market"]',
    market_data_plan_json: '{"primary_timeframe":"H1","timeframes":[{"timeframe":"H1","kline_count":300}]}' }
  const subscription = { ...blank(legacySubscriptionFields), id: '9', user_id: '7', strategy_id: '4', trading_account_id: '42',
    created_at: time, updated_at: time, schedule_enabled: '0', execution_enabled: '1', is_deleted: '0' }
  const roles = Object.fromEntries(['analysis', 'trader'].map(kind => [kind, { promptText: kind + ' rule', promptHash: sha(kind + ' rule') }]))
  return { strategies: [strategy], subscriptions: [subscription], users: [{ id: '7' }], accountMap: [['42', '82']],
    ownerships: [{ userId: '7', accountId: '82' }], intervals: [],
    maxima: { strategies: '9007199254740993', strategy_versions: '14', strategy_subscriptions: '18' },
    roleCandidates: [{ sourceId: '4', sourceVersion: '12', sourceHash: hash(strategy), sourcePromptHash: sha(strategy.system_prompt),
      originalTextFullyAssigned: true, executable: false, roles }] }
}

test('expands symbols without losing UTC, exact bigint IDs or granting execution', () => {
  const result = projectStrategySubscriptionTransition(fixture())
  const roles = result.strategyEntries[0].roles, projections = result.subscriptionEntries[0].projections
  assert.equal(roles.analysis.strategy.id, '9007199254740994')
  assert.equal(roles.trader.strategy.id, '9007199254740995')
  assert.equal(roles.analysis.version.version_number, '12')
  assert.equal(roles.analysis.strategy.status, 'draft')
  assert.equal(roles.analysis.strategy.active_version_id, null)
  assert.equal(projections.length, 2)
  for (const { subscription, schedule } of projections) {
    assert.equal(subscription.trading_account_id, '82')
    assert.equal(subscription.created_at_utc, '2026-09-01 10:20:30.123')
    assert.equal(subscription.trade_send_enabled, 0)
    assert.equal(subscription.status, 'paused')
    assert.equal(schedule.next_due_at_utc, null)
  }
})

test('historical ownership does not reactivate the old subscriber', () => {
  const input = fixture(); input.ownerships = []; input.intervals = [{ userId: '7', accountId: '82', ended_at_utc: '2026-09-02 00:00:00.000' }]
  assert.ok(projectStrategySubscriptionTransition(input).subscriptionEntries[0].projections.every(row => row.subscription.status === 'ended'))
  input.intervals[0].userId = '8'
  assert.throws(() => projectStrategySubscriptionTransition(input), /transition_ownership_unresolved/)
})

test('refuses changed source, changed role bytes and missing persistent account mapping', () => {
  let input = fixture(); input.strategies[0].system_prompt += 'changed'
  assert.throws(() => projectStrategySubscriptionTransition(input), /transition_role_source_changed/)
  input = fixture(); input.roleCandidates[0].roles.trader.promptText += 'changed'
  assert.throws(() => projectStrategySubscriptionTransition(input), /transition_role_prompt_changed/)
  input = fixture(); input.accountMap = []
  assert.throws(() => projectStrategySubscriptionTransition(input), /transition_account_mapping_missing/)
})
