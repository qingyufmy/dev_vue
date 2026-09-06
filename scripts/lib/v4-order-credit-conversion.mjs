import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'

export const orderCreditFields = Object.freeze(['id', 'user_id', 'order_id', 'status', 'currency', 'amount', 'amount_confirmed', 'referral_credit_applied'])

// This projection preserves credit facts only. It never settles orders or changes balances.
export function inspectOrderCreditConversion(rows, userIds) {
  check(Array.isArray(rows) && rows.length <= 100000 && userIds instanceof Set, 'order_credit_scope_invalid')
  const ids = new Set(), entries = [], blockers = []
  for (const source of rows) {
    exactKeys(source, orderCreditFields)
    represent(source.id, 'int', false); represent(source.user_id, 'int', false)
    check(BigInt(source.id) > 0n && !ids.has(source.id), 'order_credit_identity_invalid'); ids.add(source.id)
    check(BigInt(source.user_id) > 0n && userIds.has(source.user_id), 'order_credit_user_missing')
    represent(source.order_id, 'varchar(100)', true)
    represent(source.status, 'varchar(20)', true)
    represent(source.currency, 'varchar(10)', true)
    const amount = represent(source.amount, 'decimal(20,8)', false)
    const cash = represent(source.amount_confirmed, 'decimal(20,8)', false)
    const credit = represent(source.referral_credit_applied, 'decimal(20,8)', false)
    const creditUnits = BigInt(credit.replace('.', ''))
    check(BigInt(amount.replace('.', '')) >= creditUnits && creditUnits >= 0n && BigInt(cash.replace('.', '')) >= 0n, 'order_credit_amount_invalid')
    const sourceHash = hash(source)
    let disposition = 'no_credit'
    if (creditUnits > 0n) {
      if (source.status === 'paid') disposition = 'historical_consumption'
      else if (source.status === 'pending') disposition = 'pending_release_obligation'
      else if (['cancelled', 'expired'].includes(source.status)) disposition = 'historical_release_unproven'
      else disposition = 'unresolved'
      if (disposition === 'unresolved' || disposition === 'historical_release_unproven') {
        blockers.push({ sourceId: source.id, code: disposition })
      }
      if (disposition === 'pending_release_obligation') {
        // A pending row alone does not establish live settlement/watch state or refund authority.
        blockers.push({ sourceId: source.id, code: 'payment_watch_reconciliation_required' })
        if (!source.order_id) blockers.push({ sourceId: source.id, code: 'external_order_identity_missing' })
      }
    }
    entries.push({ sourceId: source.id, sourceHash, source: { ...source }, credit: {
      userId: source.user_id, legacyOrderId: source.id, externalOrderId: source.order_id,
      currencyRaw: source.currency, amount, amountConfirmed: cash, appliedCredit: credit,
      disposition, migrationBalanceDelta: '0.00000000', releaseAuthorized: false,
    } })
  }
  entries.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : 1)
  blockers.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : BigInt(a.sourceId) > BigInt(b.sourceId) ? 1 : a.code.localeCompare(b.code))
  return { version: 'order-credit-inspection/v1', sourceHash: hash(entries.map(e => e.source)), entries, blockers,
    historicalCurrencyBasisProven: false, fullOrderConverted: false, businessWritesEnabled: false }
}
