import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ManualCandidatePageProcessor, ManualCandidateTaskRunner } from '../application/manual-candidate-task.js'
import { reviewTransaction } from './review-transaction.js'
import { reviewIsoTime } from './review-sql-time.js'

interface TaskRow extends RowDataPacket {
  status: 'pending' | 'waiting' | 'succeeded'; after_record_id: string | null; due: number
  retry_at: string
}
export function createMysqlManualCandidateTask(pool: Pool,
  processor: (connection: PoolConnection) => ManualCandidatePageProcessor): ManualCandidateTaskRunner {
  return { async run(taskId) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(taskId)) throw Error('manual_candidate_task_id_invalid')
    return reviewTransaction(pool, async connection => {
      await connection.execute(`INSERT INTO manual_candidate_tasks_v4
        (history_task_id,status,next_attempt_at_utc,created_at_utc,updated_at_utc)
        VALUES (?,'pending',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE history_task_id=history_task_id`, [taskId])
      const [[row]] = await connection.execute<TaskRow[]>(`SELECT status,after_record_id,
        next_attempt_at_utc<=UTC_TIMESTAMP(3) due,DATE_FORMAT(next_attempt_at_utc,'%Y-%m-%d %H:%i:%s.%f') retry_at
        FROM manual_candidate_tasks_v4 WHERE history_task_id=? FOR UPDATE`, [taskId])
      if (!row) throw Error('manual_candidate_task_missing')
      if (row.status === 'succeeded') return { state: 'succeeded', retryAt: null }
      if (!Number(row.due)) return { state: row.status, retryAt: reviewIsoTime(row.retry_at.replace(/(\.\d{3})000$/, '$1')) }
      const result = await processor(connection).run(taskId,row.after_record_id)
      const waiting = result.status === 'unresolved' || result.results.some(record => record.result.status === 'unresolved')
      const cursor = result.status === 'processed' && !waiting ? result.nextRecordId : row.after_record_id
      const state = waiting ? 'waiting' : cursor === null ? 'succeeded' : 'pending'
      await connection.execute(`UPDATE manual_candidate_tasks_v4 SET status=?,after_record_id=?,page_attempts=page_attempts+1,
        last_results_json=?,next_attempt_at_utc=UTC_TIMESTAMP(3)+INTERVAL ? SECOND,
        completed_at_utc=IF(?='succeeded',UTC_TIMESTAMP(3),NULL),updated_at_utc=UTC_TIMESTAMP(3) WHERE history_task_id=?`,
      [state,cursor,JSON.stringify(result),waiting ? 60 : 0,state,taskId])
      const [[updated]] = await connection.execute<(RowDataPacket & { retry_at: string })[]>(
        "SELECT DATE_FORMAT(next_attempt_at_utc,'%Y-%m-%d %H:%i:%s.%f') retry_at FROM manual_candidate_tasks_v4 WHERE history_task_id=?", [taskId])
      return { state, retryAt: state === 'succeeded' ? null : reviewIsoTime(updated!.retry_at.replace(/(\.\d{3})000$/, '$1')) }
    })
  } }
}
