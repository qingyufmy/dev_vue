import type { ReadyReviewTrade } from './manual-candidate-collector.js'

export interface SystemTradeCaseInput {
  trade: ReadyReviewTrade
  source: { status: 'proven'; strategyId: string; strategyVersionId: string; proofs: Array<{
    dealTicket: string; orderTicket: string; commandId: string; intentId: string
    action: 'order.place' | 'position.close'; resultHash: string
    decisionId: string; riskDecisionId: string; strategyId: string; strategyVersionId: string
  }> }
}
export interface SystemTradeCaseWriter {
  /** Same authorized transaction as evidence capture and attribution; no external I/O. */
  create(input: SystemTradeCaseInput): Promise<{ status: 'created' | 'unchanged'; caseId: string }>
}
