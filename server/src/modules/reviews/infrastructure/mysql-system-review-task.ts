import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { SystemReviewPageProcessor, SystemReviewTaskRunner } from '../application/system-review-task.js'
import { reviewTransaction } from './review-transaction.js'
import { reviewIsoTime } from './review-sql-time.js'

export function createMysqlSystemReviewTask(pool: Pool,
  processor: (connection: PoolConnection) => SystemReviewPageProcessor): SystemReviewTaskRunner {
  return { async run(taskId) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(taskId)) throw Error('system_review_task_id_invalid')
    return reviewTransaction(pool, async connection => {
      await connection.execute(`INSERT INTO system_review_tasks_v4
        (history_task_id,status,next_attempt_at_utc,created_at_utc,updated_at_utc)
        VALUES (?,'pending',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE history_task_id=history_task_id`, [taskId])
      const [[row]] = await connection.execute<RowDataPacket[]>(`SELECT status,after_record_id,unresolved_count,
        next_attempt_at_utc<=UTC_TIMESTAMP(3) due,DATE_FORMAT(next_attempt_at_utc,'%Y-%m-%d %H:%i:%s.%f') retry_at
        FROM system_review_tasks_v4 WHERE history_task_id=? FOR UPDATE`, [taskId])
      if (!row) throw Error('system_review_task_missing')
      if (row.status === 'succeeded') return { state: 'succeeded', retryAt: null }
      if (!Number(row.due)) return { state: row.status, retryAt: reviewIsoTime(row.retry_at.replace(/(\.\d{3})000$/, '$1')) }
      const result = await processor(connection).run(taskId,row.after_record_id)
      // Advance past unresolved trades so one unsupported EA/SL/TP record cannot starve later pages.
      const unresolved = result.status === 'processed'
        ? (row.after_record_id === null ? 0 : Number(row.unresolved_count)) + result.results.filter(r => r.result.status === 'unresolved').length
        : Number(row.unresolved_count)
      const cursor = result.status === 'processed' ? result.nextRecordId : row.after_record_id
      const state = result.status === 'unresolved' ? 'waiting' : cursor !== null ? 'pending' : unresolved ? 'waiting' : 'succeeded'
      await connection.execute(`UPDATE system_review_tasks_v4 SET status=?,after_record_id=?,unresolved_count=?,page_attempts=page_attempts+1,
        last_results_json=?,next_attempt_at_utc=UTC_TIMESTAMP(3)+INTERVAL ? SECOND,
        completed_at_utc=IF(?='succeeded',UTC_TIMESTAMP(3),NULL),updated_at_utc=UTC_TIMESTAMP(3) WHERE history_task_id=?`,
      [state,cursor,unresolved,JSON.stringify(result),state === 'waiting' ? 60 : 0,state,taskId])
      const [[updated]] = await connection.execute<RowDataPacket[]>(
        "SELECT DATE_FORMAT(next_attempt_at_utc,'%Y-%m-%d %H:%i:%s.%f') retry_at FROM system_review_tasks_v4 WHERE history_task_id=?", [taskId])
      return { state, retryAt: state === 'succeeded' ? null : reviewIsoTime(updated!.retry_at.replace(/(\.\d{3})000$/, '$1')) }
    })
  } }
}
