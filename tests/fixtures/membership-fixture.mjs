import { hash } from '../../scripts/lib/v4-backfill-contract.mjs'
export function membershipFixture(rawExpiry = '2026-01-01 13:14:15') {
  const user = { id: '2', role: 'admin', plan: 'pro', plan_period: '', plan_source: null, plan_expires_at: rawExpiry, updated_at: '2025-01-01 00:00:00' }
  const options = { run: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceSnapshotId: 'fixture', registeredAtUtc: '2026-09-07T00:00:00.000Z' },
    evidenceCatalog: new Map([['synthetic-only', 'b'.repeat(64)]]), basis: { version: 'membership-current-state/v1', sourceHash: hash([user]), sourceSnapshotId: 'fixture',
      resolutions: [{ sourceId: user.id, sourceHash: hash(user), rawExpiry, expirationKind: rawExpiry === null ? 'no_expiry' : 'at_time',
        offsetMinutes: rawExpiry === null ? null : 480, evidenceId: 'synthetic-only', evidenceSha256: 'b'.repeat(64) }] } }
  return { user, options }
}
