import { describe, expect, it } from 'vitest'
import { inspectWalletWatchLinks } from '../scripts/lib/v4-wallet-watch-links.mjs'
const wallet = { id: '1', chain: 'TRON', address: 'public-fixture', address_index: '0', created_at: null }
const watch = { id: '1', chain: 'TRON', address: 'public-fixture', wallet_index: null }
describe('wallet to payment recipient metadata links', () => {
  it('supports multiple watches referencing one exact address without inventing indices', () => {
    const result = inspectWalletWatchLinks([wallet], [watch, { ...watch, id: '2' }])
    expect(result.entries.map(row => row.walletSourceId)).toEqual(['1', '1'])
    expect(result.entries.every(row => row.indexEvidence === 'not_recorded' && row.sourceIndex === null)).toBe(true)
    expect(result.addressControlVerified).toBe(false)
  })
  it('never links by index alone, by address across chains, or after case folding', () => {
    for (const source of [{ ...watch, address: 'other', wallet_index: '0' }, { ...watch, chain: 'ETH' }, { ...watch, address: 'PUBLIC-FIXTURE' }])
      expect(inspectWalletWatchLinks([wallet], [source]).entries[0]).toMatchObject({ status: 'address_not_registered', walletSourceId: null })
  })
  it('blocks contradictory or negative recorded indices even when the address matches', () => {
    expect(inspectWalletWatchLinks([wallet], [{ ...watch, wallet_index: '1' }]).entries[0]).toMatchObject({ status: 'index_address_conflict', walletSourceId: null })
    expect(inspectWalletWatchLinks([wallet], [{ ...watch, wallet_index: '-1' }]).entries[0].status).toBe('invalid_index')
  })
  it('keeps unreferenced addresses and rejects duplicate watch IDs', () => {
    expect(inspectWalletWatchLinks([wallet], []).unreferencedWalletIds).toEqual(['1'])
    expect(() => inspectWalletWatchLinks([wallet], [watch, watch])).toThrow('id_invalid')
  })
})
