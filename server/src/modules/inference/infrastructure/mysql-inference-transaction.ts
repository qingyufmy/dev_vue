import type { Pool, PoolConnection } from 'mysql2/promise'
import { InferenceError } from '../domain/inference.js'

/** An ambiguous commit is never rolled back/replayed as if no decision or event claim existed. */
export async function inferenceTransaction<T>(pool: Pick<Pool, 'getConnection'>, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection()
  let started = false, committing = false, reusable = true
  try {
    await connection.beginTransaction(); started = true
    const result = await work(connection)
    committing = true
    await connection.commit()
    return result
  } catch (error) {
    if (committing || !started) {
      reusable = false
      throw new InferenceError(committing ? 'inference_commit_unknown' : 'inference_storage_unavailable', 503)
    }
    try { await connection.rollback() }
    catch { reusable = false; throw new InferenceError('inference_rollback_unknown', 503) }
    throw error
  } finally { if (reusable) connection.release(); else connection.destroy() }
}
