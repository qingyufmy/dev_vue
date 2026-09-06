import { expect, it } from 'vitest'
import { reviewAccountOwnership } from '../scripts/lib/v4-account-ownership-consistency.mjs'
function fixture() {
  return { accounts: [{ id: '1', user_id: '1', is_deleted: '0', observe_status: 'transferred' }, { id: '2', user_id: '2', is_deleted: '0', observe_status: 'active' }],
    bindings: [{ currentAccountId: '2', currentUserId: '2', server: 'Broker', login: '00123' }],
    intervals: [{ id: '1', user_id: '1', trading_account_id: '1', broker_server_key: 'BROKER', login_account: '00123', ended_at: '2020-01-01 00:00:00', end_reason: 'transfer' },
      { id: '2', user_id: '2', trading_account_id: '2', broker_server_key: 'BROKER', login_account: '00123', ended_at: null, end_reason: null }],
    accountMap: new Map(['1', '2'].map(id => [id, { targetAccountId: '1', brokerServerKey: 'BROKER', accountLogin: '00123' }])), userIds: new Set(['1', '2']) }
}
it('preserves historical owners but only agrees with the current binding when its interval matches', () => {
  const input = fixture(), result = reviewAccountOwnership(input)
  expect(result.currentOwnershipConsistent).toBe(true)
  expect(result.counts.historicalUserAccountPairs).toBe(2)
  expect(result.tradingPermissionsVerified).toBe(false)
  input.intervals.reverse(); input.accounts.reverse()
  expect(reviewAccountOwnership(input).evidenceHash).toBe(result.evidenceHash)
})
it('finds missing bindings and missing open intervals in both directions', () => {
  const input = fixture(); input.bindings = []
  expect(reviewAccountOwnership(input).issues.map(issue => issue.code)).toContain('open_interval_without_binding')
  const second = fixture(); second.intervals[1].ended_at = '2020-01-02 00:00:00'
  expect(reviewAccountOwnership(second).issues.map(issue => issue.code)).toContain('binding_without_open_interval')
})
it('detects two owners after merging legacy account IDs', () => {
  const input = fixture(); input.intervals[0].ended_at = null; input.intervals[0].end_reason = null
  expect(reviewAccountOwnership(input).issues.map(issue => issue.code)).toContain('multiple_open_owners')
})
it('does not confuse a legacy same-user account switch with revoked ownership or trading eligibility', () => {
  const input = fixture(); input.accounts[1].observe_status = 'switched'
  const result = reviewAccountOwnership(input)
  expect(result.currentOwnershipConsistent).toBe(true)
  expect(result.notes[0].code).toBe('legacy_single_account_switched')
  expect(result.tradingPermissionsVerified).toBe(false)
})
it('rejects mismatched owners, removed users and hidden current source accounts', () => {
  const input = fixture(); input.intervals[1].user_id = '1'; input.accounts[1].is_deleted = '1'; input.userIds.delete('1')
  const codes = reviewAccountOwnership(input).issues.map(issue => issue.code)
  expect(codes).toEqual(expect.arrayContaining(['open_owner_binding_disagreement', 'historical_user_missing', 'current_binding_deleted_account']))
})
