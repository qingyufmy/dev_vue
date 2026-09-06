import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const walletAddressSourceFields = Object.freeze({ id: ['int', false], chain: ['varchar(10)', false],
  address_index: ['int', false], address: ['varchar(100)', false], created_at: ['datetime', true] })

export function inspectWalletAddressSources(rows) {
  check(Array.isArray(rows), 'wallet_address_source_invalid')
  const ids = new Set(), indices = new Set(), addresses = new Set(), entries = [], blockers = []
  for (const source of rows) {
    exactKeys(source, Object.keys(walletAddressSourceFields))
    for (const [field, [type, nullable]] of Object.entries(walletAddressSourceFields)) {
      if (type === 'datetime') inspectWallClock(source[field])
      else represent(source[field], type, nullable)
    }
    check(BigInt(source.id) > 0n && !ids.has(source.id), 'wallet_address_id_invalid'); ids.add(source.id)
    const indexKey = JSON.stringify([source.chain, source.address_index]), addressKey = JSON.stringify([source.chain, source.address])
    check(!indices.has(indexKey) && !addresses.has(addressKey), 'wallet_address_duplicate_identity')
    indices.add(indexKey); addresses.add(addressKey)
    const add = code => blockers.push({ sourceId: source.id, code })
    if (!['ETH', 'BSC', 'TRON', 'SOL'].includes(source.chain)) add('wallet_chain_mapping_required')
    if (BigInt(source.address_index) < 0n) add('wallet_derivation_index_invalid')
    if (!source.address || !/^[\x21-\x7e]+$/.test(source.address)) add('wallet_address_representation_invalid')
    if (source.created_at !== null) add('wallet_created_time_basis_required')
    add('wallet_custody_binding_unverified')
    entries.push({ sourceId: source.id, sourceHash: hash(source), source: { ...source } })
  }
  entries.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : 1)
  const chains = [...new Set(rows.map(row => row.chain))].sort().map(chain => {
    const values = rows.filter(row => row.chain === chain).map(row => BigInt(row.address_index)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    return { chain, rows: values.length, minimumIndex: values[0].toString(), maximumIndex: values.at(-1).toString(),
      legacyCountRangeCoversAllIndices: values.every((value, index) => value === BigInt(index)) }
  })
  return { version: 'wallet-address-source/v1', sourceFields: 5, sourceHash: hash(entries.map(entry => entry.source)), entries, chains, blockers,
    privateKeysRead: false, addressControlVerified: false, blockchainQueried: false, businessWritesEnabled: false }
}
