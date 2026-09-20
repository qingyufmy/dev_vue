import type { JsonObject } from '../domain/inference.js'

export interface ProposedDecisionEvidenceScope {
  decisionId: string
  decisionRevision: number
  userId: number
  accountId: string
  analysisRevision: number
}
export interface ProposedDecisionEvidence extends ProposedDecisionEvidenceScope {
  decisionHash: string
  confidence: number
  analysisId: string
  snapshotId: string
  snapshotHash: string
  symbol: string
  capturedAt: string
  market: JsonObject
}
export interface ProposedDecisionEvidenceReader {
  readPositions?(input: ProposedDecisionEvidenceScope): Promise<{ positions: unknown[]; revision: number } | null>
  /** Exact proposed decision and frozen analysis lineage, not current authorization. */
  read(input: ProposedDecisionEvidenceScope): Promise<ProposedDecisionEvidence | null>
}
