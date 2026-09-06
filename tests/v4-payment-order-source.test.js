import { expect, it } from 'vitest'
import { inspectPaymentOrderSources, paymentOrderFields } from '../scripts/lib/v4-payment-order-source.mjs'
const source = () => ({ ...Object.fromEntries(Object.entries(paymentOrderFields).map(([key, [, nullable]]) => [key, nullable ? null : '0'])),
  id: '1', user_id: '1', order_no: 'old-no', order_id: 'old-id', plan: 'plus', amount: '5', amount_confirmed: '0', referral_credit_applied: '5',
  status: 'paid', currency: 'USD', paid_at: '2026-09-06 12:00:00' })
it('preserves all 23 fields, zero confirmed amount and unresolved wall clocks', () => {
  const row = source(), result = inspectPaymentOrderSources([row], new Set(['1']))
  expect(result.sourceFields).toBe(23)
  expect(result.entries[0].source).toEqual(row)
  expect(result.entries[0].money.amountConfirmedRaw).toBe('0.00000000')
  expect(result.entries[0].times.paid_at.utc).toBeNull()
  expect(result.blockers).toContainEqual({ sourceId: '1', code: 'historical_time_basis_required' })
  expect(result.entries[0].balanceDeltaOnImport).toBe('0.00000000')
})
it('rejects unrepresented fields and missing parents', () => {
  expect(() => inspectPaymentOrderSources([{ ...source(), extra: 'lost' }], new Set(['1']))).toThrow()
  expect(() => inspectPaymentOrderSources([source()], new Set())).toThrow('payment_source_user_missing')
})
it('keeps nullable chain evidence and original cycle names intact', () => {
  const result = inspectPaymentOrderSources([{ ...source(), period: 'monthly', crypto_amount: null, crypto_confirmations: null }], new Set(['1']))
  expect(result.entries[0].exactValues.period).toBe('monthly')
  expect(result.entries[0].money.cryptoExpectedAmount).toBeNull()
})
it('blocks unknown states and negative amounts without repairing the source', () => {
  const row = { ...source(), status: 'legacy-special', amount: '-1' }
  const result = inspectPaymentOrderSources([row], new Set(['1']))
  expect(result.entries[0].source).toEqual(row)
  expect(result.blockers.map(b => b.code)).toContain('negative_amount')
  expect(result.blockers.map(b => b.code)).toContain('unknown_status')
})
