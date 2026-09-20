import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AccountInventorySummaryReader } from '../../trading/index.js'
import { registerHistoryCollectionTask } from './mysql-history-task-registration.js'
import { historyScheduleTransaction as transaction } from './history-schedule-transaction.js'
import type { TradeHistoryScheduleRepository } from '../application/trade-history-collector-ports.js'

interface DueRow extends RowDataPacket { account_id: string; fresh_msc: string | null }

export class MysqlTradeHistoryScheduleRepository implements TradeHistoryScheduleRepository {
  constructor(private readonly pool: Pool, private readonly accounts: (connection: PoolConnection) => Pick<AccountInventorySummaryReader, 'lockAccount'>) {}

  async scheduleDue(limit: number, now: Date) {
    now = new Date(now.getTime())
    return transaction(this.pool, async connection => {
      const [rows] = await connection.execute<DueRow[]>(`SELECT CAST(a.id AS CHAR) account_id,CAST(UNIX_TIMESTAMP(h.fresh_through_utc)*1000 AS CHAR) fresh_msc
        FROM trading_accounts a LEFT JOIN trade_history_sync_states_v4 h ON h.trading_account_id=a.id
        WHERE a.deleted_at_utc IS NULL
          AND EXISTS (SELECT 1 FROM bridge_connection_sessions s WHERE s.trading_account_id=a.id
            AND s.disconnected_at_utc IS NULL AND s.last_seen_at_utc>=DATE_SUB(?,INTERVAL 60 SECOND))
          AND (h.trading_account_id IS NULL OR h.status IN ('empty','stale')
            OR (h.status='ready' AND h.updated_at_utc<=DATE_SUB(?,INTERVAL 60 SECOND))
            OR (h.status='failed' AND h.updated_at_utc<=DATE_SUB(?,INTERVAL 30 SECOND))
            OR (h.status='syncing' AND h.updated_at_utc<=DATE_SUB(?,INTERVAL 5 MINUTE)))
          AND NOT EXISTS (SELECT 1 FROM history_collection_tasks_v4 t WHERE t.active_account_id=a.id)
        ORDER BY COALESCE(h.updated_at_utc,'1970-01-01 00:00:00'),a.id LIMIT ? FOR UPDATE SKIP LOCKED`, [now, now, now, now, limit])
      const accountIds = rows.map(row => String(row.account_id))
      for (const row of rows) {
        const end = now.getTime()
        const prior = row.fresh_msc === null ? null : Number(row.fresh_msc)
        if (prior !== null && (!Number.isSafeInteger(prior) || prior > end)) throw Error('history_task_window_invalid')
        const start = Math.max(Date.UTC(2000, 0, 1), prior === null ? Date.UTC(2000, 0, 1) : prior - 86400000)
        await registerHistoryCollectionTask(connection, this.accounts(connection), {
          taskId: randomUUID(), accountId: String(row.account_id), rangeStartUtcMsc: start, rangeEndUtcMsc: end,
        }, now)
      }
      return accountIds
    })
  }
}
