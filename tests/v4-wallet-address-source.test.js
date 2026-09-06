import { describe, expect, it } from 'vitest'
import { inspectWalletAddressSources } from '../scripts/lib/v4-wallet-address-source.mjs'
const row = (extra = {}) => ({ id: '1', chain: 'ETH', address_index: '0', address: 'public-address-fixture', created_at: '2026-01-01 01:00:00', ...extra })
describe('wallet metadata source inventory', () => {
  it('preserves raw creation time and requires independent custody evidence', () => {
    const source = row(), result = inspectWalletAddressSources([source])
    expect(result.entries[0].source).toEqual(source)
    expect(result.blockers.map(x => x.code)).toEqual(['wallet_created_time_basis_required', 'wallet_custody_binding_unverified'])
    expect(result.addressControlVerified).toBe(false)
  })
  it('detects sparse indices without expanding the maximum index into an array', () => {
    const result = inspectWalletAddressSources([row(), row({ id: '2', address_index: '2147483647', address: 'different-address' })])
    expect(result.chains[0]).toMatchObject({ rows: 2, maximumIndex: '2147483647', legacyCountRangeCoversAllIndices: false })
    expect(inspectWalletAddressSources([]).chains).toEqual([])
  })
  it('keeps identical addresses on different chains separate but rejects duplicate chain identities', () => {
    expect(inspectWalletAddressSources([row(), row({ id: '2', chain: 'BSC' })]).entries).toHaveLength(2)
    expect(() => inspectWalletAddressSources([row(), row({ id: '2' })])).toThrow('duplicate_identity')
  })
  it('rejects extra fields and flags unsupported chains or malformed index/address values', () => {
    expect(() => inspectWalletAddressSources([{ ...row(), private_key: 'synthetic' }])).toThrow()
    const result = inspectWalletAddressSources([row({ chain: 'unknown', address_index: '-1', address: ' ' })])
    expect(result.blockers.map(x => x.code)).toEqual(expect.arrayContaining(['wallet_chain_mapping_required', 'wallet_derivation_index_invalid', 'wallet_address_representation_invalid']))
  })
})
