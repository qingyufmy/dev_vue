import type { Pool, PoolConnection } from 'mysql2/promise'
import { RiskError } from '../domain/risk.js'

/** No retries: a missing commit acknowledgement may represent a committed write. */
export async function inRiskTransaction<T>(pool: Pick<Pool, 'getConnection'>, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  let connection: PoolConnection | undefined
  let started = false, commitAttempted = false, destroyed = false
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction(); started = true
    const result = await work(connection)
    commitAttempted = true
    await connection.commit()
    return result
  } catch (error) {
    if (connection && (commitAttempted || !started)) {
      destroyed = true; connection.destroy()
      throw new RiskError(commitAttempted ? 'risk_commit_unknown' : 'risk_storage_unavailable', 503)
    }
    if (connection && started) {
      try { await connection.rollback() }
      catch { destroyed = true; connection.destroy(); throw new RiskError('risk_rollback_unknown', 503) }
    }
    if (error instanceof RiskError) throw error
    throw new RiskError('risk_storage_unavailable', 503)
  } finally { if (connection && !destroyed) connection.release() }
}
