import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { ReviewError, type ReviewCaseDetail, type ReviewCaseStatus } from '../domain/review.js'
import { isReviewCaseDetail } from '../domain/review-result.js'
import type { ReviewWriteCommand } from '../application/review-write-command.js'
import { executeReviewWrite, type ReviewWriteResult } from './mysql-review-write-receipts.js'

type CaseWriteAction = 'return_case' | 'request_generation' | 'create_version' | 'confirm_version'
interface CaseWriteInput { userId: number; caseId: string; expectedRevision: number; command: ReviewWriteCommand }

export async function executeReviewCaseWrite(pool: Pool, input: CaseWriteInput, action: CaseWriteAction,
  status: ReviewCaseStatus, work: (connection: PoolConnection) => Promise<ReviewCaseDetail>): Promise<ReviewCaseDetail> {
  if (input.command.actorUserId !== input.userId || input.command.action !== action
    || input.command.targetId !== input.caseId || input.command.expectedRevision !== input.expectedRevision) throw new ReviewError('review_command_invalid', 422)
  const result = await executeReviewWrite(pool, input.command, async connection => {
    const value = await work(connection)
    return { resourceId: value.summary.id, revision: value.summary.revision, value }
  }, (result): result is ReviewWriteResult<ReviewCaseDetail> => {
    if (!result || typeof result !== 'object') return false
    const candidate = result as ReviewWriteResult<unknown>
    return isReviewCaseDetail(candidate.value) && candidate.resourceId === candidate.value.summary.id
      && candidate.revision === candidate.value.summary.revision && candidate.value.summary.userId === input.userId
      && candidate.value.summary.status === status && candidate.revision === input.expectedRevision + 1
  }, connection => authorizeReviewCaseWrite(connection, input.userId, input.caseId))
  return result.value
}

export async function authorizeReviewCaseWrite(connection: PoolConnection, userId: number, caseId: string): Promise<void> {
    const [cases] = await connection.execute<(RowDataPacket & { trading_account_id: string; legacy_source_table?: string | null; status?: string })[]>(
      'SELECT trading_account_id,legacy_source_table,status FROM review_cases_v4 WHERE id=? AND user_id=? FOR UPDATE', [caseId, userId])
    if (!cases[0]) throw new ReviewError('review_case_not_found', 404)
    const [owners] = await connection.execute<RowDataPacket[]>(
      "SELECT user_id FROM trading_account_ownerships WHERE trading_account_id=? AND user_id=? AND role='owner' AND revoked_at_utc IS NULL FOR SHARE", [cases[0].trading_account_id, userId])
    if (owners.length !== 1) throw new ReviewError('review_case_not_found', 404)
    if (cases[0].legacy_source_table || cases[0].status === 'archived') throw new ReviewError('review_legacy_version_readonly', 409)
}
