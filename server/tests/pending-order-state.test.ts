import { expect, it } from 'vitest'
import { samePendingOrderState } from '../src/modules/trading/index.js'
const row = { accountId:'1',ticket:'12',symbol:'XAUUSD.s',type:'buy_limit',volume:'1',price:'4200',stopLoss:'4190',takeProfit:'4300',revision:2 }
it('accepts unchanged empty collections and revision-only updates', () => {
  expect(samePendingOrderState([], [], '1')).toBe(true)
  expect(samePendingOrderState([row], [{...row,revision:3}], '1')).toBe(true)
})
it.each([{volume:'0.5'},{price:'4201'},{stopLoss:'4180'},{takeProfit:'4310'},{ticket:'13'},{type:'sell_limit'},{symbol:'EURUSD'},{expiresAt:'2026-09-16'},{accountId:'2'}])('rejects actual order changes %j', patch => {
  expect(samePendingOrderState([row],[{...row,...patch}],'1')).toBe(false)
})
it('rejects added, removed, duplicate or unavailable orders', () => {
  expect(samePendingOrderState([], [row], '1')).toBe(false)
  expect(samePendingOrderState([row], [], '1')).toBe(false)
  expect(samePendingOrderState([row,row], [row,row], '1')).toBe(false)
  expect(samePendingOrderState(null, [], '1')).toBe(false)
})
