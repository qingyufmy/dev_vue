import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { IndependentTraderScheduleCandidate, IndependentTraderScheduleStore } from '../application/independent-trader-scheduler.js'

interface CandidateRow extends RowDataPacket {
  subscription_id: string
  subscription_revision: number
  user_id: number
  trading_account_id: string
  market_analysis_id: string
  trader_strategy_id: string
  trader_strategy_version_id: string
  standard_symbol: string
}

export class MysqlIndependentTraderScheduleStore implements IndependentTraderScheduleStore {
  constructor(private readonly pool: Pool) {}

  async listCandidates(limit: number, afterSubscriptionId: string): Promise<IndependentTraderScheduleCandidate[]> {
    const [rows] = await this.pool.execute<CandidateRow[]>(`SELECT CAST(s.id AS CHAR) subscription_id,s.revision subscription_revision,s.user_id,
      CAST(s.trading_account_id AS CHAR) trading_account_id,CAST(a.id AS CHAR) market_analysis_id,s.standard_symbol,
      CAST(s.trader_strategy_id AS CHAR) trader_strategy_id,CAST(ts.active_version_id AS CHAR) trader_strategy_version_id
      FROM strategy_subscriptions s
      INNER JOIN strategies ast ON ast.id=s.analysis_strategy_id AND ast.kind='analysis' AND ast.status='active'
        AND ast.deleted_at_utc IS NULL AND ast.active_version_id IS NOT NULL AND (ast.scope='platform' OR ast.owner_user_id=s.user_id)
      INNER JOIN strategy_versions av ON av.id=ast.active_version_id
        AND JSON_UNQUOTE(JSON_EXTRACT(av.config_json,'$.responsibility_mode'))='independent_roles_v2'
      INNER JOIN strategies ts ON ts.id=s.trader_strategy_id AND ts.kind='trader' AND ts.status='active'
        AND ts.deleted_at_utc IS NULL AND ts.active_version_id IS NOT NULL AND (ts.scope='platform' OR ts.owner_user_id=s.user_id)
      INNER JOIN strategy_versions tv ON tv.id=ts.active_version_id
        AND JSON_UNQUOTE(JSON_EXTRACT(tv.config_json,'$.responsibility_mode'))='independent_roles_v2'
      INNER JOIN market_analyses a ON a.id=(SELECT latest.id FROM market_analyses latest
        WHERE latest.owner_user_id=s.user_id AND latest.strategy_version_id=ast.active_version_id
          AND latest.standard_symbol=s.standard_symbol ORDER BY latest.analyzed_at_utc DESC,latest.id DESC LIMIT 1)
      INNER JOIN trading_account_ownerships own ON own.trading_account_id=s.trading_account_id AND own.user_id=s.user_id
        AND own.role='owner' AND own.revoked_at_utc IS NULL
      WHERE s.status='active' AND s.trader_enabled=1 AND s.id>?
      ORDER BY s.id LIMIT ?`, [afterSubscriptionId, String(limit)])
    return rows.map(row => ({
      subscriptionId: row.subscription_id,
      subscriptionRevision: Number(row.subscription_revision),
      userId: row.user_id,
      tradingAccountId: row.trading_account_id,
      marketAnalysisId: row.market_analysis_id,
      strategyId: row.trader_strategy_id,
      strategyVersionId: row.trader_strategy_version_id,
      symbol: row.standard_symbol,
    }))
  }
}
