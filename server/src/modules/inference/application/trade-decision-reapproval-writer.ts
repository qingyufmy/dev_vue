/** Caller holds the account lock and proves no execution exists, in the same transaction. */
export interface TradeDecisionReapprovalWriter {
  request(input: { userId: number; accountId: string; decisionId: string; riskDecisionId: string }): Promise<boolean>
}
