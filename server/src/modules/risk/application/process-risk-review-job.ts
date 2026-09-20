import type { RiskReviewWorker } from './risk-review-worker.js'

/** A missing context is not a completed review. BullMQ owns the bounded backoff. */
export async function processRiskReviewJob(
  processor: Pick<RiskReviewWorker, 'process'>,
  settle: (decisionId: string, reason: string) => Promise<void>,
  decisionId: string,
  finalAttempt: boolean,
) {
  const result = await processor.process(decisionId)
  if (result.status !== 'stale') return result
  if (!finalAttempt) throw new Error(result.code)
  await settle(decisionId, result.code)
  return result
}
