import type { Pool } from 'mysql2/promise'
import type { Queue } from 'bullmq'
import { createMysqlPeriodReviewDue } from '../modules/reviews/composition.js'

export function createPeriodReviewRecovery(pool:Pool,queue:Pick<Queue,'add'>) {
  const due=createMysqlPeriodReviewDue(pool)
  let cursor:string|null=null,pending:Promise<void>|null=null,stopped=false
  async function sweep() {
    const ids=await due.list(cursor,100)
    for(const id of ids) {
      if(stopped)return
      await queue.add('review.period.advance',{workflowId:id},{jobId:`period-review-${id}`,attempts:5,
        backoff:{type:'exponential',delay:1000},removeOnComplete:true,removeOnFail:true})
    }
    cursor=ids.length===100?ids.at(-1)!:null
  }
  return { tick(){ if(stopped)return Promise.resolve();return pending??=sweep().finally(()=>{pending=null}) },
    async stop(){stopped=true;await pending} }
}
