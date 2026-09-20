import type { Pool, RowDataPacket } from 'mysql2/promise'

/** Checks the task projection and parent link alongside the full upgrade registry. Never creates tables. */
export async function assertMysqlSystemReviewTaskSchemaReady(pool: Pick<Pool, 'execute'>) {
  await pool.execute(`SELECT history_task_id,status,after_record_id,unresolved_count,page_attempts,last_results_json,
    next_attempt_at_utc,completed_at_utc,created_at_utc,updated_at_utc FROM system_review_tasks_v4 LIMIT 0`)
  const [keys] = await pool.execute<RowDataPacket[]>(`SELECT CONSTRAINT_NAME,REFERENCED_TABLE_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='system_review_tasks_v4'`)
  if (keys.length !== 1 || keys[0]!.REFERENCED_TABLE_NAME !== 'history_collection_tasks_v4') throw Error('system_review_task_schema_not_ready')
}
