import { expect, it } from 'vitest'
import { paymentOrderFields } from '../scripts/lib/v4-payment-order-source.mjs'
import { preparePaymentOrderCandidates } from '../scripts/lib/v4-payment-order-conversion.mjs'

const source = (id = '1') => ({ ...Object.fromEntries(Object.entries(paymentOrderFields).map(([key, [, nullable]]) => [key, nullable ? null : '0'])),
  id, user_id: '1', order_no: `no-${id}`, order_id: `external-${id}`, plan: 'plus', period: 'monthly',
  amount: '5', amount_confirmed: '0', referral_credit_applied: '5', currency: 'USD', status: 'paid',
  paid_at: '2026-09-06 12:00:00' })
const prepare = rows => preparePaymentOrderCandidates(rows, new Set(['1']))

it('preserves every source field and separates the historical debit from import effects', () => {
  const row = source(), result = prepare([row]), entry = result.entries[0]
  expect(entry.source).toEqual(row)
  expect(entry.order.legacyAmountConfirmed).toBe('0.00000000')
  expect(entry.order.referralCreditApplied).toBe('5.00000000')
  expect(entry.credit.disposition).toBe('historical_consumption')
  expect(entry.effects).toEqual({ balanceDelta: '0.00000000', createPaymentTransaction: false, grantEntitlement: false, enqueuePaymentWatch: false })
})

it('distinguishes absent time from unresolved time without inventing UTC', () => {
  const entry = prepare([source()]).entries[0]
  expect(entry.order.createdAt).toEqual({ sourceWallClock: null, utc: null, resolution: 'absent', basisEvidence: null })
  expect(entry.order.paidAt).toEqual({ sourceWallClock: '2026-09-06 12:00:00', utc: null, resolution: 'unresolved', basisEvidence: null })
})

it('retains cancellation amount disagreement and does not manufacture chain receipts', () => {
  const entry = prepare([{ ...source(), status: 'cancelled', amount: '300', amount_confirmed: '1', referral_credit_applied: '0',
    crypto_amount: '1.00000001', crypto_tx_hash: 'observed-hash', crypto_confirmations: '12', plan_label: '', period_label: null }]).entries[0]
  expect(entry.order.orderAmount).toBe('300.00000000')
  expect(entry.order.legacyAmountConfirmed).toBe('1.00000000')
  expect(entry.paymentEvidence.expectedAmount).toBe('1.00000001')
  expect(entry.paymentEvidence.transactionHashRaw).toBe('observed-hash')
  expect(entry.effects.createPaymentTransaction).toBe(false)
  expect(entry.labels).toEqual({ product: '', period: null, status: null })
})

it('retains product and currency dependencies even without timestamps or credit', () => {
  const result = prepare([{ ...source(), paid_at: null, referral_credit_applied: '0' }])
  expect(result.entries[0].order.periodRaw).toBe('monthly')
  expect(result.blockers.map(b => b.code)).toEqual(['currency_basis_required', 'entitlement_reconciliation_required', 'payment_watch_reconciliation_required', 'product_mapping_required'])
  expect(result.businessWritesEnabled).toBe(false)
  expect(result.fullOrderConverted).toBe(false)
})

it('makes hashes independent of input row order while binding changes in payment evidence', () => {
  const a = source('2'), b = source('10')
  const first = prepare([a, b]), reversed = prepare([b, a])
  expect(first).toEqual(reversed)
  expect(prepare([{ ...a, crypto_address: 'different' }, b]).candidateHash).not.toBe(first.candidateHash)
})

it('rejects excess credit and preserves the unresolved refund gate', () => {
  expect(() => prepare([{ ...source(), referral_credit_applied: '6' }])).toThrow('order_credit_amount_invalid')
  const result = prepare([{ ...source(), status: 'expired' }])
  expect(result.blockers).toContainEqual({ sourceId: '1', code: 'historical_release_unproven' })
  expect(result.entries[0].credit.releaseAuthorized).toBe(false)
})
