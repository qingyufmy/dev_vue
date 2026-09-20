import test from 'node:test'
import assert from 'node:assert/strict'
import { convertRiskPolicy, projectRiskTransition } from './risk-policy-transition.mjs'

const platform = { values: { max_position_size: 0.05, max_daily_open_count: 50, dedup_price_atr: 0.05, dedup_window_seconds: 180 },
  controls: { max_position_size: { allowed_min: 0.001, allowed_max: 1, locked_value: null, user_editable: true } } }
const source = (id, scope, raw, owner = '0', account = null) => ({ id,
  set: { id, scope, owner_user_id: owner, trading_account_id: account, name: 'test', status: 'active', active_version_id: id, created_at: '2026-09-01 00:00:00', updated_at: '2026-09-01 00:00:00' },
  versions: [{ id, policy_set_id: id, version_no: '1', config_json: JSON.stringify(raw), created_by: '1', change_reason: null, effective_at: '2026-09-01 00:00:00', created_at: '2026-09-01 00:00:00' }] })
const mappings = [{ sourcePk: [{ type: 'integer', value: '2' }], target: { table: 'trading_accounts', pk: [{ type: 'integer', value: '2' }] } }]

test('old daily count and per-order controls survive without new manual release permission', () => {
  const converted = convertRiskPolicy(JSON.stringify(platform), 'platform')
  const target = JSON.parse(converted.policyJson)
  assert.equal(target.values.maxDailyOpenCount, 50)
  assert.equal(target.values.manualReleaseEnabled, false)
  assert.equal(target.values.tradeSendEnabled, false)
  assert.equal(target.values.maxOrderVolume, 0.05)
  assert.equal(target.values.maxTotalVolume, 1)
  assert.equal(target.controls.maxOrderVolume.allowedMax, 1)
  assert.equal(target.values.pendingDedupAtrMultiplier, 0.05)
  assert.equal(converted.legacyDedupWindowSeconds, 180)
})

test('unknown and malformed rules are never discarded into an active policy', () => {
  for (const values of [{ surprise: 1 }, { dedup_price_atr: 6 }, { dedup_window_seconds: -1 }, { dedup_window_seconds: '180' }]) {
    assert.throws(() => convertRiskPolicy(JSON.stringify({ ...platform, values: { ...platform.values, ...values } }), 'platform'))
  }
  assert.throws(() => convertRiskPolicy(JSON.stringify(platform), 'account'))
  assert.throws(() => convertRiskPolicy('{"allowed_symbols":["*"]}', 'account'))
})

test('revoked owner policy is historical, never inherited by the current owner', () => {
  const inputs = [source('1', 'platform', platform), source('2', 'account', { max_position_size: 0.5 }, '29', '2')]
  const result = projectRiskTransition(inputs, mappings, [{ user_id: '28', account_id: '2', role: 'owner', revoked_at_utc: null }], new Set(['1', '28', '29']))
  assert.equal(result[1].set.status, 'retired')
  assert.equal(result[1].set.owner_user_id, '29')
  assert.equal(JSON.parse(result[1].versions[0].row.policy_json).maxOrderVolume, 0.5)
  assert.deepEqual(result[1].source, inputs[1])
  assert.throws(() => projectRiskTransition(inputs, [], [], new Set(['1', '29'])))
  inputs[1].set.active_version_id = '1'
  assert.throws(() => projectRiskTransition(inputs, mappings, [], new Set(['1', '29'])))
})

test('account values resolve against editable platform bounds, preserving a larger allowed order', () => {
  const result = projectRiskTransition([source('1', 'platform', platform), source('2', 'account', { max_position_size: 0.5 }, '29', '2')], mappings,
    [{ user_id: '29', account_id: '2', role: 'owner', revoked_at_utc: null }], new Set(['1', '29']))
  assert.equal(result[1].set.status, 'active')
  assert.equal(JSON.parse(result[1].versions[0].row.policy_json).maxOrderVolume, 0.5)
})
