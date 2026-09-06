import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { inspectPaymentWatches } from './v4-payment-watch-source.mjs'
import { preparePaymentOrderRows } from './v4-payment-order-rows.mjs'

const evidence = (id, sha, catalog) => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)
  && typeof sha === 'string' && /^[a-f0-9]{64}$/.test(sha) && catalog.get(id) === sha
const ascii = (value, length) => typeof value === 'string' && value.length <= length && /^[\x21-\x7e]+$/.test(value)

// Prepares unclaimed legacy matching requests. A claimed transaction requires
// independent chain evidence and must never be fabricated from expected_amount.
export function preparePaymentMatchRows(watches, orders, { orderOptions, run, idMap, basis, evidenceCatalog, sessionOffset }) {
  const orderRows = preparePaymentOrderRows(orders, orderOptions)
  exactKeys(run, ['id', 'sourceSnapshotId', 'registeredAtUtc'])
  check(typeof run.id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(run.id)
    && run.sourceSnapshotId === orderOptions.run.sourceSnapshotId && typeof run.registeredAtUtc === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.registeredAtUtc), 'payment_match_run_invalid')
  const imported = inspectWallClock(run.registeredAtUtc.replace('T', ' ').slice(0, -1)).canonicalWallClock
  const inspected = inspectPaymentWatches(watches, orders, { sessionOffset })
  check(inspected.orderBlockers.length === 0, 'payment_match_missing_active_watch')
  check(watches.every(row => row.tx_hash === null), 'payment_match_chain_evidence_required')
  check(inspected.blockers.every(blocker => blocker.code === 'expiry_time_basis_required'), 'payment_match_source_blocked')
  exactKeys(basis, ['version', 'sourceHash', 'sourceSnapshotId', 'records'])
  check(basis.version === 'payment-match-basis/v1' && basis.sourceHash === inspected.sourceHash && basis.sourceSnapshotId === run.sourceSnapshotId
    && Array.isArray(basis.records) && basis.records.length === watches.length && evidenceCatalog instanceof Map, 'payment_match_basis_scope')
  const records = new Map()
  for (const record of basis.records) {
    exactKeys(record, ['sourceId', 'sourceHash', 'chain', 'address', 'assetContract', 'assetCode', 'assetEvidenceId', 'assetEvidenceSha256',
      'expiresAtRaw', 'offsetMinutes', 'timeEvidenceId', 'timeEvidenceSha256'])
    check(!records.has(record.sourceId), 'payment_match_basis_duplicate'); records.set(record.sourceId, record)
  }
  check(idMap instanceof Map && idMap.size === watches.length, 'payment_match_id_map_invalid')
  const orderBySource = new Map(orderRows.entries.map(entry => [entry.sourceId, entry])), ids = new Set()
  const entries = inspected.entries.map(entry => {
    const source = entry.source, record = records.get(entry.sourceId), order = orderBySource.get(entry.orderSourceId), id = idMap.get(entry.sourceId)
    check(record && record.sourceHash === entry.sourceHash && record.chain === source.chain && record.address === source.address
      && record.expiresAtRaw === source.expires_at, 'payment_match_basis_binding')
    check(evidence(record.assetEvidenceId, record.assetEvidenceSha256, evidenceCatalog)
      && evidence(record.timeEvidenceId, record.timeEvidenceSha256, evidenceCatalog), 'payment_match_basis_evidence')
    check(ascii(source.chain, 10) && ascii(source.address, 100) && ascii(record.assetContract, 100) && ascii(record.assetCode, 20), 'payment_match_identifier_unrepresentable')
    check(Number.isInteger(record.offsetMinutes) && Math.abs(record.offsetMinutes) <= 840, 'payment_match_time_offset_invalid')
    const wall = inspectWallClock(source.expires_at).canonicalWallClock
    const utc = new Date(Date.parse(wall.replace(' ', 'T') + 'Z') - record.offsetMinutes * 60000).toISOString()
    check(/^\d{4}-/.test(utc) && utc.slice(0, 4) >= '1000' && utc.slice(0, 4) <= '9999', 'payment_match_time_range')
    const expires = utc.replace('T', ' ').replace('Z', '')
    check(order && expires > order.target.created_at_utc, 'payment_match_window_invalid')
    represent(id, 'bigint unsigned', false)
    check(BigInt(id) > 0n && !ids.has(id), 'payment_match_target_id_invalid'); ids.add(id)
    const target = { id, payment_order_id: order.target.id, user_id: source.user_id, chain: source.chain, asset_contract: record.assetContract,
      recipient_address: source.address, expected_amount: entry.expectedAmount, required_confirmations: source.required_confirmations,
      payment_transaction_id: null, status: source.status, window_start_at_utc: order.target.created_at_utc, expires_at_utc: expires,
      created_at_utc: entry.createdAtUtc, revision: '1', origin: 'legacy_import', legacy_watch_id: source.id,
      legacy_confirmations: source.confirmations, legacy_wallet_index: source.wallet_index, migration_run_id: run.id,
      source_sha256: entry.sourceHash, imported_at_utc: imported }
    return { sourceId: entry.sourceId, sourceHash: entry.sourceHash, target, targetHash: hash(target),
      provenance: { source, orderSource: order.provenance.source, orderTargetHash: order.targetHash, basisHash: hash(basis), basisRecord: { ...record } } }
  })
  return { version: 'payment-match-rows/v1', sourceHash: inspected.sourceHash, entries, transformHash: hash(entries), transactions: [],
    unresolvedDependencies: ['order_crypto_snapshot_reconciliation', 'currency_basis', 'payment_state_machine_and_cutover'],
    activatesWatches: false, businessWritesEnabled: false, fullPaymentConverted: false }
}
