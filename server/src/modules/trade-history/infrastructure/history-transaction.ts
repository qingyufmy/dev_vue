import type { Pool, PoolConnection } from 'mysql2/promise'
import { HistoryCommitUnknown } from '../application/history-commit-unknown.js'

export async function historyTransaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  let committing = false, discard = false
  try {
    await connection.beginTransaction()
    const result = await work(connection)
    committing = true
    await connection.commit()
    return result
  } catch (error) {
    if (committing) {
      discard = true
      throw new HistoryCommitUnknown()
    }
    try { await connection.rollback() } catch { discard = true }
    throw error
  } finally {
    if (discard) connection.destroy()
    else connection.release()
  }
}
