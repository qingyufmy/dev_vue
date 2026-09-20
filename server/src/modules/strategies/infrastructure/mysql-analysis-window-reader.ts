import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AnalysisWindowReader } from '../application/analysis-window-reader.js'

export function createAnalysisWindowReader(connection: Pick<PoolConnection, 'execute'>): AnalysisWindowReader {
  return { async list(scope) {
    const [rows] = await connection.execute<(RowDataPacket & { receive_timezone: string; receive_window_json: unknown })[]>(
      `SELECT sc.receive_timezone,sc.receive_window_json
      FROM strategy_subscriptions s INNER JOIN strategies ast ON ast.id=s.analysis_strategy_id AND ast.kind='analysis' AND ast.status='active' AND ast.deleted_at_utc IS NULL AND (ast.scope='platform' OR ast.owner_user_id=s.user_id) INNER JOIN subscription_schedules sc ON sc.subscription_id=s.id
      INNER JOIN trading_account_ownerships own ON own.trading_account_id=s.trading_account_id
        AND own.user_id=s.user_id AND own.role='owner' AND own.revoked_at_utc IS NULL
      WHERE s.user_id=? AND s.trading_account_id=? AND s.analysis_strategy_id=?
        AND ast.active_version_id=? AND s.standard_symbol=? AND s.status='active' AND s.analysis_enabled=1
      ORDER BY s.id`, [scope.userId, scope.accountId, scope.strategyId, scope.strategyVersionId, scope.symbol])
    return rows.map(row => ({ timezone: row.receive_timezone, window: row.receive_window_json }))
  } }
}
