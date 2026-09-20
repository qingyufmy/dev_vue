import { expect, it } from 'vitest'
import { prepareSubscriptionCreate, clearSubscriptionCreate } from './subscription-create-request'

it('retains the exact account subscription request until its result is confirmed', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const body = { trading_account_id: '5', symbol: 'XAUUSD', analysis_strategy_id: '2' }
  const first = prepareSubscriptionCreate(storage, '7', body, () => 'subscription-create-001')
  expect(prepareSubscriptionCreate(storage, '7', body)).toEqual(first)
  expect(() => prepareSubscriptionCreate(storage, '7', { ...body, symbol: 'EURUSD' })).toThrow('上次订阅创建尚未确认')
  expect(prepareSubscriptionCreate(storage, '7', { ...body, trading_account_id: '6' }, () => 'subscription-create-002').idempotencyKey).not.toBe(first.idempotencyKey)
  clearSubscriptionCreate(storage, '7', '5')
  expect(prepareSubscriptionCreate(storage, '7', body, () => 'subscription-create-003').idempotencyKey).toBe('subscription-create-003')
})
