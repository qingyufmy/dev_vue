import type { BridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import { writePartialCloseParentDispatchReview, type CapturePartialCloseParentDispatch } from '../modules/execution/composition.js'
import { createMysqlExecutionPositionReader, createTransactionTerminalFactRouteGuard } from '../modules/trading/composition.js'
import { createPartialCloseRegistrationTargetReader } from './partial-close-registration.js'
import { createTransactionPartialCloseDispatchReviewer } from './partial-close-dispatch-review.js'
import type { PositionProtectionReadLimits } from './position-protection-review.js'

/** Explicit capability; enable in entrypoints only after schema and joint transaction acceptance. */
export function createPartialCloseParentDispatchCapture(routes: Pick<BridgeGatewayLeaseStore, 'current'>,
  sourceLimits: PositionProtectionReadLimits): CapturePartialCloseParentDispatch {
  const limits = structuredClone(sourceLimits)
  return async source => {
    const command = structuredClone(source)
    const current = await routes.current(command.accountId)
    const route = current ? structuredClone(current) : null
    return async (connection, candidate, action, expiresAt) => {
      if (!route || route.platform !== 'mt5' || route.userId !== candidate.userId || route.accountId !== candidate.accountId
        || route.terminalProfileId !== candidate.terminalProfileId || route.terminalInstanceId !== candidate.route.terminalInstanceId
        || route.brokerServer !== candidate.route.brokerServer || route.login !== candidate.route.login
        || route.connectionEpoch !== candidate.route.connectionEpoch || candidate.id !== command.id
        || candidate.requestHash !== command.requestHash) throw new Error('partial_close_dispatch_route_unavailable')
      const targets = createPartialCloseRegistrationTargetReader(createMysqlExecutionPositionReader(connection,
        createTransactionTerminalFactRouteGuard(connection)), route, limits.maxAgeMs)
      return writePartialCloseParentDispatchReview(connection, candidate, action, expiresAt, targets,
        createTransactionPartialCloseDispatchReviewer(connection, route, limits))
    }
  }
}
