import { expect, it } from 'vitest'
import { convertReferralAccounts } from '../scripts/lib/v4-referral-conversion.mjs'
import { prepareReferralOpenings } from '../scripts/lib/v4-referral-opening.mjs'

function fixture() {
  const rows = ['80', '0', '-1'].map((credit, i) => ({ id: String(i + 1), referral_code: null, referred_by: null,
    referral_credit: credit, created_at: null, updated_at: null }))
  const registeredAtUtc = '2026-09-07T00:00:00.123Z', converted = convertReferralAccounts(rows, registeredAtUtc)
  return { rows, targets: converted.entries.map(e => e.target), run: { registeredAtUtc,
    bindingManifest: { sourceHash: converted.sourceHash, sourceUsers: rows.length },
    spec: { runId: '11111111-1111-4111-8111-111111111111', bindings: { storageMode: 'inplace-referral-v1' } } } }
}
it('opens positive, zero and negative balances without pretending they are historical credits', () => {
  const f = fixture(), result = prepareReferralOpenings(f.rows, f.targets, f.run)
  expect(result.entries.map(e => e.resulting_balance)).toEqual(['80.00000000', '0.00000000', '-1.00000000'])
  expect(result.entries.every(e => e.delta === null && e.previous_balance === null && e.account_revision === '1')).toBe(true)
  expect(result.balanceUpdatesRequired).toBe(false)
  expect(new Set(result.entries.map(e => e.source_key)).size).toBe(3)
})
it.each(['referral_credit', 'revision', 'updated_at_utc'])('refuses to open after target %s has changed', field => {
  const f = fixture(); f.targets[0][field] = 'changed'
  expect(() => prepareReferralOpenings(f.rows, f.targets, f.run)).toThrow('referral_opening_target_changed')
})
it('requires the frozen source and every target row', () => {
  const f = fixture(); f.rows[0].referral_credit = '100'
  expect(() => prepareReferralOpenings(f.rows, f.targets, f.run)).toThrow('referral_opening_source_changed')
  const other = fixture(); other.targets.pop()
  expect(() => prepareReferralOpenings(other.rows, other.targets, other.run)).toThrow('referral_opening_target_count')
})
