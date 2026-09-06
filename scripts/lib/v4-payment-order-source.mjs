import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const paymentOrderFields = Object.freeze({ id: ['int', false], order_no: ['varchar(100)', false], order_id: ['varchar(100)', true],
  user_id: ['int', false], plan: ['varchar(50)', false], plan_label: ['varchar(50)', true], period: ['varchar(20)', true],
  period_label: ['varchar(50)', true], amount: ['decimal(20,8)', false], amount_confirmed: ['decimal(20,8)', false],
  referral_credit_applied: ['decimal(20,8)', false], currency: ['varchar(10)', true], status: ['varchar(20)', true],
  status_label: ['varchar(50)', true], payment_method: ['varchar(50)', true], paid_at: ['datetime', true], created_at: ['datetime', true],
  crypto_chain: ['varchar(10)', true], crypto_address: ['varchar(100)', true], crypto_amount: ['decimal(20,8)', true],
  crypto_tx_hash: ['varchar(100)', true], crypto_confirmations: ['int', true], crypto_expires_at: ['datetime', true] })

export function inspectPaymentOrderSources(rows, userIds) {
  check(Array.isArray(rows) && rows.length <= 100000 && userIds instanceof Set, 'payment_source_scope_invalid')
  const ids = new Set(), entries = [], blockers = []
  for (const row of rows) {
    exactKeys(row, Object.keys(paymentOrderFields))
    const values = {}, times = {}
    for (const [field, [type, nullable]] of Object.entries(paymentOrderFields)) {
      if (type === 'datetime') { times[field] = inspectWallClock(row[field]); values[field] = row[field] }
      else values[field] = represent(row[field], type, nullable)
    }
    check(BigInt(row.id) > 0n && !ids.has(row.id), 'payment_source_duplicate_id'); ids.add(row.id)
    check(BigInt(row.user_id) > 0n && userIds.has(row.user_id), 'payment_source_user_missing')
    const reasons = []
    for (const field of ['amount', 'amount_confirmed', 'referral_credit_applied', 'crypto_amount']) {
      if (values[field] !== null && BigInt(values[field].replace('.', '')) < 0n) reasons.push(`negative_${field}`)
    }
    if (row.crypto_confirmations !== null && BigInt(row.crypto_confirmations) < 0n) reasons.push('negative_confirmations')
    if (!['pending', 'paid', 'cancelled', 'expired'].includes(row.status)) reasons.push('unknown_status')
    if (Object.values(times).some(time => time.raw !== null)) reasons.push('historical_time_basis_required')
    if (!row.order_id) reasons.push('external_order_id_unresolved')
    if (!row.currency) reasons.push('currency_unresolved')
    for (const code of reasons) blockers.push({ sourceId: row.id, code })
    entries.push({ sourceId: row.id, sourceHash: hash(row), source: { ...row }, exactValues: values, times,
      // These are independent legacy facts. Never substitute amount when confirmed amount is zero.
      money: { orderAmount: values.amount, amountConfirmedRaw: values.amount_confirmed, appliedCredit: values.referral_credit_applied,
        cryptoExpectedAmount: values.crypto_amount, currencyRaw: values.currency },
      balanceDeltaOnImport: '0.00000000', paymentOrEntitlementSideEffects: false })
  }
  entries.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : 1)
  return { version: 'payment-order-source/v1', sourceHash: hash(entries.map(e => e.source)), sourceFields: Object.keys(paymentOrderFields).length,
    entries, blockers, fullOrderConverted: false, businessWritesEnabled: false }
}
