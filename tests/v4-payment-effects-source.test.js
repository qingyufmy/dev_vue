import { expect, it } from 'vitest'
import { inspectPaymentEffects } from '../scripts/lib/v4-payment-effects-source.mjs'
const order = { id: '1', order_id: 'external', user_id: '2', status: 'paid' }
const effect = () => ({ id: '9007199254740993', order_id: 'external', user_id: '2', status: 'completed', attempt_count: '1',
  next_attempt_at: '2026-09-01 12:00:00', locked_at: null, completed_at: '2026-09-01 12:00:01', last_error: null,
  created_at: '2026-09-01 12:00:00', updated_at: '2026-09-01 12:00:01' })
it('preserves bigint identity and completed delivery without manufacturing activation or replay', () => {
  const row = effect(), result = inspectPaymentEffects([row], [order]), entry = result.entries[0]
  expect(entry.source).toEqual(row)
  expect(entry.disposition).toBe('completed_post_payment_delivery')
  for (const key of ['membershipActivationProven', 'enqueueOutbox', 'grantEntitlement', 'replayCommission', 'resendNotification']) expect(entry[key]).toBe(false)
  expect(entry.times.completed_at.utc).toBeNull()
})
it('requires delivery recovery for pending work and checks order owner and payment', () => {
  const result = inspectPaymentEffects([{ ...effect(), status: 'retry' }], [{ ...order, user_id: '3', status: 'cancelled' }])
  expect(result.blockers.map(b => b.code)).toEqual(expect.arrayContaining(['unfinished_delivery_reconciliation_required', 'order_user_mismatch', 'order_not_paid']))
})
it('rejects duplicate source obligations and flags incomplete completed rows', () => {
  expect(() => inspectPaymentEffects([effect(), { ...effect(), id: '2' }], [order])).toThrow('payment_effect_duplicate_order')
  expect(inspectPaymentEffects([{ ...effect(), completed_at: null }], [order]).blockers.map(b => b.code)).toContain('completion_state_inconsistent')
})
