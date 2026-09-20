import type { PartialCloseWorkflowScope } from './partial-close-workflow-progress.js'
import { createPositionProtectionReceiverContext, type PositionProtectionPreparationDependencies } from './position-protection-receiver-context.js'

/** Creates the durable queued command and its transactional outbox; Gateway owns all terminal I/O. */
export function createPositionProtectionPreparationReceiver(deps: PositionProtectionPreparationDependencies) {
  const { leased, prepare } = createPositionProtectionReceiverContext(deps)
  return async (scope: PartialCloseWorkflowScope, childIntentId: string): Promise<void> => {
    await leased(scope, childIntentId, async (scope, renew) => {
      await prepare(scope, childIntentId, renew)
    })
  }
}
