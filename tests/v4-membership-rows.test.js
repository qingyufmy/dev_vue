import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { prepareMembershipRows } from '../scripts/lib/v4-membership-rows.mjs'
function fixture(rawExpiry = '2026-01-01 13:14:15') {
  const user = { id: '2', role: 'admin', plan: 'pro', plan_period: '', plan_source: null, plan_expires_at: rawExpiry, updated_at: '2025-01-01 00:00:00' }
  const options = { run: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceSnapshotId: 'fixture', registeredAtUtc: '2026-09-07T00:00:00.000Z' },
    evidenceCatalog: new Map([['synthetic-only', 'b'.repeat(64)]]), basis: { version: 'membership-current-state/v1', sourceHash: hash([user]), sourceSnapshotId: 'fixture',
      resolutions: [{ sourceId: user.id, sourceHash: hash(user), rawExpiry, expirationKind: rawExpiry === null ? 'no_expiry' : 'at_time',
        offsetMinutes: rawExpiry === null ? null : 480, evidenceId: 'synthetic-only', evidenceSha256: 'b'.repeat(64) }] } }
  return { user, options }
}
it('converts proven expiry without replacing an expired plan or inventing a historical update', () => {
  const { user, options } = fixture(), result = prepareMembershipRows([user], options), entry = result.entries[0]
  expect(entry.target).toMatchObject({ plan_code: 'pro', expires_at_utc: '2026-01-01 05:14:15.000',
    current_state_observed_at_utc: '2026-09-07 00:00:00.000', billing_period_code: '', source_code: null })
  expect(entry.provenance.source).toEqual(user)
  expect(entry.target).not.toHaveProperty('role')
  expect(result).toMatchObject({ createsHistoricalActivations: false, grantsEntitlements: false, fullMembershipConverted: false })
})
it('keeps proven NULL expiry without turning it into a purchased lifetime grant', () => {
  const { user, options } = fixture(null)
  expect(prepareMembershipRows([user], options).entries[0].target).toMatchObject({ expiration_kind: 'no_expiry', expires_at_utc: null })
  options.basis.resolutions[0].offsetMinutes = 180
  expect(() => prepareMembershipRows([user], options)).toThrow('membership_null_expiry_rule')
})
it('rejects absent, stale, duplicate or unverified evidence before creating target rows', () => {
  for (const mutate of [
    o => { o.basis.resolutions = [] }, o => { o.basis.sourceHash = 'c'.repeat(64) },
    o => { o.basis.resolutions[0].rawExpiry = '2025-01-01 00:00:00' }, o => { o.evidenceCatalog.clear() },
    o => { o.basis.resolutions[0].offsetMinutes = 841 }, o => { o.basis.sourceSnapshotId = 'other' },
  ]) {
    const { user, options } = fixture(); mutate(options)
    expect(() => prepareMembershipRows([user], options)).toThrow()
  }
})
it('does not infer missing or unknown plans from administrator role', () => {
  const { user, options } = fixture(); user.plan = null
  expect(() => prepareMembershipRows([user], options)).toThrow('membership_source_blocked')
})
