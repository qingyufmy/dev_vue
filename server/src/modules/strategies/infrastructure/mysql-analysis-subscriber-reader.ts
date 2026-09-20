import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AnalysisSubscriberReader } from '../application/analysis-subscriber-reader.js'

interface SubscriberRow extends RowDataPacket {
  id: string; user_id: number; trading_account_id: string; revision: number
  trader_strategy_id: string; trader_strategy_version_id: string; receive_timezone: string; receive_window_json: unknown
}
export function createAnalysisSubscriberReader(connection: Pick<PoolConnection, 'execute'>): AnalysisSubscriberReader {
  return { async list(scope) {
    const [rows] = await connection.execute<SubscriberRow[]>(`SELECT CAST(s.id AS CHAR) id,s.user_id,
      CAST(s.trading_account_id AS CHAR) trading_account_id,s.revision,CAST(s.trader_strategy_id AS CHAR) trader_strategy_id,
      CAST(tst.active_version_id AS CHAR) trader_strategy_version_id,sc.receive_timezone,sc.receive_window_json
      FROM strategy_subscriptions s INNER JOIN strategies ast ON ast.id=s.analysis_strategy_id AND ast.kind='analysis' AND ast.status='active' AND ast.deleted_at_utc IS NULL AND (ast.scope='platform' OR ast.owner_user_id=s.user_id) INNER JOIN strategies tst ON tst.id=s.trader_strategy_id AND tst.kind='trader' AND tst.status='active' AND tst.deleted_at_utc IS NULL AND (tst.scope='platform' OR tst.owner_user_id=s.user_id) INNER JOIN subscription_schedules sc ON sc.subscription_id=s.id
      INNER JOIN trading_account_ownerships own ON own.trading_account_id=s.trading_account_id AND own.user_id=s.user_id
        AND own.role='owner' AND own.revoked_at_utc IS NULL
      WHERE s.user_id=? AND ast.active_version_id=? AND s.standard_symbol=? AND s.status='active'
        AND s.analysis_enabled=1 AND s.trader_enabled=1 AND s.trader_strategy_id IS NOT NULL AND tst.active_version_id IS NOT NULL
      ORDER BY s.trading_account_id,s.id FOR SHARE`, [scope.userId, scope.analysisStrategyVersionId, scope.symbol])
    return rows.map(row => ({ id: row.id, userId: row.user_id, accountId: row.trading_account_id, revision: Number(row.revision),
      traderStrategyId: row.trader_strategy_id, traderStrategyVersionId: row.trader_strategy_version_id,
      timezone: row.receive_timezone, window: row.receive_window_json }))
  }, async readForEvaluation(scope) {
    const [rows] = await connection.execute<SubscriberRow[]>(`SELECT CAST(s.id AS CHAR) id,s.user_id,
      CAST(s.trading_account_id AS CHAR) trading_account_id,s.revision,CAST(s.trader_strategy_id AS CHAR) trader_strategy_id,
      CAST(tst.active_version_id AS CHAR) trader_strategy_version_id
      FROM strategy_subscriptions s INNER JOIN strategies ast ON ast.id=s.analysis_strategy_id AND ast.kind='analysis' AND ast.status='active' AND ast.deleted_at_utc IS NULL AND (ast.scope='platform' OR ast.owner_user_id=s.user_id) INNER JOIN strategies tst ON tst.id=s.trader_strategy_id AND tst.kind='trader' AND tst.status='active' AND tst.deleted_at_utc IS NULL AND (tst.scope='platform' OR tst.owner_user_id=s.user_id) INNER JOIN trading_account_ownerships own
        ON own.trading_account_id=s.trading_account_id AND own.user_id=s.user_id AND own.role='owner' AND own.revoked_at_utc IS NULL
      WHERE s.id=? AND s.user_id=? AND s.trading_account_id=? AND s.revision=?
        AND s.trader_strategy_id=? AND tst.active_version_id=? AND ast.active_version_id=? AND s.standard_symbol=?
        AND s.status='active' AND s.trader_enabled=1 FOR UPDATE`,
    [scope.subscriptionId, scope.userId, scope.accountId, scope.subscriptionRevision,
      scope.traderStrategyId, scope.traderStrategyVersionId, scope.analysisStrategyVersionId, scope.symbol])
    if (rows.length !== 1) return null
    const row = rows[0]!
    return { id: row.id, userId: row.user_id, accountId: row.trading_account_id, revision: Number(row.revision),
      traderStrategyId: row.trader_strategy_id, traderStrategyVersionId: row.trader_strategy_version_id }
  }, async readContextVersion(scope) {
    const [rows] = await connection.execute<(RowDataPacket & { revision: number; status: string })[]>(`SELECT s.revision,s.status
      FROM strategy_subscriptions s INNER JOIN strategies ast ON ast.id=s.analysis_strategy_id AND ast.kind='analysis' AND ast.status='active' AND ast.deleted_at_utc IS NULL AND (ast.scope='platform' OR ast.owner_user_id=s.user_id) INNER JOIN strategies tst ON tst.id=s.trader_strategy_id AND tst.kind='trader' AND tst.status='active' AND tst.deleted_at_utc IS NULL AND (tst.scope='platform' OR tst.owner_user_id=s.user_id) WHERE s.id=? AND s.user_id=? AND s.trading_account_id=?
        AND s.trader_strategy_id=? AND tst.active_version_id=? AND ast.active_version_id=? AND s.standard_symbol=? FOR SHARE`,
    [scope.subscriptionId, scope.userId, scope.accountId, scope.traderStrategyId, scope.traderStrategyVersionId, scope.analysisStrategyVersionId, scope.symbol])
    return rows.length === 1 ? { revision: Number(rows[0]!.revision), status: rows[0]!.status } : null
  } }
}
