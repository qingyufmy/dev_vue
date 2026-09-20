import type { Pool, PoolConnection } from 'mysql2/promise'
import { ReviewError } from '../domain/review.js'

export async function reviewTransaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  let committing = false
  let destroyed = false
  try {
    await connection.beginTransaction()
    const result = await work(connection)
    committing = true
    await connection.commit()
    return result
  } catch (error) {
    if (committing) {
      destroyed = true
      connection.destroy()
      throw new ReviewError('review_commit_unknown', 503)
    }
    try { await connection.rollback() } catch {
      destroyed = true
      connection.destroy()
    }
    throw error
  } finally {
    if (!destroyed) connection.release()
  }
}
