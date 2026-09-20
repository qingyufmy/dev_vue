import { settleEntryEvents } from './mysql-entry-event-claims.js'
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise'
import type { TradeDecisionRiskWriter } from '../application/trade-decision-risk-writer.js'

export function createMysqlTradeDecisionRiskWriter(connection: Pick<PoolConnection, 'execute'>): TradeDecisionRiskWriter {
  return {
    async recordRiskReview(input) {
      const [result] = await connection.execute<ResultSetHeader>(`UPDATE trade_decisions
        SET risk_decision_id=?,status=?,revision=revision+1
        WHERE id=? AND user_id=? AND trading_account_id=? AND revision=?
          AND status='proposed' AND risk_decision_id IS NULL`, [
        input.riskDecisionId, input.outcome === 'approved' ? 'accepted' : 'risk_rejected',
        input.decisionId, input.userId, input.accountId, input.expectedRevision,
      ])
      if (result.affectedRows !== 1) return false
      await settleEntryEvents(connection, input)
      return true
    },
  }
}
