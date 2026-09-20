import type { BridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlPositionProtectionCommandReviewer, type CapturePositionProtectionReviewer } from '../modules/execution/composition.js'
import type { PartialCloseWorkflowScope, PositionProtectionCommandReviewer } from '../modules/execution/index.js'
import { createMysqlPositionProtectionClock } from '../modules/risk/composition.js'
import { RiskError } from '../modules/risk/index.js'
import { createTransactionPositionProtectionReviewer, type PositionProtectionReadLimits } from './position-protection-review.js'

/** Capture Redis once before BEGIN. SQL readers revalidate this exact route inside the preparation transaction. */
export function createPositionProtectionReviewCapture(routes: Pick<BridgeGatewayLeaseStore, 'current'>,
  sourceLimits: PositionProtectionReadLimits): CapturePositionProtectionReviewer {
  const limits = structuredClone(sourceLimits)
  if (!Number.isSafeInteger(limits.maxAgeMs) || limits.maxAgeMs < 1 || limits.maxAgeMs > 60_000
    || !Number.isSafeInteger(limits.maxInstrumentAgeMs) || limits.maxInstrumentAgeMs < 1 || limits.maxInstrumentAgeMs > 300_000) {
    throw new Error('position_protection_read_limits_invalid')
  }
  return async input => {
    const scope = structuredClone(input)
    let current: Awaited<ReturnType<BridgeGatewayLeaseStore['current']>>
    try { current = await routes.current(scope.accountId) }
    catch (error) {
      // A durable receipt can still be recovered during a Redis outage. A new review cannot.
      return () => ({ async review() { throw error } })
    }
    const route = current ? structuredClone(current) : null
    return connection => {
      if (!route || route.platform !== 'mt5' || route.userId !== scope.userId || route.accountId !== scope.accountId) {
        // An unavailable route is retryable missing evidence, never a durable risk rejection.
        return { async review() { throw new RiskError('position_protection_context_unavailable', 409) } }
      }
      const reviewer = createTransactionPositionProtectionReviewer(connection, route, limits)
      return { async review(request) {
        if (request.workflowId !== scope.workflowId || request.userId !== scope.userId || request.accountId !== scope.accountId) {
          throw new RiskError('position_protection_context_unavailable', 409)
        }
        return reviewer.review(request)
      } }
    }
  }
}

/** Dispatch callers retain the transaction until the new authority and command are durably bound. */
export function createPositionProtectionCommandReviewCapture(routes: Pick<BridgeGatewayLeaseStore,'current'>, limits: PositionProtectionReadLimits):
  (scope: PartialCloseWorkflowScope) => Promise<(connection: PoolConnection) => PositionProtectionCommandReviewer> {
  const capture = createPositionProtectionReviewCapture(routes,limits)
  return async scope => {
    const bind = await capture(scope)
    return connection => createMysqlPositionProtectionCommandReviewer(connection,bind(connection),createMysqlPositionProtectionClock(connection))
  }
}
