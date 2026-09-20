import { expect, it, vi } from 'vitest'
import { DelayedError, type Job } from 'bullmq'
import { createSystemReviewProcessor, type SystemReviewJob } from '../src/queue/system-review-processor.js'

it.each(['pending', 'waiting'] as const)('keeps the same queue job alive for %s instead of completing the scan', async state => {
  const moveToDelayed = vi.fn().mockResolvedValue(undefined)
  const retryAt = new Date(Date.now() + 60_000).toISOString()
  const run = vi.fn().mockResolvedValue({ state, retryAt })
  const processor = createSystemReviewProcessor({ run })
  const job = { name: 'review.system.collect', data: { taskId: 'task' }, moveToDelayed } as unknown as Job<SystemReviewJob>
  await expect(processor(job, 'lease')).rejects.toBeInstanceOf(DelayedError)
  expect(moveToDelayed).toHaveBeenCalledWith(Date.parse(retryAt), 'lease')
  run.mockResolvedValue({ state: 'succeeded', retryAt: null })
  await expect(processor(job, 'lease')).resolves.toEqual({ state: 'succeeded', retryAt: null })
  expect(moveToDelayed).toHaveBeenCalledTimes(1)
})

it('propagates a failed transaction for queue retry', async () => {
  const processor = createSystemReviewProcessor({ run: vi.fn().mockRejectedValue(Error('review_commit_unknown')) })
  const moveToDelayed = vi.fn()
  await expect(processor({ name: 'review.system.collect', data: { taskId: 'task' }, moveToDelayed } as unknown as Job<SystemReviewJob>))
    .rejects.toThrow('review_commit_unknown')
  expect(moveToDelayed).not.toHaveBeenCalled()
})
