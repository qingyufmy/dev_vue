import type { PartialCloseWorkflowScope } from './partial-close-workflow-progress.js'
import type { PositionProtectionOutcome } from '../domain/position-protection-outcome.js'

export interface PositionProtectionOutcomeService {
  merge(scope: PartialCloseWorkflowScope): Promise<{ outcome: PositionProtectionOutcome; revision: number; replayed: boolean }>
}
