import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { strategyCommandHash, strategyWriteHash, strategyWriteJson, validStrategyResourceId,
  type StrategyWriteCommand } from '../application/strategy-write-command.js'
import { StrategyAccessError } from '../domain/strategy.js'
import { strategyTransaction } from './strategy-transaction.js'

export interface StrategyWriteResult<T> { resourceId: string; revision: number; value: T }
interface Receipt extends RowDataPacket {
  action: string; request_sha256: string; resource_id: string; result_revision: string
  result_json: unknown; result_sha256: string
}

// This remains private to strategy infrastructure. Callbacks must use this connection;
// no network I/O, nested transaction, retries, or postcommit readback.
export async function executeStrategyWrite<T>(pool: Pool, command: StrategyWriteCommand,
  work: (connection: PoolConnection) => Promise<StrategyWriteResult<T>>,
  validate: (value: unknown) => value is StrategyWriteResult<T>,
  authorize: (connection: PoolConnection) => Promise<void>): Promise<StrategyWriteResult<T>> {
  const requestHash = strategyCommandHash(command)
  const { actorUserId, idempotencyKey, action } = command
  return strategyTransaction(pool, async connection => {
    // Actor lock serializes new receipts as well as replays before target authorization.
    const [actors] = await connection.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE id=? AND deletion_status='active' AND deleted_at IS NULL FOR UPDATE", [actorUserId])
    if (actors.length !== 1) throw new StrategyAccessError('strategy_actor_forbidden', 403)
    // Recheck target/account visibility on both first submission and replay.
    // The caller must follow its business lock order when acquiring target locks.
    await authorize(connection)
    const [receipts] = await connection.execute<Receipt[]>(`SELECT action,request_sha256,resource_id,
      CAST(result_revision AS CHAR) result_revision,result_json,result_sha256 FROM strategy_write_receipts_v4
      WHERE actor_user_id=? AND idempotency_key=? FOR UPDATE`, [actorUserId, idempotencyKey])
    if (receipts.length > 1) throw new StrategyAccessError('strategy_receipt_invalid', 503)
    const receipt = receipts[0]
    if (receipt) {
      if (receipt.action !== action || receipt.request_sha256 !== requestHash) {
        throw new StrategyAccessError('strategy_idempotency_conflict', 409)
      }
      try {
        const result: unknown = typeof receipt.result_json === 'string' ? JSON.parse(receipt.result_json) : receipt.result_json
        if (!validate(result) || !validStrategyResourceId(result.resourceId) || !Number.isSafeInteger(result.revision)
          || result.revision < 1 || result.resourceId !== receipt.resource_id || String(result.revision) !== receipt.result_revision
          || strategyWriteHash(strategyWriteJson(result)) !== receipt.result_sha256) throw new Error('invalid receipt')
        return result
      } catch { throw new StrategyAccessError('strategy_receipt_invalid', 503) }
    }
    const result = await work(connection)
    if (!validate(result) || !validStrategyResourceId(result.resourceId) || !Number.isSafeInteger(result.revision)
      || result.revision < 1) throw new StrategyAccessError('strategy_write_result_invalid', 503)
    const resultJson = strategyWriteJson(result)
    await connection.execute(`INSERT INTO strategy_write_receipts_v4
      (actor_user_id,idempotency_key,action,request_sha256,resource_id,result_revision,result_json,result_sha256,recorded_at_utc)
      VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [actorUserId, idempotencyKey, action,
      requestHash, result.resourceId, result.revision, resultJson, strategyWriteHash(resultJson)])
    return result
  })
}
