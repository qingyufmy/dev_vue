import { DelayedError, type Job } from 'bullmq'
import type { SystemReviewTaskRunner } from '../modules/reviews/index.js'

export interface SystemReviewJob { taskId: string }
export function createSystemReviewProcessor(runner: SystemReviewTaskRunner) {
  return async (job: Job<SystemReviewJob>, token?: string) => {
    if (job.name !== 'review.system.collect') throw Error('system_review_job_invalid')
    const result = await runner.run(job.data.taskId)
    if (result.state !== 'succeeded') {
      const retryAt = result.retryAt === null ? Date.now() + 250 : Date.parse(result.retryAt)
      if (!Number.isFinite(retryAt)) throw Error('system_review_retry_invalid')
      await job.moveToDelayed(Math.max(Date.now() + 250, retryAt), token)
      throw new DelayedError()
    }
    return result
  }
}
