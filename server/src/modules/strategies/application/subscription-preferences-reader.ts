import type { SubscriptionExecutionPreferences } from '../domain/subscription-take-profit.js'

/** Bound to the caller's transaction; reads with its existing shared lock. */
export interface SubscriptionPreferencesReader {
  read(scope: { subscriptionId: string; userId: number; accountId: string }): Promise<SubscriptionExecutionPreferences | null>
}
