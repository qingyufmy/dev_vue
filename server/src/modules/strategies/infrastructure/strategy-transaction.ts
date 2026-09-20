import type { Pool, PoolConnection } from 'mysql2/promise'
import { StrategyAccessError } from '../domain/strategy.js'

export async function strategyTransaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection()
  let committing = false
  let discard = false
  try {
    await connection.beginTransaction()
    const value = await work(connection)
    committing = true
    await connection.commit()
    return value
  } catch (error) {
    if (committing) {
      // A failed acknowledgement cannot prove rollback; never replay this write.
      discard = true
      throw new StrategyAccessError('strategy_commit_unknown', 503)
    }
    try { await connection.rollback() }
    catch { discard = true }
    throw error
  } finally {
    if (discard) connection.destroy()
    else connection.release()
  }
}
