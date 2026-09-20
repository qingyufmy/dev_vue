export interface SubscriptionExecutionWindowScope {
  subscriptionId: string
  userId: number
  accountId: string
  subscriptionRevision: number
  traderStrategyId: string
  traderStrategyVersionId: string
}

export interface SubscriptionExecutionWindow {
  userId: number
  accountId: string
  timezone: string
  window: unknown
}

/** Reads locked subscription facts using the caller's transaction. */
export interface SubscriptionExecutionWindowReader {
  read(scope: SubscriptionExecutionWindowScope): Promise<SubscriptionExecutionWindow | null>
}
