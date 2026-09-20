export interface TradeDecisionOrigin {
  decisionId: string
  userId: number
  accountId: string
  strategyId: string
  strategyVersionId: string
}

export interface TradeDecisionOriginReader {
  /** Historical execution provenance, not current strategy or account authorization. */
  read(input: { decisionId: string; riskDecisionId: string; userId: number; accountId: string }): Promise<TradeDecisionOrigin | null>
}
