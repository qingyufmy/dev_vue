import { canonical, requireBackfill as check } from './v4-backfill-contract.mjs'
import { preparePaymentOrderRows } from './v4-payment-order-rows.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const paymentOrderTargetFields = Object.freeze(['id', 'user_id', 'order_number', 'external_order_id', 'product_code', 'product_label',
  'billing_period_code', 'billing_period_label', 'order_amount', 'legacy_amount_confirmed', 'referral_credit_applied', 'currency_code',
  'status', 'status_label', 'payment_method_code', 'created_at_utc', 'paid_at_utc', 'revision', 'origin', 'legacy_order_id',
  'migration_run_id', 'source_sha256', 'imported_at_utc'])
const integerFields = ['id', 'user_id', 'revision', 'legacy_order_id']
const timeFields = ['created_at_utc', 'paid_at_utc', 'imported_at_utc']
const projection = paymentOrderTargetFields.map(field => integerFields.includes(field) ? `CAST(${field} AS CHAR) ${field}`
  : timeFields.includes(field) ? `DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f') ${field}` : field).join(',')

// Caller owns the transaction and migration admission. This primitive neither
// commits nor creates receipts, maps, source evidence, notifications or grants.
export function createPaymentOrderWriter(rows, options) {
  const prepared = preparePaymentOrderRows(rows, options)
  const expected = new Map(prepared.entries.map(entry => [entry.sourceId, canonical(entry)]))
  return { prepared: structuredClone(prepared), async write(connection, entry, { verifyOnly = false } = {}) {
    check(expected.get(entry.sourceId) === canonical(entry), 'payment_order_writer_input_changed')
    const read = async () => {
      const [saved] = await connection.execute(`SELECT ${projection} FROM payment_orders WHERE id=? FOR UPDATE`, [entry.target.id])
      check(saved.length <= 1, 'payment_order_writer_duplicate')
      if (!saved.length) return null
      const value = { ...saved[0] }
      for (const field of timeFields) value[field] = inspectWallClock(value[field]).canonicalWallClock
      return value
    }
    const current = await read()
    if (current) {
      check(canonical(current) === canonical(entry.target), 'payment_order_writer_target_conflict')
      return { applied: false, targetHash: entry.targetHash }
    }
    check(!verifyOnly, 'payment_order_writer_not_committed')
    await connection.execute(`INSERT INTO payment_orders (${paymentOrderTargetFields.join(',')}) VALUES (${paymentOrderTargetFields.map(() => '?').join(',')})`, paymentOrderTargetFields.map(field => entry.target[field]))
    check(canonical(await read()) === canonical(entry.target), 'payment_order_writer_readback_mismatch')
    return { applied: true, targetHash: entry.targetHash }
  } }
}
