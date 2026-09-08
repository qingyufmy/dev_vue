import { evaluateSubscriptionWindow } from '../../strategies/index.js'
import type { AccountClockReader } from '../../trading/index.js'

export async function traderWindowAllows(clock: AccountClockReader, subscription: {
  user_id: number; trading_account_id: string; receive_timezone: string; receive_window_json: unknown
}, now: Date) {
  let decision = evaluateSubscriptionWindow(subscription.receive_window_json, subscription.receive_timezone, now, null)
  if (decision.reason === 'clock_unverified') decision = evaluateSubscriptionWindow(subscription.receive_window_json,
    subscription.receive_timezone, now, await clock.read(subscription.user_id, subscription.trading_account_id))
  // signals_only is market analysis, not account action generation.
  return decision.executionAllowed
}
