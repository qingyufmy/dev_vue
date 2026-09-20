import { createHash } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { historyTransaction } from './history-transaction.js'

/** Serialize candidate scans per database before they acquire account/index gap locks. */
export async function historyScheduleTransaction(pool: Pool, work: (connection: PoolConnection) => Promise<string[]>) {
  const connection = await pool.getConnection()
  let lock: string | null = null, destroyed = false, failed = false
  try {
    const [[identity]] = await connection.query<RowDataPacket[]>('SELECT DATABASE() db,@@session.time_zone timezone')
    if (typeof identity?.db !== 'string' || !identity.db || identity.timezone !== '+00:00') throw Error('history_schedule_session_invalid')
    const name = 'aurum:history-schedule:' + createHash('sha256').update(identity.db).digest('hex').slice(0, 32)
    const [[result]] = await connection.execute<RowDataPacket[]>('SELECT GET_LOCK(?,0) acquired', [name])
    if (result?.acquired !== null && Number(result?.acquired) === 0) return []
    if (Number(result?.acquired) !== 1) throw Error('history_schedule_lock_unavailable')
    lock = name
    const borrowed = new Proxy(connection, { get(target, property) {
      if (property === 'release') return () => {}
      if (property === 'destroy') return () => { destroyed = true; target.destroy() }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    return await historyTransaction({ getConnection: async () => borrowed } as Pool, work)
  } catch (error) { failed = true; throw error } finally {
    if (!destroyed && lock) {
      try {
        const [[result]] = await connection.execute<RowDataPacket[]>('SELECT RELEASE_LOCK(?) released', [lock])
        if (Number(result?.released) !== 1) throw Error('history_schedule_lock_release_failed')
      } catch {
        connection.destroy(); destroyed = true
        if (!failed) throw Error('history_schedule_lock_release_failed')
      }
    }
    if (!destroyed) connection.release()
  }
}
