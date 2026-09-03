import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { AnalysisScheduleRepository, DueAnalysisSchedule } from '../application/analysis-scheduler.js'

interface DueRow extends RowDataPacket {
  subscription_id: string
  user_id: number
  trading_account_id: string
  analysis_strategy_id: string
  analysis_strategy_version_id: string
  standard_symbol: string
  cadence_seconds: number
  next_due_at_utc: Date
}

export class MysqlAnalysisScheduleRepository implements AnalysisScheduleRepository {
  constructor(private readonly pool: Pool) {}

  async listDue(now: string, limit: number) {
    const [rows] = await this.pool.execute<DueRow[]>(`SELECT CAST(s.id AS CHAR) subscription_id,s.user_id,CAST(s.trading_account_id AS CHAR) trading_account_id,CAST(s.analysis_strategy_id AS CHAR) analysis_strategy_id,CAST(s.analysis_strategy_version_id AS CHAR) analysis_strategy_version_id,s.standard_symbol,sc.cadence_seconds,sc.next_due_at_utc FROM subscription_schedules sc INNER JOIN strategy_subscriptions s ON s.id=sc.subscription_id AND s.status='active' AND s.analysis_enabled=1 INNER JOIN strategies st ON st.id=s.analysis_strategy_id AND st.status='active' AND st.active_version_id=s.analysis_strategy_version_id AND st.deleted_at_utc IS NULL INNER JOIN trading_account_ownerships own ON own.user_id=s.user_id AND own.trading_account_id=s.trading_account_id AND own.role='owner' AND own.revoked_at_utc IS NULL WHERE sc.next_due_at_utc IS NOT NULL AND sc.next_due_at_utc<=? ORDER BY sc.next_due_at_utc,s.id LIMIT ?`, [now, limit])
    return rows.map((row): DueAnalysisSchedule => ({
      subscriptionId: row.subscription_id, userId: row.user_id, marketSourceAccountId: row.trading_account_id,
      strategyId: row.analysis_strategy_id, strategyVersionId: row.analysis_strategy_version_id,
      symbol: row.standard_symbol, cadenceSeconds: Number(row.cadence_seconds), nextDueAt: row.next_due_at_utc.toISOString(),
    }))
  }

  async advance(subscriptionId: string, expectedDueAt: string, nextDueAt: string) {
    const [result] = await this.pool.execute<ResultSetHeader>('UPDATE subscription_schedules SET next_due_at_utc=?,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE subscription_id=? AND next_due_at_utc=?', [nextDueAt, subscriptionId, expectedDueAt])
    return result.affectedRows === 1
  }
}
