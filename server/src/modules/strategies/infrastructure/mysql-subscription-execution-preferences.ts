import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { StrategyAccessError } from '../domain/strategy.js'
import type { SubscriptionExecutionPreferences, SubscriptionTakeProfitMode } from '../domain/subscription-take-profit.js'

// The caller owns the subscription creation transaction. No upsert: a duplicate
// indicates conflicting initialization and must roll back, not overwrite evidence.
export async function initializeSubscriptionExecutionPreferences(connection: PoolConnection, subscriptionId: string) {
  await connection.execute(`INSERT INTO subscription_execution_preferences_v4
    (subscription_id,contract_version,take_profit_mode,revision,created_at_utc,updated_at_utc)
    VALUES (?,1,'ai_recommended',1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [subscriptionId])
}

export async function readSubscriptionExecutionPreferences(connection: PoolConnection, scope: { subscriptionId: string; userId: number; accountId: string }): Promise<SubscriptionExecutionPreferences | null> {
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT p.contract_version,p.take_profit_mode,CAST(p.revision AS CHAR) revision
    FROM subscription_execution_preferences_v4 p
    JOIN strategy_subscriptions s ON s.id=p.subscription_id
    WHERE p.subscription_id=? AND s.user_id=? AND s.trading_account_id=? FOR SHARE`, [scope.subscriptionId, scope.userId, scope.accountId])
  if (!rows.length) return null
  const row = rows[0]!
  if (rows.length !== 1 || Number(row.contract_version) !== 1
    || !['ai_recommended', 'conservative', 'standard', 'trend'].includes(row.take_profit_mode)
    || typeof row.revision !== 'string' || !/^[1-9]\d*$/.test(row.revision)) {
    throw new StrategyAccessError('subscription_execution_preferences_invalid', 409)
  }
  return { contractVersion: 1, takeProfitMode: row.take_profit_mode as SubscriptionTakeProfitMode, revision: row.revision }
}
