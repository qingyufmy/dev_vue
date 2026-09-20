import { expect, it } from 'vitest'
import { findDuplicatePendingOrder, type PendingDedupOrder, type PendingDedupRequest } from '../src/modules/execution/domain/pending-order-dedup.js'

const scope = { userId: 7, accountId: '42', strategyId: 'strategy-1' }
const request: PendingDedupRequest = { scope, instrumentId: 'XAUUSD', type: 'buy_limit', price: '2500',
  atrAnchor: '10', atrMultiplier: '0.05', tickSize: '0.01', point: '0.01' }
const order: PendingDedupOrder = { ticket: '9001', instrumentId: 'XAUUSD', type: 'buy_limit', price: '2500.5', verifiedOrigin: scope }

it('includes the exact ATR-distance boundary and excludes the smallest larger price', () => {
  expect(findDuplicatePendingOrder(request, [order])).toBe('9001')
  expect(findDuplicatePendingOrder(request, [{ ...order, price: '2500.500000000000000001' }])).toBeNull()
})
it('uses broker price-step floor with missing ATR or zero multiplier', () => {
  expect(findDuplicatePendingOrder({ ...request, atrAnchor: null }, [{ ...order, price: '2500.01' }])).toBe('9001')
  expect(findDuplicatePendingOrder({ ...request, atrMultiplier: '0' }, [order])).toBeNull()
  expect(findDuplicatePendingOrder({ ...request, tickSize: '1' }, [order])).toBe('9001')
})
it('requires matching account, user, strategy, instrument and pending type', () => {
  for (const candidate of [{ ...order, verifiedOrigin: null }, { ...order, verifiedOrigin: { ...scope, accountId: 'other' } },
    { ...order, verifiedOrigin: { ...scope, userId: 8 } }, { ...order, verifiedOrigin: { ...scope, strategyId: 'other' } },
    { ...order, instrumentId: 'other' }, { ...order, type: 'buy_stop' as const }]) {
    expect(findDuplicatePendingOrder(request, [candidate])).toBeNull()
  }
})
it('rejects malformed evidence instead of treating it as no duplicate', () => {
  expect(() => findDuplicatePendingOrder({ ...request, tickSize: '0', point: '0' }, [order])).toThrow()
  expect(() => findDuplicatePendingOrder(request, [{ ...order, price: 'NaN' }])).toThrow()
  expect(() => findDuplicatePendingOrder(request, [{ ...order, ticket: '' }])).toThrow()
  expect(() => findDuplicatePendingOrder({ ...request, atrMultiplier: '5.01' }, [order])).toThrow()
})
