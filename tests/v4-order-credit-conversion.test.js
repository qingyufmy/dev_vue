import { expect, it } from 'vitest'
import { inspectOrderCreditConversion } from '../scripts/lib/v4-order-credit-conversion.mjs'

const users = new Set(['1'])
const row = (id, status, credit = '5') => ({ id, user_id: '1', order_id: `order-${id}`, status, currency: 'USD', amount: '5', amount_confirmed: '0', referral_credit_applied: credit })
it('records paid consumption without debiting the opening balance', () => {
  const result = inspectOrderCreditConversion([row('1', 'paid')], users)
  expect(result.entries[0].credit).toMatchObject({ disposition: 'historical_consumption', appliedCredit: '5.00000000', migrationBalanceDelta: '0.00000000' })
  expect(result.blockers).toEqual([])
})
it('keeps pending obligations but does not authorize refunds from order status alone', () => {
  const result = inspectOrderCreditConversion([row('1', 'pending')], users)
  expect(result.entries[0].credit).toMatchObject({ disposition: 'pending_release_obligation', releaseAuthorized: false, migrationBalanceDelta: '0.00000000' })
  expect(result.blockers[0].code).toBe('payment_watch_reconciliation_required')
})
it.each(['cancelled', 'expired'])('does not infer that %s actually returned money', status => {
  const result = inspectOrderCreditConversion([row('1', status)], users)
  expect(result.blockers[0].code).toBe('historical_release_unproven')
})
it('preserves raw values and does not force confirmed cash to equal order amount', () => {
  const input = { ...row('1', 'cancelled', '0'), amount: '100', amount_confirmed: '1', currency: null }
  const result = inspectOrderCreditConversion([input], users)
  expect(result.entries[0].source).toEqual(input)
  expect(result.blockers).toEqual([])
  expect(result.fullOrderConverted).toBe(false)
})
it.each(['-1', '5.00000001', '0.000000001', 5])('rejects invalid credit %s', value => {
  expect(() => inspectOrderCreditConversion([row('1', 'paid', value)], users)).toThrow()
})
it('rejects missing parents and duplicate identities', () => {
  expect(() => inspectOrderCreditConversion([row('1', 'paid')], new Set())).toThrow('order_credit_user_missing')
  expect(() => inspectOrderCreditConversion([row('1', 'paid'), row('1', 'paid')], users)).toThrow('order_credit_identity_invalid')
})
it('is deterministic for unordered source rows and blocks unknown credit states', () => {
  const rows = [row('12', 'unknown'), row('2', 'paid')]
  expect(inspectOrderCreditConversion(rows, users)).toEqual(inspectOrderCreditConversion([...rows].reverse(), users))
  expect(inspectOrderCreditConversion(rows, users).blockers[0].code).toBe('unresolved')
})
