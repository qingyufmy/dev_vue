import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TradeDecisionOriginReader } from '../application/trade-decision-origin-reader.js'

interface OriginRow extends RowDataPacket {
  decision_id: string
  user_id: number
  account_id: string
  strategy_id: string
  strategy_version_id: string
}

/** Reads only inference-owned facts and retains locks on the caller's transaction. */
export function createMysqlTradeDecisionOriginReader(connection: Pick<PoolConnection, 'execute'>): TradeDecisionOriginReader {
  return originReader(connection, 'locked')
}

/** Caller must hold a consistent snapshot; this does not lock current execution state. */
export function createMysqlSnapshotTradeDecisionOriginReader(connection: Pick<PoolConnection, 'execute'>): TradeDecisionOriginReader {
  return originReader(connection, 'snapshot')
}

function originReader(connection: Pick<PoolConnection, 'execute'>, mode: 'locked' | 'snapshot'): TradeDecisionOriginReader {
  return {
    async read(input) {
      const scope = { ...input }
      const [rows] = await connection.execute<OriginRow[]>(`SELECT d.id decision_id,d.user_id,
        CAST(d.trading_account_id AS CHAR) account_id,CAST(d.strategy_id AS CHAR) strategy_id,
        CAST(d.strategy_version_id AS CHAR) strategy_version_id
        FROM trade_decisions d INNER JOIN ai_trader_runs r
          ON r.id=d.trader_run_id AND r.user_id=d.user_id AND r.trading_account_id=d.trading_account_id
          AND r.strategy_id=d.strategy_id AND r.strategy_version_id=d.strategy_version_id
          AND r.market_analysis_id=d.market_analysis_id AND r.input_snapshot_id=d.input_snapshot_id
        WHERE d.id=? AND d.risk_decision_id=? AND d.user_id=? AND d.trading_account_id=?
          AND d.status='accepted' AND r.status='succeeded'
        LIMIT 2${mode === 'locked' ? ' FOR SHARE' : ''}`, [scope.decisionId, scope.riskDecisionId, scope.userId, scope.accountId])
      if (rows.length !== 1) return null
      const row = rows[0]!
      if (row.decision_id !== scope.decisionId || Number(row.user_id) !== scope.userId || row.account_id !== scope.accountId
        || !/^[1-9]\d{0,19}$/.test(row.strategy_id) || !/^[1-9]\d{0,19}$/.test(row.strategy_version_id)) return null
      return { decisionId: row.decision_id, userId: scope.userId, accountId: row.account_id,
        strategyId: row.strategy_id, strategyVersionId: row.strategy_version_id }
    },
  }
}
