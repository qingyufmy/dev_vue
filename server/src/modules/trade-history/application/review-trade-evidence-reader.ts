import type { TradeCostEvidence } from '../domain/trade-cost-evidence.js'
import type { ReviewTradeProjection } from '../domain/review-trade-lifecycle.js'

export interface ReviewTradeEvidence {
  recordId: string
  accountId: string
  userId: number
  ownershipIntervalId: string
  revision: number
  platform: 'mt4' | 'mt5'
  source: 'system' | 'manual'
  openedAt: string
  closedAt: string
  terminalTimezoneOffsetMinutes: number
  evidenceHash: string
  projection: ReviewTradeProjection
  facts: Array<{ id: string; ticket: string; hash: string; raw: Record<string, unknown>; costs: TradeCostEvidence }>
}
export type ReviewTradeEvidenceResult = { status: 'captured'; evidence: ReviewTradeEvidence }
  | { status: 'unresolved'; reason: 'record_unavailable' | 'revision_changed' | 'record_not_eligible' | 'facts_incomplete' | 'cost_fields_incomplete' | 'lifecycle_incomplete' }
/** Caller owns a consistent transaction. Captured facts do not certify traversal coverage or final fee settlement. */
export interface ReviewTradeEvidenceReader {
  read(input: { userId: number; recordId: string; expectedRevision: number }): Promise<ReviewTradeEvidenceResult>
}
