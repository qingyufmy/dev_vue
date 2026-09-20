import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { createActivePrincipalAccess } from '../modules/auth/composition.js'
import { createMysqlOwnedHistoryAccess, createMysqlOwnedPeriodAccount, createMysqlHistoricalClockReader,
  createAccountInventorySummaryReader } from '../modules/trading/composition.js'
import { createMysqlCompletedHistoryRouteReader } from '../modules/trade-history/composition.js'
import { createPeriodReviewWorkflow, reviewPeriodCalendar } from '../modules/reviews/index.js'
import { createMysqlPeriodReviewWorkflow, runReviewTransaction } from '../modules/reviews/composition.js'
import { createTransactionPeriodHistoryRequester } from './period-history-request.js'
import { createTransactionPeriodReviewCollector } from './period-review-collector.js'

export function createTransactionPeriodReviewWorkflow(connection: PoolConnection, nowUtcMsc:number) {
  const access = createMysqlOwnedHistoryAccess(connection,createActivePrincipalAccess(connection))
  const accounts = createMysqlOwnedPeriodAccount(connection,access), clocks = createMysqlHistoricalClockReader(connection)
  const requester = createTransactionPeriodHistoryRequester(connection), collector = createTransactionPeriodReviewCollector(connection)
  const routes = createMysqlCompletedHistoryRouteReader(connection)
  return createPeriodReviewWorkflow({
    async authorize(scope) { return !!await accounts.read(scope,nowUtcMsc) },
    async plan(scope,now) {
      const account = await accounts.read(scope,now)
      if (!account || account.platform !== 'mt5') return null
      const calendar = reviewPeriodCalendar(scope.kind,scope.key), asOfUtcMsc = account.availableThroughUtcMsc
      const start = await clocks.resolveLocal({ ...scope,asOfUtcMsc,localMidnightMsc:calendar.localStartMsc })
      const end = await clocks.resolveLocal({ ...scope,asOfUtcMsc,localMidnightMsc:calendar.localEndMsc })
      if (!start || !end || start.utcMsc < account.historyStartUtcMsc || end.utcMsc > asOfUtcMsc) return null
      return { period:{kind:scope.kind,key:scope.key,start,end},historyStartUtcMsc:account.historyStartUtcMsc,asOfUtcMsc }
    },
    nextHistoryTaskId:randomUUID,
    async request(scope,progress) {
      const account = await accounts.read(scope,nowUtcMsc)
      if (!account) return {status:'unavailable',reason:'period_ownership_unavailable'}
      const result = await requester.ensure({ ...scope,platform:account.platform,taskId:progress.historyTaskId,
        rangeStartUtcMsc:progress.plan.historyStartUtcMsc,rangeEndUtcMsc:progress.plan.asOfUtcMsc },new Date(nowUtcMsc))
      if (result.status === 'completed') return {status:'completed'}
      if (result.status === 'failed') return {status:'failed'}
      return result
    },
    async collect(scope,progress) {
      const route = await routes.read(progress.historyTaskId,scope)
      if (!route) return {status:'unresolved',reason:'period_history_route_unavailable'}
      const result = await collector.collect({taskId:progress.historyTaskId,route,ownershipIntervalId:scope.ownershipIntervalId,
        period:progress.plan.period,asOfUtcMsc:progress.plan.asOfUtcMsc})
      if (result.status === 'collected') return {status:'collected',caseIds:result.results.map(row=>row.caseId)}
      if (result.status === 'empty') return {status:'empty'}
      return {status:'unresolved',reason:result.reason}
    },
  })
}

export function createPeriodReviewTaskRunner(pool:Pool) {
  return { run(id:string) { return runReviewTransaction(pool,async connection => {
    const store = createMysqlPeriodReviewWorkflow(connection,createAccountInventorySummaryReader(connection).lockAccount)
    return store.run(id,(scope,progress,now)=>createTransactionPeriodReviewWorkflow(connection,now).advance(scope,progress,now))
  }) } }
}
