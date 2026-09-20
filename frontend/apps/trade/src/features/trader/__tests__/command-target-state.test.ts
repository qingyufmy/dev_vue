import { describe, expect, it } from 'vitest'
import { sameCommandTarget } from '../model/command-target-state'
const position = { accountId: '1', ticket: '829936702', symbol: 'XAUUSD.s', side: 'buy', volume: '1',
  stopLoss: null, takeProfit: null, currentPrice: '4270', floatingProfit: '10', revision: '1' }
describe('confirmation target recheck', () => {
  it('accepts price and profit refresh without changing user intent', () => {
    expect(sameCommandTarget(position, { ...position, currentPrice: '4271', floatingProfit: '11', revision: '2' })).toBe(true)
  })
  it.each([{ volume: '0.5' }, { stopLoss: '4250' }, { takeProfit: '4330' }, { accountId: '2' },
    { ticket: 'other' }, { side: 'sell' }, { symbol: 'EURUSD' }, { expiration: 'changed' }])('rejects changed resource %j', change => {
    expect(sameCommandTarget(position, { ...position, ...change })).toBe(false)
  })
})
