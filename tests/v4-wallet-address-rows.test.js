import { describe, expect, it } from 'vitest'
import { walletFixture as fixture } from './fixtures/wallet-fixture.mjs'
import { prepareWalletAddressRows } from '../scripts/lib/v4-wallet-address-rows.mjs'
describe('wallet metadata conversion with reviewed source time', () => {
  it('converts reviewed time across a date boundary and retains all source fields', () => {
    const { row, options } = fixture(), result = prepareWalletAddressRows([row], options), entry = result.entries[0]
    expect(entry.target.created_at_utc).toBe('2025-12-31 17:00:00.000')
    expect(entry.provenance.source).toEqual(row)
    expect(entry.target).toMatchObject({ custody_reference: null, custody_evidence_sha256: null, custody_verified_at_utc: null, revision: '1', origin: 'legacy_import' })
    expect(Object.keys(entry.target)).toHaveLength(13)
    expect(result.custodyVerified).toBe(false)
  })
  it('preserves source NULL only under its explicit reviewed rule', () => {
    const { row, options } = fixture(null)
    expect(prepareWalletAddressRows([row], options).entries[0].target.created_at_utc).toBeNull()
    options.basis.resolutions[0].offsetMinutes = 0
    expect(() => prepareWalletAddressRows([row], options)).toThrow()
  })
  it('rejects unsupported time assumptions, missing evidence and replacing nonnull source time with NULL', () => {
    for (const change of [{ offsetMinutes: null }, { offsetMinutes: 841 }, { timeKind: 'source_null' }, { evidenceSha256: 'c'.repeat(64) }, { rawCreatedAt: null }]) {
      const { row, options } = fixture(); Object.assign(options.basis.resolutions[0], change)
      expect(() => prepareWalletAddressRows([row], options)).toThrow()
    }
  })
  it('rejects source mutations, mixed snapshots and duplicate resolutions', () => {
    const { row, options } = fixture()
    expect(() => prepareWalletAddressRows([{ ...row, address: 'other' }], options)).toThrow()
    options.run.sourceSnapshotId = 'different'
    expect(() => prepareWalletAddressRows([row], options)).toThrow()
    options.run.sourceSnapshotId = 'synthetic-only'
    options.basis.resolutions.push(options.basis.resolutions[0])
    expect(() => prepareWalletAddressRows([row], options)).toThrow()
  })
})
