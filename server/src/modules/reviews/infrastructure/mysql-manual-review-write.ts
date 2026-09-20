import type { Pool, PoolConnection } from 'mysql2/promise'
import type { CreateManualReviewInput } from '../application/review-ports.js'
import { ReviewError, type ReviewCaseDetail } from '../domain/review.js'
import { isReviewCaseDetail } from '../domain/review-result.js'
import { executeReviewWrite, type ReviewWriteResult } from './mysql-review-write-receipts.js'
import { authorizeReviewCaseWrite } from './mysql-review-case-write.js'

export async function executeManualReviewWrite(pool: Pool, input: CreateManualReviewInput,
  work: (connection: PoolConnection) => Promise<ReviewCaseDetail>): Promise<ReviewCaseDetail> {
  const command = input.command
  if (command.actorUserId !== input.userId || command.action !== 'create_manual_case'
    || command.targetId !== null || command.expectedRevision !== null || command.idempotencyKey !== input.idempotencyKey) throw new ReviewError('review_command_invalid', 422)
  const result = await executeReviewWrite(pool, command, async connection => {
    const value = await work(connection)
    return { resourceId: value.summary.id, revision: value.summary.revision, value }
  }, (result): result is ReviewWriteResult<ReviewCaseDetail> => {
    if (!result || typeof result !== 'object') return false
    const candidate = result as ReviewWriteResult<unknown>
    return isReviewCaseDetail(candidate.value) && candidate.resourceId === candidate.value.summary.id
      && candidate.value.summary.userId === input.userId && candidate.value.summary.kind === 'manual'
      && candidate.value.summary.status === 'queued' && candidate.value.summary.revision === 1 && candidate.revision === 1
  }, async (connection, replayResourceId) => {
    // Fresh creation checks candidate ownership/eligibility in work. Replay uses the persisted case;
    // selection tokens may have expired or candidates may already have been consumed.
    if (replayResourceId !== null) await authorizeReviewCaseWrite(connection, input.userId, replayResourceId)
  })
  return result.value
}
