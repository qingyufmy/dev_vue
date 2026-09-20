export interface InstrumentCollectionClaim {
  requestId: string
  userId: number
  accountId: string
  symbol: string
  leaseToken: string
}
export type InstrumentCollectionClaimResult =
  | { state: 'claimed'; claim: InstrumentCollectionClaim }
  | { state: 'terminal' }
  | { state: 'busy'; retryAt: string }
export interface InstrumentCollectionTasks {
  claim(requestId: string): Promise<InstrumentCollectionClaimResult>
  complete(claim: InstrumentCollectionClaim, resultRevision: number): Promise<boolean>
  release(claim: InstrumentCollectionClaim, errorCode: string): Promise<boolean>
}
