import { expect, it } from 'vitest'
import { samePositionState } from '../src/modules/trading/index.js'
const row = { accountId:'1',ticket:'12',symbol:'XAUUSD.s',side:'buy',volume:'1',openPrice:'4200',stopLoss:null,takeProfit:null,currentPrice:'4210',floatingProfit:'10',revision:2 }
it('ignores only price, profit and display revision while retaining manual positions', () => {
  expect(samePositionState([{...row,source:'manual'}],[{...row,source:'manual',currentPrice:'4211',floatingProfit:'11',revision:3}],'1')).toBe(true)
})
it.each([{volume:'0.5'},{stopLoss:'4190'},{takeProfit:'4300'},{ticket:'13'},{side:'sell'},{symbol:'EURUSD'},{openPrice:'4201'},{positionIdentifier:'changed'},{accountId:'2'}])('rejects real state changes %j', patch => {
  expect(samePositionState([row],[{...row,...patch}],'1')).toBe(false)
})
it('rejects missing, added and duplicate positions; collection order does not matter', () => {
  expect(samePositionState([row],[],'1')).toBe(false)
  expect(samePositionState([],[row],'1')).toBe(false)
  expect(samePositionState([row,row],[row,row],'1')).toBe(false)
  const other={...row,ticket:'13'}
  expect(samePositionState([row,other],[other,row],'1')).toBe(true)
})
