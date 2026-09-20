export interface PendingOrderOriginScope {
  userId: number
  accountId: string
  terminalInstanceId: string
  brokerServer: string
  login: string
  connectionEpoch: string
  tickets: readonly string[]
}

/** Exact accepted creation decision; absent for manual distribution or older providers. */
export interface OrderCreationDecisionOrigin {
  decisionId: string
  riskDecisionId: string
  strategyVersionId: string
}

export type PendingOrderOrigin =
  | { ticket: string; status: 'strategy'; userId: number; accountId: string; strategyId: string; decisionOrigin?: OrderCreationDecisionOrigin }
  | { ticket: string; status: 'unresolved' }

/**
 * Historical creation provenance for an already scoped current inventory.
 * Missing proof is unresolved, not manual, unowned or a confirmed empty portfolio.
 * The caller owns current authorization, source selection, collection completeness
 * and the transaction. This port does not establish later lifecycle attribution.
 */
export interface PendingOrderOriginReader {
  read(scope: PendingOrderOriginScope): Promise<PendingOrderOrigin[]>
}
