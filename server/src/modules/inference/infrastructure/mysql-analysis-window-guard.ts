import type { Pool, RowDataPacket } from 'mysql2/promise'
import { evaluateSubscriptionWindow, type SubscriptionWindowClock } from '../../strategies/index.js'
import type { AnalysisWindowGuard } from '../application/analysis-window-guard.js'
import { InferenceError, type AnalysisRun } from '../domain/inference.js'

interface WindowRow extends RowDataPacket { receive_timezone: string; receive_window_json: unknown }

export class MysqlAnalysisWindowGuard implements AnalysisWindowGuard {
  constructor(private readonly pool: Pool,
    private readonly readClock: (accountId: string, userId: number) => Promise<SubscriptionWindowClock | null>) {}

  async assertAllowed(run: AnalysisRun, now: Date) {
    if (run.trigger !== 'scheduled') return
    if (!run.marketSourceAccountId) throw new InferenceError('analysis_schedule_unavailable', 409)
    const [rows] = await this.pool.execute<WindowRow[]>(`SELECT sc.receive_timezone,sc.receive_window_json
      FROM strategy_subscriptions s INNER JOIN subscription_schedules sc ON sc.subscription_id=s.id
      INNER JOIN trading_account_ownerships own ON own.trading_account_id=s.trading_account_id
        AND own.user_id=s.user_id AND own.role='owner' AND own.revoked_at_utc IS NULL
      WHERE s.user_id=? AND s.trading_account_id=? AND s.analysis_strategy_id=?
        AND s.analysis_strategy_version_id=? AND s.standard_symbol=? AND s.status='active' AND s.analysis_enabled=1
      ORDER BY s.id`, [run.userId, run.marketSourceAccountId, run.strategyId, run.strategyVersionId, run.symbol])
    let clock: SubscriptionWindowClock | null = null, clockRead = false
    for (const row of rows) {
      let decision = evaluateSubscriptionWindow(row.receive_window_json, row.receive_timezone, now, null)
      if (decision.reason === 'clock_unverified') {
        if (!clockRead) { clock = await this.readClock(run.marketSourceAccountId, run.userId); clockRead = true }
        decision = evaluateSubscriptionWindow(row.receive_window_json, row.receive_timezone, now, clock)
      }
      if (decision.inferenceAllowed) return
    }
    throw new InferenceError('analysis_schedule_closed', 409)
  }
}
