import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { SubscriptionExecutionWindowReader } from '../application/subscription-execution-window-reader.js'

interface WindowRow extends RowDataPacket {
  user_id: number; trading_account_id: string; receive_timezone: string; receive_window_json: unknown
}

export function createSubscriptionExecutionWindowReader(connection: Pick<PoolConnection, 'execute'>): SubscriptionExecutionWindowReader {
  return { async read(scope) {
    const [rows] = await connection.execute<WindowRow[]>(`SELECT s.user_id,CAST(s.trading_account_id AS CHAR) trading_account_id,sc.receive_timezone,sc.receive_window_json
        FROM strategy_subscriptions s INNER JOIN strategies tst ON tst.id=s.trader_strategy_id AND tst.kind='trader' AND tst.status='active' AND tst.deleted_at_utc IS NULL AND (tst.scope='platform' OR tst.owner_user_id=s.user_id) INNER JOIN subscription_schedules sc ON sc.subscription_id=s.id
        INNER JOIN trading_account_ownerships own ON own.trading_account_id=s.trading_account_id AND own.user_id=s.user_id
          AND own.role='owner' AND own.revoked_at_utc IS NULL
        WHERE s.id=? AND s.user_id=? AND s.trading_account_id=? AND s.revision=? AND s.status='active'
          AND s.trader_enabled=1 AND s.trader_strategy_id=? AND tst.active_version_id=? FOR SHARE`,
    [scope.subscriptionId, scope.userId, scope.accountId, scope.subscriptionRevision, scope.traderStrategyId, scope.traderStrategyVersionId])
    if (rows.length !== 1) return null
    const row = rows[0]!
    return { userId: row.user_id, accountId: row.trading_account_id, timezone: row.receive_timezone, window: row.receive_window_json }
  } }
}
