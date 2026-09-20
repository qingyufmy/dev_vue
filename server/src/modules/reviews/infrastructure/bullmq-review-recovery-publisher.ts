import { createHash } from 'node:crypto'
import type { Queue } from 'bullmq'
import type { ReviewRecoveryCandidate, ReviewRecoveryPublisher } from '../application/review-recovery.js'
export class BullmqReviewRecoveryPublisher implements ReviewRecoveryPublisher {
  constructor(private readonly queue: Pick<Queue, 'add'>) {}
  async wake(candidate: ReviewRecoveryCandidate) {
    const id = createHash('sha256').update(JSON.stringify([candidate.jobId, candidate.fencingToken])).digest('hex')
    await this.queue.add('review.run', { reviewJobId: candidate.jobId }, {
      jobId: `review-recovery-${id}`, priority: 20, attempts: 5, backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true, removeOnFail: true,
    })
  }
}
