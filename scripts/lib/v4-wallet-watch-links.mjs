import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWalletAddressSources } from './v4-wallet-address-source.mjs'

export function inspectWalletWatchLinks(wallets, watches) {
  const walletReview = inspectWalletAddressSources(wallets)
  check(Array.isArray(watches), 'wallet_watch_rows_invalid')
  const seen = new Set(), entries = []
  for (const source of watches) {
    exactKeys(source, ['id', 'chain', 'address', 'wallet_index'])
    represent(source.id, 'int', false); represent(source.chain, 'varchar(10)', false)
    represent(source.address, 'varchar(100)', false); represent(source.wallet_index, 'int', true)
    check(BigInt(source.id) > 0n && !seen.has(source.id), 'wallet_watch_id_invalid'); seen.add(source.id)
    const candidates = walletReview.entries.filter(row => row.source.chain === source.chain && row.source.address === source.address)
    const candidate = candidates.length === 1 ? candidates[0] : null
    let status = candidates.length > 1 ? 'ambiguous_address' : candidate ? 'exact_address' : 'address_not_registered'
    if (candidate && source.wallet_index !== null && source.wallet_index !== candidate.source.address_index) status = 'index_address_conflict'
    if (source.wallet_index !== null && BigInt(source.wallet_index) < 0n) status = 'invalid_index'
    entries.push({ watchSourceId: source.id, watchSourceHash: hash(source), status,
      walletSourceId: status === 'exact_address' ? candidate.sourceId : null,
      walletSourceHash: status === 'exact_address' ? candidate.sourceHash : null,
      indexEvidence: source.wallet_index === null ? 'not_recorded' : 'recorded',
      sourceIndex: source.wallet_index, custodyVerified: false })
  }
  entries.sort((a, b) => BigInt(a.watchSourceId) < BigInt(b.watchSourceId) ? -1 : 1)
  const linked = new Set(entries.filter(row => row.status === 'exact_address').map(row => row.walletSourceId))
  return { version: 'wallet-watch-links/v1', projection: 'id,chain,address,wallet_index', walletSourceHash: walletReview.sourceHash,
    watchProjectionHash: hash([...watches].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)), entries,
    unreferencedWalletIds: walletReview.entries.filter(row => !linked.has(row.sourceId)).map(row => row.sourceId),
    fullWatchReviewed: false, addressControlVerified: false, databaseWritten: false }
}
