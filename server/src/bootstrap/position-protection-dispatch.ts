import type { BridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import { writePositionProtectionDispatchReview, type CapturePositionProtectionDispatch } from '../modules/execution/composition.js'
import { createPositionProtectionCommandProviderCapture } from './position-protection-command-provider.js'
import type { PositionProtectionReadLimits } from './position-protection-review.js'

/** Explicit capability: runtime callers must also supply workflow result recovery before enabling it. */
export function createPositionProtectionDispatchCapture(routes: Pick<BridgeGatewayLeaseStore, 'current'>,
  limits: PositionProtectionReadLimits): CapturePositionProtectionDispatch {
  const capture = createPositionProtectionCommandProviderCapture(routes, limits)
  return async command => {
    const provider = await capture(command)
    return (connection, candidate, workflowId) => writePositionProtectionDispatchReview(connection, candidate, workflowId, {
      review: scope => provider.authorize(connection, candidate, scope.workflowId),
    })
  }
}
