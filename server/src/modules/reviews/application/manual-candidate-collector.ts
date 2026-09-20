/** Consumer-owned evidence contract; bootstrap adapts trade-history without a module dependency cycle. */
export interface ReadyReviewTrade {
  status: 'ready_as_of'; asOfUtcMsc: number; taskId: string; receiptId: string; completionHash: string
  evidence: {
    source: 'manual' | 'system'; recordId: string; revision: number; userId: number; accountId: string
    ownershipIntervalId: string; platform: 'mt4' | 'mt5'; evidenceHash: string
    openedAt: string; closedAt: string; terminalTimezoneOffsetMinutes: number; facts: unknown[]
    projection: { stableKey: string; primaryTicket: string; positionId: string | null; symbol: string
      side: 'buy' | 'sell'; volumeOpened: string; netProfit: string }
  }
}
export interface ManualCandidateTradeReader<Scope> {
  read(input: Scope): Promise<ReadyReviewTrade | { status: 'unresolved'; reason: string }>
}
/** Current and historical ownership are verified in the same transaction; offsets are display metadata. */
export interface ManualCandidateAuthority {
  verify(trade: ReadyReviewTrade): Promise<{ status: 'verified'; evidence: Record<string, unknown> }
    | { status: 'unresolved'; reason: string }>
}
export interface ManualCandidateWriter {
  write(input: { trade: ReadyReviewTrade; authority: Record<string, unknown> }): Promise<{
    status: 'created' | 'updated' | 'unchanged' | 'already_reviewed'; candidateId: string; revision: number
  }>
}

/** Transaction owner supplies all three ports; no network work is permitted inside them. */
export class ManualCandidateCollector<Scope> {
  constructor(private readonly trades: ManualCandidateTradeReader<Scope>,
    private readonly authority: ManualCandidateAuthority, private readonly writer: ManualCandidateWriter) {}

  async collect(input: Scope) {
    const trade = await this.trades.read(structuredClone(input))
    if (trade.status !== 'ready_as_of') return trade
    if (trade.evidence.source !== 'manual') return { status: 'unresolved' as const, reason: 'source_not_manual' }
    const authorized = await this.authority.verify(structuredClone(trade))
    if (authorized.status !== 'verified') return authorized
    return this.writer.write({ trade, authority: structuredClone(authorized.evidence) })
  }
}
