import { canonical, requireBackfill as check } from './v4-backfill-contract.mjs'
import { prepareWalletAddressRows } from './v4-wallet-address-rows.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const walletAddressTargetFields = Object.freeze(['id', 'chain', 'address_index', 'address', 'created_at_utc',
  'custody_reference', 'custody_evidence_sha256', 'custody_verified_at_utc', 'revision', 'origin', 'migration_run_id', 'source_sha256', 'imported_at_utc'])
const integerFields = ['id', 'address_index', 'revision']
const timeFields = ['created_at_utc', 'custody_verified_at_utc', 'imported_at_utc']
const sourceProjection = "CAST(id AS CHAR) id,chain,CAST(address_index AS CHAR) address_index,address,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') created_at"
const sourceValue = row => ({ ...row, created_at: inspectWallClock(row.created_at).canonicalWallClock })
const projection = walletAddressTargetFields.map(field => integerFields.includes(field) ? `CAST(${field} AS CHAR) ${field}`
  : timeFields.includes(field) ? `DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f') ${field}` : field).join(',')

// Caller owns the transaction and migration admission. This primitive neither
// commits nor creates receipts, maps, source evidence, notifications or grants.
export function createWalletAddressWriter(rows, options) {
  const prepared = prepareWalletAddressRows(rows, options)
  const expected = new Map(prepared.entries.map(entry => [entry.sourceId, canonical(entry)]))
  return { prepared: structuredClone(prepared), async write(connection, entry, { verifyOnly = false } = {}) {
    check(expected.get(entry.sourceId) === canonical(entry), 'wallet_writer_input_changed')
    const [parents] = await connection.execute(`SELECT ${sourceProjection} FROM wallet_keys WHERE id=? FOR UPDATE`, [entry.sourceId])
    check(parents.length === 1 && canonical(sourceValue({ ...parents[0] })) === canonical(sourceValue(entry.provenance.source)), 'wallet_writer_source_changed')
    const read = async () => {
      const [saved] = await connection.execute(`SELECT ${projection} FROM payment_wallet_addresses WHERE id=? FOR UPDATE`, [entry.target.id])
      check(saved.length <= 1, 'wallet_writer_duplicate')
      if (!saved.length) return null
      const value = { ...saved[0] }
      for (const field of timeFields) value[field] = inspectWallClock(value[field]).canonicalWallClock
      return value
    }
    const current = await read()
    if (current) {
      check(canonical(current) === canonical(entry.target), 'wallet_writer_target_conflict')
      return { applied: false, targetHash: entry.targetHash }
    }
    check(!verifyOnly, 'wallet_writer_not_committed')
    await connection.execute(`INSERT INTO payment_wallet_addresses (${walletAddressTargetFields.join(',')}) VALUES (${walletAddressTargetFields.map(() => '?').join(',')})`, walletAddressTargetFields.map(field => entry.target[field]))
    check(canonical(await read()) === canonical(entry.target), 'wallet_writer_readback_mismatch')
    return { applied: true, targetHash: entry.targetHash }
  } }
}
