import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ContextWritePort } from '../application/context-write-port.js'
import { normalizeContextWrite, type ContextWriteCommand, type ContextWriteReceipt } from '../domain/context-write.js'
import { TradingAccessError, type TradingContext } from '../domain/trading.js'
import { assertContextResult, contextCommandHash, readContextReceipt } from './mysql-context-receipts.js'

// Resolver must use this connection to lock and validate the current target. No network I/O.
export type ContextTargetResolver = (connection: PoolConnection, command: ContextWriteCommand) => Promise<Omit<TradingContext, 'revision'>>

export class MysqlContextCommands implements ContextWritePort {
  constructor(private readonly pool: Pick<Pool, 'getConnection'>, private readonly resolveTarget: ContextTargetResolver) {}

  async execute(input: ContextWriteCommand): Promise<ContextWriteReceipt> {
    const command = Object.freeze(normalizeContextWrite(input)), digest = contextCommandHash(command)
    const connection = await this.pool.getConnection()
    let started = false, commitAttempted = false, destroyed = false
    try {
      await connection.beginTransaction(); started = true
      // An existing user row serializes the first context insertion as well as later revisions.
      const [users] = await connection.execute<RowDataPacket[]>("SELECT id FROM users WHERE id=? AND deletion_status='active' AND deleted_at IS NULL FOR UPDATE", [command.userId])
      if (users.length !== 1) throw new TradingAccessError('trading_account_forbidden', 403)
      const previous = await readContextReceipt(connection, command.userId, command.requestId)
      let result: ContextWriteReceipt
      if (previous) {
        if (previous.hash !== digest) throw new TradingAccessError('trading_context_idempotency_conflict', 409)
        result = previous.receipt
      } else {
        const [contexts] = await connection.execute<RowDataPacket[]>('SELECT CAST(revision AS CHAR) revision FROM trading_contexts WHERE user_id=? FOR UPDATE', [command.userId])
        if (contexts.length > 1 || Number(contexts[0]?.revision ?? 0) !== command.expectedRevision) throw new TradingAccessError('revision_conflict', 409)
        const next = { ...await this.resolveTarget(connection, command), revision: command.expectedRevision + 1 }
        assertContextResult(command, next)
        await connection.execute(`INSERT INTO trading_contexts
          (user_id,mode,trading_account_id,observer_channel_id,read_only,revision,updated_at_utc)
          VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE mode=VALUES(mode),trading_account_id=VALUES(trading_account_id),
          observer_channel_id=VALUES(observer_channel_id),read_only=VALUES(read_only),revision=VALUES(revision),updated_at_utc=VALUES(updated_at_utc)`,
        [command.userId, next.mode, next.accountId, next.observerChannelId, Number(next.readOnly), next.revision])
        await connection.execute(`INSERT INTO trading_context_changes_v4
          (user_id,request_id,request_sha256,action,target_id,prior_revision,revision,result_mode,result_account_id,result_observer_channel_id,result_read_only,recorded_at_utc)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [command.userId, command.requestId, digest, command.action, command.targetId,
          command.expectedRevision, next.revision, next.mode, next.accountId, next.observerChannelId, Number(next.readOnly)])
        const stored = await readContextReceipt(connection, command.userId, command.requestId)
        if (!stored || stored.hash !== digest || !Object.entries(stored.receipt.result).every(([key, value]) => next[key as keyof TradingContext] === value)) throw new TradingAccessError('trading_context_write_failed', 503)
        result = { ...stored.receipt, replayed: false }
      }
      commitAttempted = true; await connection.commit()
      return result
    } catch (error) {
      if (commitAttempted) {
        connection.destroy(); destroyed = true
        throw new TradingAccessError('trading_context_commit_unknown', 503)
      }
      if (started) {
        try { await connection.rollback() }
        catch { connection.destroy(); destroyed = true; throw new TradingAccessError('trading_context_rollback_unknown', 503) }
      }
      if (error instanceof TradingAccessError) throw error
      throw new TradingAccessError('trading_context_write_failed', 503)
    } finally { if (!destroyed) connection.release() }
  }

  async receipt(userId: number, requestId: string): Promise<ContextWriteReceipt | null> {
    normalizeContextWrite({ userId, requestId, action: 'leave_observer', targetId: null, expectedRevision: 0 })
    const connection = await this.pool.getConnection()
    try {
      const [users] = await connection.execute<RowDataPacket[]>("SELECT id FROM users WHERE id=? AND deletion_status='active' AND deleted_at IS NULL", [userId])
      if (users.length !== 1) throw new TradingAccessError('trading_account_forbidden', 403)
      return (await readContextReceipt(connection, userId, requestId))?.receipt ?? null
    } finally { connection.release() }
  }
}
