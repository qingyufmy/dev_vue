import { expect, it } from 'vitest'
import { inspectPaymentWatches } from '../scripts/lib/v4-payment-watch-source.mjs'
const order = () => ({ id: '1', order_id: 'external', user_id: '2', status: 'expired', crypto_chain: 'TRON', crypto_address: 'address',
  crypto_amount: '1', crypto_tx_hash: null, crypto_expires_at: '2026-09-01 13:00:00' })
const watch = () => ({ id: '3', order_id: 'external', user_id: '2', chain: 'TRON', address: 'address', expected_amount: '1.00000000',
  status: 'expired', tx_hash: null, confirmations: '0', required_confirmations: '19', wallet_index: '0',
  created_at: '2026-09-01 04:00:00', expires_at: '2026-09-01 13:00:00' })
const inspect = (rows = [watch()], orders = [order()]) => inspectPaymentWatches(rows, orders, { sessionOffset: '+00:00' })
it('resolves only TIMESTAMP in a verified UTC session and keeps DATETIME unresolved', () => {
  const result = inspect()
  expect(result.entries[0].createdAtUtc).toBe('2026-09-01 04:00:00.000')
  expect(result.entries[0].expiresAtUtc).toBeNull()
  expect(result.blockers).toEqual([{ sourceId: '3', code: 'expiry_time_basis_required' }])
  expect(() => inspectPaymentWatches([watch()], [order()])).toThrow('payment_watch_utc_session_required')
})
it('retains source facts and catches mismatched owner, amount and state', () => {
  const row = { ...watch(), user_id: '4', expected_amount: '2', status: 'pending' }, result = inspect([row])
  expect(result.entries[0].source).toEqual(row)
  expect(result.blockers.map(b => b.code)).toEqual(expect.arrayContaining(['order_user_mismatch', 'expected_amount_mismatch', 'order_watch_status_mismatch']))
})
it('does not infer successful payment from a transaction hash', () => {
  const result = inspect([{ ...watch(), status: 'confirmed', tx_hash: 'hash', confirmations: '18' }])
  expect(result.blockers.map(b => b.code)).toContain('confirmation_threshold_unproven')
  expect(result.entries[0].createsTransaction).toBe(false)
  expect(result.entries[0].activatesWatch).toBe(false)
})
it('blocks duplicate claims and multiple watches per order', () => {
  const result = inspect([{ ...watch(), tx_hash: 'hash' }, { ...watch(), id: '4', tx_hash: 'hash' }])
  expect(result.blockers.filter(b => b.code === 'duplicate_transaction_hash')).toHaveLength(2)
  expect(result.blockers.filter(b => b.code === 'multiple_watches_for_order')).toHaveLength(2)
})
it('does not silently change external identity comparison or require watches for every paid order', () => {
  const result = inspect([{ ...watch(), order_id: 'EXTERNAL' }])
  expect(result.blockers.map(b => b.code)).toContain('exact_order_missing')
  expect(result.ordersWithoutWatch).toEqual(['1'])
  expect(inspect([], [{ ...order(), status: 'paid' }]).ordersWithoutWatch).toEqual(['1'])
})
it('blocks an active order without a watch and a zero confirmation policy', () => {
  expect(inspect([], [{ ...order(), status: 'pending' }]).orderBlockers).toEqual([{ sourceId: '1', code: 'pending_order_watch_missing' }])
  expect(inspect([{ ...watch(), required_confirmations: '0' }]).blockers.map(b => b.code)).toContain('confirmation_policy_unproven')
})
