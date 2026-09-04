import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TradeHistoryScheduleRepository } from '../application/trade-history-collector-ports.js'

interface DueRow extends RowDataPacket { account_id: string }

export class MysqlTradeHistoryScheduleRepository implements TradeHistoryScheduleRepository {
  constructor(private readonly pool: Pool) {}

  async scheduleDue(limit: number, now: Date) {
    return transaction(this.pool, async connection => {
      const [rows] = await connection.execute<DueRow[]>(`SELECT CAST(a.id AS CHAR) account_id
        FROM trading_accounts a LEFT JOIN trade_history_sync_states_v4 h ON h.trading_account_id=a.id
        WHERE a.deleted_at_utc IS NULL
          AND EXISTS (SELECT 1 FROM bridge_connection_sessions s WHERE s.trading_account_id=a.id
            AND s.disconnected_at_utc IS NULL AND s.last_seen_at_utc>=DATE_SUB(?,INTERVAL 60 SECOND))
          AND (h.trading_account_id IS NULL OR h.status IN ('empty','stale')
            OR (h.status='ready' AND h.updated_at_utc<=DATE_SUB(?,INTERVAL 60 SECOND))
            OR (h.status='failed' AND h.updated_at_utc<=DATE_SUB(?,INTERVAL 30 SECOND))
            OR (h.status='syncing' AND h.updated_at_utc<=DATE_SUB(?,INTERVAL 5 MINUTE)))
          AND NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.aggregate_type='trade_history'
            AND o.aggregate_id=CAST(a.id AS CHAR) AND o.event_type='trade.history.requested' AND o.status IN ('pending','dispatching'))
        ORDER BY COALESCE(h.updated_at_utc,'1970-01-01 00:00:00'),a.id LIMIT ? FOR UPDATE SKIP LOCKED`, [now, now, now, now, limit])
      const accountIds = rows.map(row => String(row.account_id))
      for (const accountId of accountIds) {
        await connection.execute(`INSERT INTO trade_history_sync_states_v4
          (trading_account_id,status,history_revision,fresh_through_utc,last_success_at_utc,last_error_code,updated_at_utc)
          VALUES (?,'syncing',0,NULL,NULL,NULL,?) ON DUPLICATE KEY UPDATE status='syncing',last_error_code=NULL,updated_at_utc=VALUES(updated_at_utc)`, [accountId, now])
        await connection.execute(`INSERT INTO outbox_events
          (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
          VALUES (?,'trade_history',?,'trade.history.requested',?,'pending',0,?,?)`, [randomUUID(), accountId, JSON.stringify({ account_id: accountId }), now, now])
      }
      return accountIds
    })
  }
}

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) { const connection = await pool.getConnection(); try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result } catch (error) { await connection.rollback(); throw error } finally { connection.release() } }
