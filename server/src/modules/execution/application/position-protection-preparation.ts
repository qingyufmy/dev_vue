import type { PartialCloseWorkflowScope } from './partial-close-workflow-progress.js'
import type { PositionProtectionRequest, PositionProtectionReview } from '../domain/position-protection-child.js'

export interface PositionProtectionReviewPort {
  review(request: PositionProtectionRequest): Promise<PositionProtectionReview>
}
export interface PositionProtectionPreparationResult {
  workflowId: string
  revision: number
  status: 'protecting' | 'stopped' | 'expired' | 'succeeded'
  childIntentId: string | null
  rejectCode: string | null
  replayed: boolean
}
export interface PositionProtectionPreparation {
  prepare(scope: PartialCloseWorkflowScope): Promise<PositionProtectionPreparationResult>
}
