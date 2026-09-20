import type { PoolConnection } from 'mysql2/promise'
import { createMysqlPeriodTradeInventory } from '../modules/trade-history/composition.js'
import { freezeReviewPeriod, selectPeriodReviewTrades, type ReviewPeriod } from '../modules/reviews/index.js'

/** Historical boundary authorization must precede this transaction-level collector. */
export function createTransactionPeriodReviewInventory(connection: PoolConnection) {
  const reader=createMysqlPeriodTradeInventory(connection)
  return {async read(input:Omit<Parameters<typeof reader.read>[0],'startUtcMsc'|'endUtcMsc'> & {period:ReviewPeriod}) {
    const period=freezeReviewPeriod(input.period,input.asOfUtcMsc)
    const result=await reader.read({...input,startUtcMsc:period.start.utcMsc,endUtcMsc:period.end.utcMsc})
    if(result.status!=='captured')return result
    return selectPeriodReviewTrades(period,result.inventory)
  }}
}
