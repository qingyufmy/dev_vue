import { canonical, requireBackfill as check } from './v4-backfill-contract.mjs'
import { preparePaymentMatchRows } from './v4-payment-match-rows.mjs'
import { createPaymentOrderWriter } from './mysql-payment-order-writer.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const paymentMatchTargetFields = Object.freeze(['id', 'payment_order_id', 'user_id', 'chain', 'asset_contract', 'recipient_address',
  'expected_amount', 'required_confirmations', 'payment_transaction_id', 'status', 'window_start_at_utc', 'expires_at_utc', 'created_at_utc',
  'revision', 'origin', 'legacy_watch_id', 'legacy_confirmations', 'legacy_wallet_index', 'migration_run_id', 'source_sha256', 'imported_at_utc'])
const integers = ['id', 'payment_order_id', 'user_id', 'required_confirmations', 'payment_transaction_id', 'revision', 'legacy_watch_id', 'legacy_confirmations', 'legacy_wallet_index']
const times = ['window_start_at_utc', 'expires_at_utc', 'created_at_utc', 'imported_at_utc']
const projection = paymentMatchTargetFields.map(field => integers.includes(field) ? `CAST(${field} AS CHAR) ${field}`
  : times.includes(field) ? `DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f') ${field}` : field).join(',')

// Caller owns admission and the transaction. Lock order is parent order then match.
export function createPaymentMatchWriter(watches, orders, options) {
  const prepared = preparePaymentMatchRows(watches, orders, options), parents = createPaymentOrderWriter(orders, options.orderOptions)
  const parentBySource = new Map(parents.prepared.entries.map(entry => [entry.sourceId, entry]))
  const expected = new Map(prepared.entries.map(entry => [entry.sourceId, canonical(entry)]))
  return { prepared: structuredClone(prepared), async write(connection, entry, { verifyOnly = false } = {}) {
    check(expected.get(entry.sourceId) === canonical(entry), 'payment_match_writer_input_changed')
    await parents.write(connection, parentBySource.get(entry.provenance.orderSource.id), { verifyOnly: true })
    const read = async () => {
      const [rows] = await connection.execute(`SELECT ${projection} FROM payment_matches WHERE id=? FOR UPDATE`, [entry.target.id])
      check(rows.length <= 1, 'payment_match_writer_duplicate')
      if (!rows.length) return null
      const value = { ...rows[0] }
      for (const field of times) value[field] = inspectWallClock(value[field]).canonicalWallClock
      return value
    }
    const current = await read()
    if (current) {
      check(canonical(current) === canonical(entry.target), 'payment_match_writer_target_conflict')
      return { applied: false, targetHash: entry.targetHash }
    }
    check(!verifyOnly, 'payment_match_writer_not_committed')
    await connection.execute(`INSERT INTO payment_matches (${paymentMatchTargetFields.join(',')}) VALUES (${paymentMatchTargetFields.map(() => '?').join(',')})`, paymentMatchTargetFields.map(field => entry.target[field]))
    check(canonical(await read()) === canonical(entry.target), 'payment_match_writer_readback_mismatch')
    return { applied: true, targetHash: entry.targetHash }
  } }
}
