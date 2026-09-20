import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectLegacyRiskPolicy } from './risk-legacy-policy-mapping.mjs'

test('per-order volume maps independently while dedup remains retained', () => {
  const result = inspectLegacyRiskPolicy(JSON.stringify({ max_position_size: 0.05, dedup_window_seconds: 180, dedup_price_atr: 0.05, daily_loss_limit_pct: 3 }))
  assert.deepEqual(result.candidates, { maxDailyLossPercent: 3, maxOrderVolume: 0.05 })
  assert.deepEqual(result.retained, { dedup_window_seconds: 180, dedup_price_atr: 0.05 })
  assert.equal(result.issues.length, 2)
  assert.equal(result.activationReady, false)
})

test('platform boundaries and unknown fields survive intact and block activation', () => {
  const control = { allowed_min: 0.1, allowed_max: 8, locked_value: 2, user_editable: false }
  const result = inspectLegacyRiskPolicy(JSON.stringify({ values: { max_drawdown_pct: 3, new_rule: { nested: 7 } }, controls: { max_drawdown_pct: control } }))
  assert.deepEqual(result.controls.max_drawdown_pct, control)
  assert.deepEqual(result.retained.new_rule, { nested: 7 })
  assert.deepEqual(result.controlCandidates.maxDrawdownPercent, { allowedMin: 0.1, allowedMax: 8, lockedValue: 2, userEditable: false })
  assert.equal(result.issues.some(issue => issue.code === 'platform_control_semantics_unmapped'), false)
})

test('invalid values are not coerced, clamped or silently replaced by defaults', () => {
  for (const value of ['3', null, -1, {}, []]) {
    const result = inspectLegacyRiskPolicy(JSON.stringify({ max_drawdown_pct: value }))
    assert.equal(result.valid, false)
    assert.deepEqual(result.candidates, {})
    assert.deepEqual(result.retained.max_drawdown_pct, value)
  }
  assert.equal(inspectLegacyRiskPolicy('{').valid, false)
  assert.equal(inspectLegacyRiskPolicy('[]').valid, false)
  assert.equal(inspectLegacyRiskPolicy('{"max_daily_open_count":1.5}').valid, false)
})

test('raw evidence hashes preserve formatting and ambiguous envelopes are rejected', () => {
  assert.notEqual(inspectLegacyRiskPolicy('{}').sourceSha256, inspectLegacyRiskPolicy('{ }').sourceSha256)
  assert.equal(inspectLegacyRiskPolicy('{"values":{},"defaults":{}}').valid, false)
  assert.equal(inspectLegacyRiskPolicy('{"values":{},"controls":{},"_controls":{}}').valid, false)
})
