import { expect, it } from 'vitest'
import { reviewSubscriptionAccountScopes as review } from '../scripts/lib/v4-subscription-account-review.mjs'
function input() {
  return { strategies: [{ id: '1', symbols_json: '["XAUUSD"]' }],
    accounts: [{ id: '10', userId: '7' }, { id: '20', userId: '8' }],
    accountPlan: { mappingHash: 'a'.repeat(64), entities: [{ targetAccountId: '10' }], settings: [{ sourceAccountId: '10', userId: '7', targetAccountId: '10' }, { sourceAccountId: '20', userId: '8', targetAccountId: '10' }] },
    subscriptions: [{ id: '1', user_id: '7', trading_account_id: '10', strategy_id: '1', symbols_json: null, execution_enabled: '1', is_deleted: '0' }, { id: '2', user_id: '8', trading_account_id: '20', strategy_id: '1', symbols_json: null, execution_enabled: '1', is_deleted: '0' }],
  }
}
it('detects execution collisions across old account IDs and different users after entity merge', () => {
  const result = review(input())
  expect(result.issues.map(row => row.code)).toContain('subscription_execution_slot_collision')
  expect(result.candidates[0].identityKey).not.toBe(result.candidates[1].identityKey)
  expect(result.executable).toBe(false)
})
it('keeps disabled subscriptions and never grants permission from structural success', () => {
  const data = input(); data.subscriptions[1].execution_enabled = '0'
  const result = review(data)
  expect(result.issues).toEqual([])
  expect(result.candidates).toHaveLength(2)
  expect(result.candidates.every(row => !row.runtimePermissionGranted)).toBe(true)
})
it('checks identity uniqueness even for ended or deleted history', () => {
  const data = input(); data.subscriptions[1] = { ...data.subscriptions[0], id: '2', is_deleted: '1' }
  expect(review(data).issues.map(row => row.code)).toContain('subscription_identity_collision')
})
it('rejects account/user mismatches without borrowing another user settings', () => {
  const data = input(); data.subscriptions[1].user_id = '7'
  expect(review(data).issues.map(row => row.code)).toContain('subscription_scope_user_mismatch')
})
it('does not replace explicit empty symbols or missing parents with a default', () => {
  const data = input(); data.subscriptions[0].symbols_json = '[]'; data.subscriptions[1].strategy_id = '99'
  expect(review(data)).toMatchObject({ candidates: [], structuralCandidatesConsistent: false })
})
