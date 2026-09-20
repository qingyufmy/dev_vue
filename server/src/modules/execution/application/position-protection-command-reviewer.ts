import type { PartialCloseWorkflowScope } from './partial-close-workflow-progress.js'
import type { PositionProtectionCommandReview } from '../domain/position-protection-command-review.js'

export interface PositionProtectionCommandReviewer {
  review(scope: PartialCloseWorkflowScope, childIntentId: string): Promise<PositionProtectionCommandReview>
}
