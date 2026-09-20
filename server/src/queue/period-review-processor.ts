import type { Job } from 'bullmq'
import type { PeriodReviewTaskRunner } from '../modules/reviews/index.js'

export interface PeriodReviewJob { workflowId:string }
export function createPeriodReviewProcessor(runner:PeriodReviewTaskRunner) {
  return async (job:Job<PeriodReviewJob>) => {
    if(job.name!=='review.period.advance' || !/^[a-f0-9-]{36}$/i.test(job.data.workflowId)) throw Error('period_review_job_invalid')
    // The durable next-at timestamp controls further wakes; no in-memory retry chain owns business state.
    return runner.run(job.data.workflowId)
  }
}
