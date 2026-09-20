import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { StrategyDetail, StrategyKind } from '../domain/strategy.js'
import { StrategyAccessError } from '../domain/strategy.js'
import { executeStrategyWrite, type StrategyWriteResult } from './mysql-strategy-write-receipts.js'

export interface OwnedStrategyWrite {
  userId: number; strategyId: string; expectedRevision: number; idempotencyKey: string
}
export async function writeOwnedStrategy(pool: Pool, input: OwnedStrategyWrite,
  action: 'update_metadata' | 'create_version' | 'publish_version' | 'retire_strategy', payload: Record<string, unknown>,
  write: (connection: PoolConnection, kind: StrategyKind) => Promise<void>,
  read: (connection: PoolConnection) => Promise<StrategyDetail | null>): Promise<StrategyDetail> {
  let current: { kind: StrategyKind; status: string; revision: string } | undefined
  const outcome = await executeStrategyWrite(pool, { actorUserId: input.userId, idempotencyKey: input.idempotencyKey,
    action, targetId: input.strategyId, expectedRevision: input.expectedRevision, payload }, async connection => {
    if (!current) throw new StrategyAccessError('strategy_not_found', 404)
    if (current.status === 'retired') throw new StrategyAccessError('strategy_retired', 409)
    if (current.revision !== String(input.expectedRevision) || input.expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new StrategyAccessError('strategy_revision_conflict', 412)
    }
    await write(connection, current.kind)
    const detail = await read(connection)
    if (!detail) throw new StrategyAccessError('strategy_write_result_invalid', 503)
    return { resourceId: detail.summary.id, revision: detail.summary.revision, value: detail }
  }, (result): result is StrategyWriteResult<StrategyDetail> => {
    const item = result as StrategyWriteResult<StrategyDetail> | null
    return !!item && !!item.value?.summary && item.resourceId === input.strategyId
      && item.value.summary.id === input.strategyId && item.value.summary.ownerUserId === input.userId
      && item.value.summary.scope === 'user' && item.value.summary.revision === item.revision
      && item.revision === input.expectedRevision + 1 && Array.isArray(item.value.versions)
  }, async connection => {
    const [rows] = await connection.execute<(RowDataPacket & { scope: string; owner_user_id: number; kind: StrategyKind; status: string; revision: string })[]>(
      `SELECT scope,owner_user_id,kind,status,CAST(revision AS CHAR) revision FROM strategies
      WHERE id=? AND deleted_at_utc IS NULL AND (scope='platform' OR owner_user_id=?) LIMIT 1 FOR UPDATE`, [input.strategyId, input.userId])
    const row = rows[0]
    if (!row) throw new StrategyAccessError('strategy_not_found', 404)
    if (row.scope !== 'user' || row.owner_user_id !== input.userId) throw new StrategyAccessError('strategy_read_only', 403)
    current = row
  })
  return outcome.value
}
