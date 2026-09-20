import type { Pool, PoolConnection } from 'mysql2/promise'
import { buildAccountRiskSummary, RiskError } from '../domain/risk.js'
import type { DailyRiskFacts } from '../domain/daily-risk-metrics.js'
import { projectDailyRiskBaseline } from './mysql-daily-risk-baseline.js'
import { saveRiskSummaryOnConnection } from './mysql-risk-repository.js'
import { inRiskTransaction } from './mysql-risk-transaction.js'

type SummaryInput = Parameters<typeof buildAccountRiskSummary>[0]
export interface VerifiedAccountRiskSource {
  facts: DailyRiskFacts
  summary: Omit<SummaryInput, 'dailyLossPercent' | 'drawdownPercent'>
  expectedBaselineRevision: number | null
  expectedSummaryRevision: number | null
}
/** Capture must verify history coverage, ownership, revisions and decimal costs inside this transaction. */
export type CaptureAccountRiskSource = (connection: PoolConnection, scope: { userId: number; accountId: string }) => Promise<VerifiedAccountRiskSource | null>
export function createMysqlAccountRiskProjector(pool: Pick<Pool, 'getConnection'>, capture: CaptureAccountRiskSource) {
  return { project(scope: { userId: number; accountId: string }) {
    return inRiskTransaction(pool, async connection => {
      await connection.execute('SELECT id FROM trading_accounts WHERE id=? AND deleted_at_utc IS NULL FOR UPDATE', [scope.accountId])
      const source = await capture(connection, scope)
      if (!source) throw new RiskError('risk_summary_source_unavailable', 409)
      const { facts, summary } = source
      if (facts.accountId !== scope.accountId || summary.accountId !== scope.accountId || summary.userId !== scope.userId
        || facts.businessDate !== summary.businessDate || facts.observedAt !== summary.observedAt
        || facts.equity !== summary.equity || !facts.historyComplete || !summary.dataComplete
        || summary.clockStatus !== 'calibrated' || summary.terminalTimezoneOffsetMinutes === null) {
        throw new RiskError('risk_summary_source_invalid', 409)
      }
      const metrics = await projectDailyRiskBaseline(connection, scope.userId, facts, source.expectedBaselineRevision)
      // A duplicate baseline may still need a new summary because inventory or permissions changed.
      return saveRiskSummaryOnConnection(connection, { expectedRevision: source.expectedSummaryRevision,
        summary: buildAccountRiskSummary({ ...summary, dailyLossPercent: metrics.dailyLossPercent, drawdownPercent: metrics.drawdownPercent }) })
    })
  } }
}
