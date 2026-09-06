import type { PoolConnection } from 'mysql2/promise'
import { evaluateSubscriptionWindow } from '../../strategies/index.js'
import { readTransactionAccountClock } from '../../trading/index.js'

export async function traderWindowAllows(connection: PoolConnection, subscription: {
  user_id: number; trading_account_id: string; receive_timezone: string; receive_window_json: unknown
}, now: Date) {
  let decision = evaluateSubscriptionWindow(subscription.receive_window_json, subscription.receive_timezone, now, null)
  if (decision.reason === 'clock_unverified') decision = evaluateSubscriptionWindow(subscription.receive_window_json,
    subscription.receive_timezone, now, await readTransactionAccountClock(connection, subscription.user_id, subscription.trading_account_id))
  // signals_only is market analysis, not account action generation.
  return decision.executionAllowed
}
