import { createHash } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { contextWriteFingerprintInput, normalizeContextWrite, type ContextWriteCommand, type ContextWriteReceipt } from '../domain/context-write.js'
import { TradingAccessError, type TradingContext } from '../domain/trading.js'

export const contextCommandHash = (command: ContextWriteCommand) => createHash('sha256').update(contextWriteFingerprintInput(command)).digest('hex')
const opaque = (value: unknown): value is string => typeof value === 'string' && value.length <= 191 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && !/[^A-Za-z0-9._:-]/.test(value)
export function assertContextResult(command: ContextWriteCommand, result: TradingContext) {
  if (result.userId !== command.userId || result.revision !== command.expectedRevision + 1 || typeof result.readOnly !== 'boolean'
    || (result.mode === 'full' ? !opaque(result.accountId) || result.observerChannelId !== null
      : result.mode === 'observer' ? result.accountId !== null || !opaque(result.observerChannelId) || !result.readOnly
        : result.mode !== 'blocked' || result.accountId !== null || result.observerChannelId !== null || !result.readOnly)
    || (command.action === 'select_account' ? result.mode !== 'full' || result.accountId !== command.targetId
      : command.action === 'enter_observer' ? result.mode !== 'observer' || result.observerChannelId !== command.targetId
        : result.mode === 'observer')) throw new TradingAccessError('trading_context_write_failed', 503)
}

// Caller holds the active-principal row lock on this transaction until the receipt read completes.
export async function readContextReceipt(connection: PoolConnection, userId: number, requestId: string): Promise<{ receipt: ContextWriteReceipt; hash: string } | null> {
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT user_id,request_id,request_sha256,action,target_id,
    CAST(prior_revision AS CHAR) prior_revision,CAST(revision AS CHAR) revision,result_mode,result_account_id,
    result_observer_channel_id,result_read_only,
    CONCAT(LEFT(DATE_FORMAT(recorded_at_utc,'%Y-%m-%dT%H:%i:%s.%f'),23),'Z') recorded_at
    FROM trading_context_changes_v4 WHERE user_id=? AND request_id=?`, [userId, requestId])
  if (!rows.length) return null
  if (rows.length !== 1) throw new TradingAccessError('trading_context_write_failed', 503)
  try {
    const row = rows[0]!
    const command = normalizeContextWrite({ userId: Number(row.user_id), requestId: row.request_id,
      action: row.action, targetId: row.target_id, expectedRevision: Number(row.prior_revision) })
    if (command.userId !== userId || command.requestId !== requestId || row.request_sha256 !== contextCommandHash(command)
      || ![0, 1].includes(Number(row.result_read_only)) || typeof row.recorded_at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.recorded_at)
      || new Date(row.recorded_at).toISOString() !== row.recorded_at) throw new TradingAccessError('trading_context_write_failed', 503)
    const result: TradingContext = { userId, mode: row.result_mode, accountId: row.result_account_id,
      observerChannelId: row.result_observer_channel_id, readOnly: Number(row.result_read_only) === 1, revision: Number(row.revision) }
    assertContextResult(command, result)
    return { hash: row.request_sha256, receipt: { requestId, action: command.action, targetId: command.targetId,
      priorRevision: command.expectedRevision, result, recordedAt: row.recorded_at, replayed: true } }
  } catch { throw new TradingAccessError('trading_context_write_failed', 503) }
}
