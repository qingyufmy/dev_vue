import { randomUUID } from 'node:crypto'
import type { Pool } from 'mysql2/promise'
import { createActivePrincipalAccess } from '../modules/auth/composition.js'
import { createMysqlPeriodDiscoveryAccounts, createMysqlOwnedPeriodAccount, createMysqlOwnedHistoryAccess,
  createAccountInventorySummaryReader } from '../modules/trading/composition.js'
import { createMysqlPeriodReviewWorkflow, runReviewTransaction } from '../modules/reviews/composition.js'
import { listReviewPeriodCalendars } from '../modules/reviews/index.js'

type Account = Awaited<ReturnType<ReturnType<typeof createMysqlPeriodDiscoveryAccounts>['list']>>[number]
/** Scheduler registers at most twenty scopes per tick. Restart replays the unique scope, never overwrites progress. */
export function createPeriodReviewDiscovery(pool:Pool) {
  let afterAccountId:string|null=null,current:Account|null=null,afterPeriod:string|null=null
  let pending:Promise<void>|null=null,stopped=false
  async function scan() {
    const result=await runReviewTransaction(pool,async connection=>{
      const account=current??(await createMysqlPeriodDiscoveryAccounts(connection).list(afterAccountId,1))[0]
      if(!account)return {account:null,next:null,finished:true}
      const locks=createAccountInventorySummaryReader(connection)
      await locks.lockAccount(account.accountId)
      const owned=await createMysqlOwnedPeriodAccount(connection,createMysqlOwnedHistoryAccess(connection,createActivePrincipalAccess(connection))).read(account,account.nowUtcMsc)
      if(!owned)return {account,next:null,finished:false}
      const start=Math.max(account.firstClockUtcMsc,owned.historyStartUtcMsc),end=owned.availableThroughUtcMsc
      if(start>=end)return {account,next:null,finished:false}
      const page=listReviewPeriodCalendars({rangeStartUtcMsc:start,rangeEndUtcMsc:end,after:afterPeriod,limit:20})
      const store=createMysqlPeriodReviewWorkflow(connection,locks.lockAccount)
      for(const calendar of page.items)await store.register(randomUUID(),{userId:account.userId,accountId:account.accountId,
        ownershipIntervalId:account.ownershipIntervalId,kind:calendar.kind,key:calendar.key})
      return {account,next:page.next,finished:false}
    })
    if(result.finished){afterAccountId=null;current=null;afterPeriod=null}
    else if(result.next!==null){current=result.account!;afterPeriod=result.next}
    else {afterAccountId=result.account!.accountId;current=null;afterPeriod=null}
  }
  return {tick(){if(stopped)return Promise.resolve();return pending??=scan().finally(()=>{pending=null})},async stop(){stopped=true;await pending}}
}
