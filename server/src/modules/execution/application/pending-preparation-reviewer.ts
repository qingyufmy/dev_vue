import type { EffectiveRiskPolicy } from '../../risk/index.js'
import type { ApprovedRiskExecutionSource, PreparedExecutionBundle } from '../domain/execution.js'
export interface PendingPreparationReviewer {
  review(source: ApprovedRiskExecutionSource, bundle: PreparedExecutionBundle, policy: EffectiveRiskPolicy, now: Date): Promise<void>
}
