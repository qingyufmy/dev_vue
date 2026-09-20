import test from 'node:test'
import assert from 'node:assert/strict'
import { convertSubscriptionExecutionPreferences } from './v4-subscription-preferences-conversion.mjs'

const source = mode => ({ take_profit_mode: mode, created_at: '2026-09-09 00:00:00', updated_at: '2026-09-09 01:02:03.123000' })
test('maps all four modes through the current V4 selection contract and preserves UTC wall time', () => {
  for (const [mode, tier] of [['ai_recommended', 1], ['conservative', 1], ['standard', 2], ['trend', 3]]) {
    const result = convertSubscriptionExecutionPreferences(source(mode))
    assert.equal(result.status, 'converted')
    assert.deepEqual(result.candidate, { contract_version: 1, take_profit_mode: mode, revision: '1',
      created_at_utc: '2026-09-09 00:00:00.000', updated_at_utc: '2026-09-09 01:02:03.123' })
    assert.equal(result.selection.requestedTier, tier)
    assert.equal(result.selection.price, null)
    assert.equal(result.executable, false)
  }
})
test('preserves recognized legacy defaults and case normalization without accepting unknown modes', () => {
  for (const [value, expected] of [[null, 'ai_recommended'], ['', 'ai_recommended'], [' Standard ', 'standard']]) {
    assert.equal(convertSubscriptionExecutionPreferences(source(value)).candidate.take_profit_mode, expected)
  }
  for (const value of [' ', 'fast', 'tp2']) {
    const result = convertSubscriptionExecutionPreferences(source(value))
    assert.equal(result.status, 'blocked'); assert.equal(result.candidate, null)
  }
})
test('rejects missing, invalid and lossy timestamps without substituting migration time', () => {
  for (const date of [null, '2026-02-30 00:00:00', '2026-09-09T00:00:00Z', '2026-09-09 00:00:00.123001']) {
    const result = convertSubscriptionExecutionPreferences({ ...source('standard'), created_at: date })
    assert.equal(result.status, 'blocked'); assert.equal(result.candidate, null)
    assert.equal(result.problems[0].field, 'created_at')
  }
})
