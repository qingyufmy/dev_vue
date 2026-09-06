import { hash } from './v4-backfill-contract.mjs'
import { inspectPaymentOrderSources } from './v4-payment-order-source.mjs'
import { inspectOrderCreditConversion, orderCreditFields } from './v4-order-credit-conversion.mjs'

// Source-to-target contract only. These candidates are not executable SQL rows.
// Payment facts need watch-list reconciliation before becoming transactions/matches.
export function preparePaymentOrderCandidates(rows, userIds) {
  const inspected = inspectPaymentOrderSources(rows, userIds)
  const credits = inspectOrderCreditConversion(rows.map(row => Object.fromEntries(orderCreditFields.map(key => [key, row[key]]))), userIds)
  const creditById = new Map(credits.entries.map(entry => [entry.sourceId, entry.credit]))
  const blockers = [...inspected.blockers, ...credits.blockers]
  const entries = inspected.entries.map(entry => {
    const v = entry.exactValues
    const times = Object.fromEntries(Object.entries(entry.times).map(([key, time]) => [key, {
      sourceWallClock: time.raw, utc: null,
      resolution: time.raw === null ? 'absent' : 'unresolved', basisEvidence: null,
    }]))
    // These dependencies apply even to rows with no timestamps and no credit.
    for (const code of ['product_mapping_required', 'currency_basis_required', 'payment_watch_reconciliation_required', 'entitlement_reconciliation_required']) {
      if (!blockers.some(b => b.sourceId === entry.sourceId && b.code === code)) blockers.push({ sourceId: entry.sourceId, code })
    }
    return {
      sourceId: entry.sourceId, sourceHash: entry.sourceHash, source: entry.source,
      order: {
        legacyId: v.id, orderNumber: v.order_no, externalOrderId: v.order_id, userId: v.user_id,
        productCodeRaw: v.plan, periodRaw: v.period, currencyRaw: v.currency,
        orderAmount: v.amount, legacyAmountConfirmed: v.amount_confirmed,
        referralCreditApplied: v.referral_credit_applied, statusRaw: v.status,
        paymentMethodRaw: v.payment_method, createdAt: times.created_at, paidAt: times.paid_at,
      },
      labels: { product: v.plan_label, period: v.period_label, status: v.status_label },
      paymentEvidence: {
        chainRaw: v.crypto_chain, addressRaw: v.crypto_address, expectedAmount: v.crypto_amount,
        transactionHashRaw: v.crypto_tx_hash, confirmations: v.crypto_confirmations, expiresAt: times.crypto_expires_at,
      },
      credit: creditById.get(entry.sourceId),
      effects: { balanceDelta: '0.00000000', createPaymentTransaction: false, grantEntitlement: false, enqueuePaymentWatch: false },
    }
  })
  blockers.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : BigInt(a.sourceId) > BigInt(b.sourceId) ? 1 : a.code.localeCompare(b.code))
  return { version: 'payment-order-candidates/v1', sourceHash: inspected.sourceHash, candidateHash: hash(entries),
    entries, blockers, businessWritesEnabled: false, fullOrderConverted: false }
}
