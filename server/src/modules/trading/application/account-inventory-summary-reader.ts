/** Projection existence and revisions only; not a complete or fresh terminal snapshot. */
export interface AccountInventorySummary {
  positionsRevision: number; pendingOrdersRevision: number; hasPositions: boolean; hasPendingOrders: boolean
}
export interface AccountInventorySummaryReader {
  /** Locks the account row in the caller's transaction; does not authorize access. */
  lockAccount(accountId: string): Promise<void>
  read(scope: { userId: number; accountId: string; symbol: string }): Promise<AccountInventorySummary | null>
  /** Caller holds the account lock; rows must all match the separately checked collection revision. */
  readPositions?(scope: { userId: number; accountId: string }): Promise<unknown[]>
  readPendingOrders?(scope: { userId: number; accountId: string }): Promise<unknown[]>
  readRevisions(scope: { userId: number; accountId: string; symbol: string }): Promise<{
    accountRevision: number | null; quoteRevision: number | null; contractRevision: number | null;
    positionsRevision: number | null; pendingOrdersRevision: number | null
  } | null>
}
