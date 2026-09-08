import { setTimeout as delay } from 'node:timers/promises'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { PrincipalTransactionAbortedError } from '../../auth/index.js'
import { gatewayError, translateStorageError } from './mysql-bridge-route-authorization.js'

/** Route database work only: no Redis, transport, or terminal effects inside work. */
export async function inBridgeRouteTransaction<T>(pool: Pick<Pool, 'getConnection'>, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let connection: PoolConnection | undefined
    let started = false, commitAttempted = false, destroyed = false, retry = false
    try {
      connection = await pool.getConnection()
      await connection.beginTransaction(); started = true
      const result = await work(connection)
      commitAttempted = true; await connection.commit()
      return result
    } catch (error) {
      // A broken commit acknowledgement cannot be undone or classified as a safe retry.
      // Keep the existing external error contract; discard this connection and fail closed.
      if (connection && (commitAttempted || !started)) {
        connection.destroy(); destroyed = true
        throw gatewayError('bridge_route_storage_unavailable', 503)
      }
      if (connection && started) {
        try { await connection.rollback() }
        catch {
          connection.destroy(); destroyed = true
          throw gatewayError('bridge_route_storage_unavailable', 503)
        }
        retry = error instanceof PrincipalTransactionAbortedError
          || (error instanceof Error && 'code' in error && error.code === 'ER_LOCK_DEADLOCK')
      }
      if (!retry || attempt === 2) throw translateStorageError(error)
    } finally { if (connection && !destroyed) connection.release() }
    // The entire previous transaction is gone; recheck every authorization dimension.
    await delay(10 * 2 ** attempt + Math.floor(Math.random() * 10))
  }
  throw gatewayError('bridge_route_storage_unavailable', 503)
}
