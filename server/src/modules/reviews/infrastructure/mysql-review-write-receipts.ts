import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { reviewWriteHash, reviewWriteJson, type ReviewWriteCommand } from '../application/review-write-command.js'
import { ReviewError } from '../domain/review.js'
import { reviewTransaction } from './review-transaction.js'

export interface ReviewWriteResult<T> { resourceId: string; revision: number; value: T }
interface Receipt extends RowDataPacket {
  action: string; request_sha256: string; resource_id: string; result_revision: string
  result_json: unknown; result_sha256: string
}

// All callbacks use this connection; no nested transaction or external I/O.
export async function executeReviewWrite<T>(pool: Pool, command: ReviewWriteCommand,
  work: (connection: PoolConnection) => Promise<ReviewWriteResult<T>>,
  validate: (value: unknown) => value is ReviewWriteResult<T>,
  authorize: (connection: PoolConnection, replayResourceId: string | null) => Promise<void>): Promise<ReviewWriteResult<T>> {
  const validResult = (value: unknown): value is ReviewWriteResult<T> => validate(value)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(value.resourceId)
    && Number.isSafeInteger(value.revision) && value.revision > 0
    && (command.targetId === null || value.resourceId === command.targetId)
  return reviewTransaction(pool, async connection => {
    const [actors] = await connection.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE id=? AND deletion_status='active' AND deleted_at IS NULL FOR UPDATE", [command.actorUserId])
    if (actors.length !== 1) throw new ReviewError('review_actor_forbidden', 403)
    const [receipts] = await connection.execute<Receipt[]>(`SELECT action,request_sha256,resource_id,
      CAST(result_revision AS CHAR) result_revision,result_json,result_sha256 FROM review_write_receipts_v4
      WHERE actor_user_id=? AND idempotency_key=? FOR UPDATE`, [command.actorUserId, command.idempotencyKey])
    if (receipts.length > 1) throw new ReviewError('review_receipt_invalid', 503)
    const receipt = receipts[0]
    if (receipt) {
      if (receipt.action !== command.action || receipt.request_sha256 !== command.requestHash) throw new ReviewError('review_idempotency_conflict', 409)
      let result: ReviewWriteResult<T>
      try {
        const parsed: unknown = typeof receipt.result_json === 'string' ? JSON.parse(receipt.result_json) : receipt.result_json
        if (!validResult(parsed) || parsed.resourceId !== receipt.resource_id || String(parsed.revision) !== receipt.result_revision
          || reviewWriteHash(reviewWriteJson(parsed)) !== receipt.result_sha256) throw new Error('invalid receipt')
        result = parsed
      } catch { throw new ReviewError('review_receipt_invalid', 503) }
      await authorize(connection, result.resourceId)
      return result
    }
    await authorize(connection, null)
    const result = await work(connection)
    let resultJson: string
    try {
      if (!validResult(result)) throw new Error('invalid result')
      resultJson = reviewWriteJson(result)
    } catch { throw new ReviewError('review_write_result_invalid', 503) }
    await connection.execute(`INSERT INTO review_write_receipts_v4
      (actor_user_id,idempotency_key,action,request_sha256,resource_id,result_revision,result_json,result_sha256,recorded_at_utc)
      VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [command.actorUserId, command.idempotencyKey, command.action,
      command.requestHash, result.resourceId, result.revision, resultJson, reviewWriteHash(resultJson)])
    return result
  })
}
