export interface OwnedHistoryScope {
  userId: number; accountId: string; platform: 'mt4' | 'mt5'; ownershipIntervalId: string
  openedAt: string; closedAt: string
}
export interface OwnedHistoryAccess {
  userId: number; accountId: string; platform: 'mt4' | 'mt5'
  currentOwnershipRevision: string; currentOwnershipIntervalId: string; historicalOwnershipIntervalId: string
}
/** Current account authorization plus the exact historical owner, within the caller's transaction. */
export interface OwnedHistoryAccessReader {
  read(scope: OwnedHistoryScope): Promise<OwnedHistoryAccess | null>
}
