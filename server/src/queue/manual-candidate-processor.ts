import { DelayedError, type Job } from 'bullmq'
import type { ManualCandidateTaskRunner } from '../modules/reviews/index.js'

export interface ManualCandidateJob { taskId: string }
export function createManualCandidateProcessor(runner: ManualCandidateTaskRunner) {
  return async (job: Job<ManualCandidateJob>, token?: string) => {
    if (job.name !== 'review.candidates.collect') throw Error('manual_candidate_job_invalid')
    const result = await runner.run(job.data.taskId)
    if (result.state !== 'succeeded') {
      const retryAt = result.retryAt === null ? Date.now() + 250 : Date.parse(result.retryAt)
      if (!Number.isFinite(retryAt)) throw Error('manual_candidate_retry_invalid')
      await job.moveToDelayed(Math.max(Date.now() + 250, retryAt), token)
      throw new DelayedError()
    }
    return result
  }
}
