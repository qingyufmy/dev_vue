import { exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectPaymentOrderSources } from './v4-payment-order-source.mjs'

const fields = Object.freeze({ legacy_order_id: 'id', user_id: 'user_id', order_number: 'order_no', external_order_id: 'order_id',
  product_code: 'plan', product_label: 'plan_label', billing_period_code: 'period', billing_period_label: 'period_label',
  order_amount: 'amount', legacy_amount_confirmed: 'amount_confirmed', referral_credit_applied: 'referral_credit_applied',
  currency_code: 'currency', status: 'status', status_label: 'status_label', payment_method_code: 'payment_method' })
export const paymentOrderFactFields = Object.freeze(Object.keys(fields))

// Independent source-fact comparison: does not call the target converter or
// compare with its prepared rows. UTC/provenance and crypto coverage are separate gates.
export function reconcilePaymentOrderFacts(sourceRows, actual, userIds) {
  const inspected = inspectPaymentOrderSources(sourceRows, userIds)
  check(Array.isArray(actual), 'payment_order_audit_targets_invalid')
  const targets = new Map(), differences = []
  for (const row of actual) {
    exactKeys(row, paymentOrderFactFields)
    represent(row.legacy_order_id, 'int', false)
    check(!targets.has(row.legacy_order_id), 'payment_order_audit_duplicate_legacy')
    targets.set(row.legacy_order_id, row)
  }
  for (const entry of inspected.entries) {
    const row = targets.get(entry.sourceId)
    if (!row) { differences.push({ sourceId: entry.sourceId, field: 'row', code: 'missing' }); continue }
    for (const [targetField, sourceField] of Object.entries(fields)) {
      const expected = entry.exactValues[sourceField]
      // MySQL DECIMAL strings must retain exact value; never compare via Number.
      const value = ['order_amount', 'legacy_amount_confirmed', 'referral_credit_applied'].includes(targetField)
        ? represent(row[targetField], 'decimal(20,8)', false) : row[targetField]
      if (value !== expected) differences.push({ sourceId: entry.sourceId, field: targetField, code: 'value_mismatch' })
    }
    targets.delete(entry.sourceId)
  }
  for (const id of targets.keys()) differences.push({ sourceId: id, field: 'row', code: 'unexpected' })
  return { sourceRows: sourceRows.length, targetRows: actual.length, sourceFactsMatch: differences.length === 0, differences,
    checkedFields: paymentOrderFactFields, timeAndProvenanceVerified: false, fullReconciliationComplete: false }
}
