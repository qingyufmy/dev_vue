import type { PartialCloseHistoryProofReader } from './partial-close-history-proof-reader.js'
import type { PartialCloseProtectionPlan, ProtectionEligibility, ProtectionProjection } from '../domain/partial-close-protection.js'

export interface PartialCloseWorkflowScope { readonly workflowId: string; readonly userId: number; readonly accountId: string }
export interface PartialCloseProgressFacts {
  readonly history: PartialCloseHistoryProofReader
  readonly projection: { read(plan: PartialCloseProtectionPlan): Promise<ProtectionProjection | null> }
}
export interface PartialCloseProgressResult {
  readonly workflowId: string
  readonly revision: number
  readonly status: 'awaiting_close' | 'risk_review_required' | 'protecting' | 'stopped' | 'expired' | 'succeeded'
  /** Qualification evidence; after preparation it remains the original assessment, not a request to review again. */
  readonly assessment: ProtectionEligibility
  readonly replayed: boolean
}
/** This only persists a request for current risk review, never a protection approval. */
export interface PartialCloseWorkflowProgress {
  advance(scope: PartialCloseWorkflowScope): Promise<PartialCloseProgressResult>
}
