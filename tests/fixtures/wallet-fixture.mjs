import { hash } from '../../scripts/lib/v4-backfill-contract.mjs'
export function walletFixture(created = '2026-01-01 01:00:00') {
  const row = { id: '1', chain: 'TRON', address_index: '0', address: 'synthetic-public-address', created_at: created }
  const options = { run: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceSnapshotId: 'synthetic-only', registeredAtUtc: '2026-09-07T00:00:00.000Z' },
    evidenceCatalog: new Map([['synthetic-time', 'b'.repeat(64)]]), basis: { version: 'wallet-address-time/v1', sourceHash: hash([row]), sourceSnapshotId: 'synthetic-only',
      resolutions: [{ sourceId: row.id, sourceHash: hash(row), rawCreatedAt: created, timeKind: created === null ? 'source_null' : 'wall_clock', offsetMinutes: created === null ? null : 480,
        evidenceId: 'synthetic-time', evidenceSha256: 'b'.repeat(64) }] } }
  return { row, options }
}
