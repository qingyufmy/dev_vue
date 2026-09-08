import type { Pool, PoolConnection } from 'mysql2/promise'
import type { ObserverAccessReader } from '../application/observer-ports.js'
import { isPositiveDatabaseId, isValidUserId } from '../domain/account-access.js'
import { TradingAccessError } from '../domain/trading.js'
import { MysqlObserverAccessReader } from './mysql-observer-access-reader.js'

/** Pool-owned ordinary reads. Transactional command authorization uses authorizeOn instead. */
export class MysqlObserverSnapshotReader implements ObserverAccessReader {
  constructor(private readonly pool: Pick<Pool, 'getConnection'>, private readonly now: () => Date = () => new Date()) {}

  async list(userId: number) {
    if (!isValidUserId(userId)) return []
    return withMysqlObserverSnapshot(this.pool, connection => new MysqlObserverAccessReader(connection, this.now).list(userId))
  }

  async authorize(userId: number, channelId: string, accountId?: string) {
    if (!isValidUserId(userId) || !isPositiveDatabaseId(String(channelId))
      || (accountId !== undefined && !isPositiveDatabaseId(String(accountId)))) return null
    return withMysqlObserverSnapshot(this.pool, connection => new MysqlObserverAccessReader(connection, this.now).authorize(userId, channelId, accountId))
  }
}

export async function withMysqlObserverSnapshot<T>(pool: Pick<Pool, 'getConnection'>, read: (connection: PoolConnection) => Promise<T>): Promise<T> {
  let connection: PoolConnection | undefined, started = false, destroyed = false
  try {
    connection = await pool.getConnection()
    // Per-transaction settings; do not change the pooled connection's session isolation.
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    started = true
    return await read(connection)
  } catch (error) {
    if (connection && !started) { connection.destroy(); destroyed = true }
    if (error instanceof TradingAccessError) throw error
    throw new TradingAccessError('trading_context_invalid', 503)
  } finally {
    if (connection) {
      try { if (started) await connection.rollback() }
      catch {
        connection.destroy(); destroyed = true
        throw new TradingAccessError('trading_context_invalid', 503)
      } finally { if (!destroyed) connection.release() }
    }
  }
}
