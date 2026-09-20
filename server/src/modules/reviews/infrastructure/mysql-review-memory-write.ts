import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { ReviewError, type StrategyMemoryUpdate } from '../domain/review.js'
import { isStrategyMemoryUpdate } from '../domain/review-result.js'
import type { ReviewRepository } from '../application/review-ports.js'
import { executeReviewWrite, type ReviewWriteResult } from './mysql-review-write-receipts.js'

export async function executeReviewMemoryWrite(pool: Pool, input: Parameters<ReviewRepository['decideMemoryUpdate']>[0],
  work: (connection: PoolConnection) => Promise<StrategyMemoryUpdate>): Promise<StrategyMemoryUpdate> {
  if (input.command.actorUserId !== input.userId || input.command.action !== 'decide_memory_update'
    || input.command.targetId !== input.updateId || input.command.expectedRevision !== input.expectedRevision) throw new ReviewError('review_command_invalid', 422)
  const status = input.decision === 'accept' ? 'merged' : input.decision === 'reject' ? 'rejected' : 'superseded'
  const result = await executeReviewWrite(pool, input.command, async connection => {
    const value = await work(connection)
    return { resourceId: value.id, revision: value.revision, value }
  }, (result): result is ReviewWriteResult<StrategyMemoryUpdate> => {
    if (!result || typeof result !== 'object') return false
    const candidate = result as ReviewWriteResult<unknown>
    return isStrategyMemoryUpdate(candidate.value) && candidate.resourceId === candidate.value.id
      && candidate.revision === candidate.value.revision && candidate.value.status === status
      && candidate.revision === input.expectedRevision + 1
  }, async connection => {
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT u.library_id
      FROM strategy_memory_pending_updates_v4 u INNER JOIN strategy_memory_libraries_v4 l ON l.id=u.library_id
      WHERE u.id=? AND l.owner_user_id=? FOR UPDATE`, [input.updateId, input.userId])
    if (rows.length !== 1) throw new ReviewError('strategy_memory_update_not_found', 404)
  })
  return result.value
}
