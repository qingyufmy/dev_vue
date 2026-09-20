import type { Pool, RowDataPacket } from 'mysql2/promise'

export function createMysqlManualCandidateDue(pool: Pick<Pool, 'execute'>) {
  return { async filter(taskIds: string[]): Promise<string[]> {
    if (taskIds.length === 0) return []
    if (taskIds.length > 100 || taskIds.some(id => !/^[0-9a-f-]{36}$/i.test(id))) throw Error('manual_candidate_task_ids_invalid')
    const [rows] = await pool.execute<(RowDataPacket & { history_task_id: string })[]>(
      `SELECT history_task_id FROM manual_candidate_tasks_v4 WHERE history_task_id IN (${taskIds.map(() => '?').join(',')})
       AND (status='succeeded' OR next_attempt_at_utc>UTC_TIMESTAMP(3))`, taskIds)
    const excluded = new Set(rows.map(row => row.history_task_id))
    return taskIds.filter(id => !excluded.has(id))
  } }
}
