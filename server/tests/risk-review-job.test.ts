import { expect, it, vi } from 'vitest'
import { processRiskReviewJob } from '../src/modules/risk/application/process-risk-review-job.js'

it('retries missing context instead of acknowledging a completed review', async () => {
  const processor = { process: vi.fn().mockResolvedValue({ status: 'stale', code: 'risk_review_market_context_incomplete' }) }
  const settle = vi.fn()
  await expect(processRiskReviewJob(processor, settle, 'd1', false)).rejects.toThrow('risk_review_market_context_incomplete')
  expect(settle).not.toHaveBeenCalled()
})

it('settles an exhausted review before acknowledging it', async () => {
  const processor = { process: vi.fn().mockResolvedValue({ status: 'stale', code: 'risk_review_market_context_incomplete' }) }
  const settle = vi.fn().mockResolvedValue(undefined)
  await processRiskReviewJob(processor, settle, 'd1', true)
  expect(settle).toHaveBeenCalledWith('d1', 'risk_review_market_context_incomplete')
  settle.mockRejectedValueOnce(new Error('write_failed'))
  await expect(processRiskReviewJob(processor, settle, 'd1', true)).rejects.toThrow('write_failed')
})

it('does not expire a completed or already settled review', async () => {
  const settle = vi.fn()
  const processor = { process: vi.fn().mockResolvedValue({ status: 'ignored' }) }
  await expect(processRiskReviewJob(processor, settle, 'd1', true)).resolves.toEqual({ status: 'ignored' })
  expect(settle).not.toHaveBeenCalled()
})
