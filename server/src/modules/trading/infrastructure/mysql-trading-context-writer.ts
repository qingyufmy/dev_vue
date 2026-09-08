import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { TradingAccessError, type TradingContext } from '../domain/trading.js'
import type { MysqlObserverAccessReader } from './mysql-observer-access-reader.js'

interface ContextRevisionRow extends RowDataPacket { revision: string | number }

// Owns only context persistence; other projection transactions retain their own lifecycle.
export class MysqlTradingContextWriter {
  constructor(private readonly pool: Pick<Pool, 'getConnection'>,
    private readonly observerAccess: Pick<MysqlObserverAccessReader, 'authorizeOn'>) {}

  async saveContext(next: Omit<TradingContext, 'revision'>, expectedRevision: number | null): Promise<TradingContext> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision === null || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER
      || next.mode === 'observer' && !next.readOnly) throw new TradingAccessError('trading_context_invalid', 400)
    const connection: PoolConnection = await this.pool.getConnection()
    let started = false, commitAttempted = false, destroyed = false
    try {
      await connection.beginTransaction(); started = true
      const [rows] = await connection.execute<ContextRevisionRow[]>('SELECT revision FROM trading_contexts WHERE user_id=? FOR UPDATE', [next.userId])
      const current = rows[0]?.revision ?? 0
      if (!Number.isSafeInteger(Number(current)) || Number(current) !== expectedRevision) throw new TradingAccessError('revision_conflict', 409)
      if (next.mode === 'full') {
        const [access] = await connection.execute<RowDataPacket[]>('SELECT 1 FROM trading_account_ownerships WHERE user_id=? AND trading_account_id=? AND role=\'owner\' AND revoked_at_utc IS NULL LIMIT 1 FOR SHARE', [next.userId, next.accountId])
        if (!access[0]) throw new TradingAccessError('trading_account_forbidden', 403)
      } else if (next.mode === 'observer') {
        if (next.accountId !== null || !next.observerChannelId) throw new TradingAccessError('trading_account_forbidden', 403)
        const allowed = await this.observerAccess.authorizeOn(connection, next.userId, next.observerChannelId)
        if (!allowed) throw new TradingAccessError('trading_account_forbidden', 403)
      }
      const revision = Number(current) + 1
      await connection.execute(`INSERT INTO trading_contexts (user_id,mode,trading_account_id,observer_channel_id,read_only,revision,updated_at_utc) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE mode=VALUES(mode),trading_account_id=VALUES(trading_account_id),observer_channel_id=VALUES(observer_channel_id),read_only=VALUES(read_only),revision=VALUES(revision),updated_at_utc=VALUES(updated_at_utc)`, [next.userId, next.mode, next.accountId, next.observerChannelId, next.readOnly ? 1 : 0, revision])
      commitAttempted = true; await connection.commit()
      return { ...next, revision }
    } catch (error) {
      if (commitAttempted) {
        connection.destroy(); destroyed = true
        throw new TradingAccessError('trading_context_commit_unknown', 503)
      }
      if (started) {
        try { await connection.rollback() }
        catch {
          connection.destroy(); destroyed = true
          throw new TradingAccessError('trading_context_rollback_unknown', 503)
        }
      }
      if (error instanceof TradingAccessError) throw error
      throw new TradingAccessError('trading_context_write_failed', 503)
    } finally { if (!destroyed) connection.release() }
  }
}
