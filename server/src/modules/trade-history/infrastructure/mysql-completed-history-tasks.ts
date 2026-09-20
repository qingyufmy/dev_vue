import type { Pool, RowDataPacket } from 'mysql2/promise'

/** Bounded discovery only; consumers must revalidate task evidence and ownership. */
export function createMysqlCompletedHistoryTasks(pool: Pick<Pool, 'execute'>) {
  return { async list(afterId: string | null, limit: number): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('history_completed_limit_invalid')
    const [rows] = await pool.execute<(RowDataPacket & { id: string })[]>(
      `SELECT id FROM history_collection_tasks_v4 WHERE status='succeeded' AND id>? ORDER BY id LIMIT ${limit}`, [afterId ?? ''])
    return rows.map(row => row.id)
  } }
}
