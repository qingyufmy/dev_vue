/** Bound to the caller's existing transaction; never commits independently. */
export interface TradeDecisionRiskWriter {
  recordRiskReview(input: {
    decisionId: string
    userId: number
    accountId: string
    expectedRevision: number
    riskDecisionId: string
    outcome: 'approved' | 'rejected'
  }): Promise<boolean>
}
