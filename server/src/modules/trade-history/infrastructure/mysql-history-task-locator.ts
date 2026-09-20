import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { HistoryTaskLocator } from '../application/history-task-worker.js'

export class MysqlHistoryTaskLocator implements HistoryTaskLocator {
  constructor(private readonly pool: Pool) {}

  async find(taskId: string) {
    const [rows] = await this.pool.execute<(RowDataPacket & { account_id: string; status: string })[]>(
      'SELECT CAST(trading_account_id AS CHAR) account_id,status FROM history_collection_tasks_v4 WHERE id=? LIMIT 2', [taskId])
    if (rows.length === 0) return null
    const row = rows[0]!
    if (rows.length !== 1 || !/^[1-9]\d{0,19}$/.test(row.account_id) || BigInt(row.account_id) > 18446744073709551615n
      || !['pending', 'running', 'completing', 'succeeded', 'failed'].includes(row.status)) throw Error('history_task_record_corrupt')
    return { accountId: row.account_id, status: row.status as NonNullable<Awaited<ReturnType<HistoryTaskLocator['find']>>>['status'] }
  }
}
