import { expect, it } from 'vitest'
import { freezeReviewPeriod, belongsToReviewPeriod, type ReviewPeriod } from '../src/modules/reviews/domain/review-period.js'
import { selectPeriodReviewTrades, type PeriodTradeInventory } from '../src/modules/reviews/application/period-review-inventory.js'
const boundary=(local:string,offsetMinutes:number)=>({utcMsc:Date.parse(local)-offsetMinutes*60000,offsetMinutes,evidenceRef:'clock:proof'})
const period:ReviewPeriod={kind:'daily',key:'2026-03-29',start:boundary('2026-03-29T00:00:00Z',120),end:boundary('2026-03-30T00:00:00Z',180)}
it('freezes separate boundary offsets for a 23-hour terminal day',()=>{
 const frozen=freezeReviewPeriod(period,period.end.utcMsc)
 expect(frozen.end.utcMsc-frozen.start.utcMsc).toBe(23*3600000)
 expect(belongsToReviewPeriod(frozen,frozen.start.utcMsc)).toBe(true)
 expect(belongsToReviewPeriod(frozen,frozen.end.utcMsc)).toBe(false)
})
it('supports leap months and a 25-hour day without using host timezone',()=>{
 const month:ReviewPeriod={kind:'monthly',key:'2024-02',start:boundary('2024-02-01T00:00:00Z',180),end:boundary('2024-03-01T00:00:00Z',180)}
 expect(freezeReviewPeriod(month,month.end.utcMsc).end.utcMsc-month.start.utcMsc).toBe(29*86400000)
 const long={...period,start:{...period.start,utcMsc:period.start.utcMsc-3600000,offsetMinutes:180},end:{...period.end,utcMsc:period.end.utcMsc+3600000,offsetMinutes:120}}
 expect(freezeReviewPeriod(long,long.end.utcMsc).end.utcMsc-long.start.utcMsc).toBe(25*3600000)
})
it('rejects invalid dates, guessed offsets, absent proof and unfinished periods',()=>{
 expect(()=>freezeReviewPeriod({...period,key:'2026-02-30'},period.end.utcMsc)).toThrow('review_period_key_invalid')
 expect(()=>freezeReviewPeriod({...period,end:{...period.end,offsetMinutes:120}},period.end.utcMsc)).toThrow('review_period_boundary_unproven')
 expect(()=>freezeReviewPeriod({...period,start:{...period.start,evidenceRef:''}},period.end.utcMsc)).toThrow('review_period_boundary_unproven')
 expect(()=>freezeReviewPeriod(period,period.end.utcMsc-1)).toThrow('review_period_not_closed')
})
const inventory=():PeriodTradeInventory=>({accountId:'5',rangeStartUtcMsc:period.start.utcMsc,rangeEndUtcMsc:period.end.utcMsc+1000,
 asOfUtcMsc:period.end.utcMsc+1000,completionHash:'a'.repeat(64),records:[{id:'trade',revision:1,closedAtUtcMsc:period.start.utcMsc,
 source:'system',attribution:'exact',evidenceHash:'b'.repeat(64),accountCurrency:'USD'}]})
it('selects closure within the half-open interval and retains explicit manual exclusion',()=>{
 const data=inventory();data.records.push({...data.records[0]!,id:'next',closedAtUtcMsc:period.end.utcMsc},{...data.records[0]!,id:'manual',source:'manual'})
 expect(selectPeriodReviewTrades(period,data)).toMatchObject({status:'selected',records:[{id:'trade'}],exclusions:[{id:'manual'}]})
})
it('never treats an incomplete inventory, unknown source or mixed currency as a full period',()=>{
 const missing=inventory();missing.rangeEndUtcMsc=period.end.utcMsc
 expect(selectPeriodReviewTrades(period,missing)).toMatchObject({status:'unresolved'})
 const unknown=inventory();unknown.records[0]!.source='unknown'
 expect(selectPeriodReviewTrades(period,unknown)).toMatchObject({reason:'period_trade_source_incomplete'})
 const money=inventory();money.records.push({...money.records[0]!,id:'eur',accountCurrency:'EUR'})
 expect(selectPeriodReviewTrades(period,money)).toMatchObject({reason:'period_currency_incomplete'})
 const empty=inventory();empty.records=[]
 expect(selectPeriodReviewTrades(period,empty)).toMatchObject({status:'empty'})
 const invalidTime=inventory();invalidTime.records[0]!.closedAtUtcMsc=NaN
 expect(selectPeriodReviewTrades(period,invalidTime)).toMatchObject({reason:'period_inventory_incomplete'})
})
