import type { Pool, PoolConnection } from 'mysql2/promise'
import { BridgeCommandError } from '../domain/bridge-command.js'

/** A missing COMMIT acknowledgement is not evidence that command preparation or dispatch rolled back. */
export async function bridgeCommandTransaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection()
  let committing = false, discard = false
  try {
    await connection.beginTransaction()
    const value = await work(connection)
    committing = true
    await connection.commit()
    return value
  } catch (error) {
    if (committing) {
      discard = true
      throw new BridgeCommandError('bridge_command_commit_unknown', 503)
    }
    try { await connection.rollback() }
    catch { discard = true }
    throw error
  } finally {
    if (discard) connection.destroy()
    else connection.release()
  }
}
