import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { HistoryTaskRecovery } from '../application/history-task-recovery.js'
import { historyTransaction } from './history-transaction.js'

export class MysqlHistoryTaskRecovery implements HistoryTaskRecovery {
  constructor(private readonly pool: Pool) {}

  async schedule(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Error('history_task_recovery_limit_invalid')
    return historyTransaction(this.pool, async connection => {
      const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT t.id FROM history_collection_tasks_v4 t
        WHERE (t.status='pending' OR (t.status IN ('running','completing') AND t.lease_expires_at_utc<=UTC_TIMESTAMP(3)))
          AND t.updated_at_utc<=UTC_TIMESTAMP(3)-INTERVAL 3 MINUTE
          AND NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.aggregate_type='trade_history_task'
            AND o.aggregate_id=t.id AND o.event_type='trade.history.task.requested' AND o.status IN ('pending','dispatching'))
        ORDER BY t.status,t.lease_expires_at_utc,t.id LIMIT ? FOR UPDATE SKIP LOCKED`, [limit])
      for (const row of rows) {
        // New transport delivery identity, same durable business task and fixed window.
        const [event] = await connection.execute<ResultSetHeader>(`INSERT INTO outbox_events
          (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
          VALUES (?,'trade_history_task',?,'trade.history.task.requested',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
        [randomUUID(), row.id, JSON.stringify({ task_id: row.id })])
        if (event.affectedRows !== 1) throw Error('history_task_recovery_unconfirmed')
        const [updated] = await connection.execute<ResultSetHeader>(
          'UPDATE history_collection_tasks_v4 SET updated_at_utc=UTC_TIMESTAMP(3) WHERE id=?', [row.id])
        if (updated.affectedRows !== 1) throw Error('history_task_recovery_unconfirmed')
      }
      return rows.length
    })
  }
}
