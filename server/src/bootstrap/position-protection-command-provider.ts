import type { BridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import {
  replayPositionProtectionCommandBinding, writePositionProtectionCommandBinding,
  type CapturePositionProtectionCommandProvider,
} from '../modules/execution/composition.js'
import { BridgeCommandError, sha256Canonical } from '../modules/execution/index.js'
import { createPositionProtectionCommandReviewCapture } from './position-protection-preparation.js'
import type { PositionProtectionReadLimits } from './position-protection-review.js'

/** Redis is read before BEGIN; authorization and durable replay use the caller's SQL transaction. */
export function createPositionProtectionCommandProviderCapture(routes: Pick<BridgeGatewayLeaseStore, 'current'>,
  limits: PositionProtectionReadLimits): CapturePositionProtectionCommandProvider {
  // Validate and freeze limits before any route lookup.
  const frozenLimits = structuredClone(limits)
  createPositionProtectionCommandReviewCapture(routes, frozenLimits)
  return async input => {
    const command = structuredClone(input), identity = sha256Canonical(command)
    let route: Awaited<ReturnType<BridgeGatewayLeaseStore['current']>> = null
    let failed = false, failure: unknown
    try { route = structuredClone(await routes.current(command.accountId)) }
    catch (error) { failed = true; failure = error }
    const captureReview = createPositionProtectionCommandReviewCapture({ async current() {
      if (failed) throw failure
      return route
    } }, frozenLimits)
    const assertCommand = (candidate: typeof command) => {
      if (sha256Canonical(candidate) !== identity) throw new BridgeCommandError('position_protection_command_scope_mismatch', 409)
    }
    return {
      async authorize(connection, candidate, workflowId) {
        assertCommand(candidate)
        const scope = { workflowId, userId: command.userId, accountId: command.accountId }
        const bind = await captureReview(scope)
        return bind(connection).review(scope, command.executionIntentId)
      },
      async bind(connection, candidate, authority) {
        assertCommand(candidate)
        await writePositionProtectionCommandBinding(connection, candidate, authority)
      },
      async replay(connection, candidate, workflowId) {
        // Existing repository commands may have advanced status since the input was captured.
        if (candidate.id !== command.id || candidate.executionIntentId !== command.executionIntentId
          || candidate.userId !== command.userId || candidate.accountId !== command.accountId
          || candidate.requestHash !== command.requestHash) {
          throw new BridgeCommandError('position_protection_command_scope_mismatch', 409)
        }
        await replayPositionProtectionCommandBinding(connection, candidate, workflowId)
      },
    }
  }
}
