import { exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectPaymentWatches } from './v4-payment-watch-source.mjs'

const fields = Object.freeze({ legacy_watch_id: ['id', 'int'], user_id: ['user_id', 'int'], chain: ['chain', 'varchar(10)'],
  recipient_address: ['address', 'varchar(100)'], expected_amount: ['expected_amount', 'decimal(20,8)'], status: ['status', 'varchar(20)'],
  required_confirmations: ['required_confirmations', 'int'], legacy_confirmations: ['confirmations', 'int'], legacy_wallet_index: ['wallet_index', 'int'] })
export const paymentMatchFactFields = Object.freeze(Object.keys(fields))

export function reconcilePaymentMatchFacts(watches, orders, actual, sessionOffset) {
  const inspected = inspectPaymentWatches(watches, orders, { sessionOffset })
  check(Array.isArray(actual), 'payment_match_audit_targets_invalid')
  const targets = new Map(), differences = []
  for (const row of actual) {
    exactKeys(row, paymentMatchFactFields)
    represent(row.legacy_watch_id, 'int', false)
    check(!targets.has(row.legacy_watch_id), 'payment_match_audit_duplicate_legacy')
    targets.set(row.legacy_watch_id, row)
  }
  for (const entry of inspected.entries) {
    const actual = targets.get(entry.sourceId)
    if (!actual) { differences.push({ sourceId: entry.sourceId, field: 'row', code: 'missing' }); continue }
    for (const [field, [sourceField, type]] of Object.entries(fields)) {
      if (represent(actual[field], type, true) !== represent(entry.source[sourceField], type, true)) differences.push({ sourceId: entry.sourceId, field, code: 'value_mismatch' })
    }
    targets.delete(entry.sourceId)
  }
  for (const id of targets.keys()) differences.push({ sourceId: id, field: 'row', code: 'unexpected' })
  return { sourceRows: watches.length, targetRows: actual.length, sourceFactsMatch: differences.length === 0, differences,
    checkedFields: paymentMatchFactFields, timeAssetAndReferencesVerified: false, fullReconciliationComplete: false }
}
