import type { PartialCloseDispatchRiskRequest, evaluatePartialCloseDispatch } from '../../risk/index.js'
import type { BridgeCommand } from './bridge-command.js'
import { BridgeCommandError } from './bridge-command.js'
import type { PartialCloseProtectionPlan } from './partial-close-protection.js'
import { partialCloseRemainingVolume, partialCloseVolumeEquals } from './partial-close-protection.js'
import { sha256Canonical } from './execution.js'

export type PartialCloseDispatchRiskReview = ReturnType<typeof evaluatePartialCloseDispatch>
export function partialCloseDispatchRiskRequest(plan: PartialCloseProtectionPlan, command: BridgeCommand): PartialCloseDispatchRiskRequest {
  const { userId: _userId, accountId: _accountId, ...target } = plan.target
  return { workflowId: plan.workflowId, userId: command.userId, accountId: command.accountId, target,
    initialVolume: plan.initialVolume, closeVolume: plan.closeVolume, positionRevision: plan.initialRevision,
    notBefore: Date.parse(command.issuedAt), expiresAt: Math.min(plan.expiresAt,Date.parse(command.deadlineAt)) }
}

/** Bind a fresh, successful parent review to exactly the immutable command and continuation plan. */
export function bindPartialCloseDispatchReview(plan: PartialCloseProtectionPlan, command: BridgeCommand, review: PartialCloseDispatchRiskReview, now: Date) {
  const request = partialCloseDispatchRiskRequest(plan,command), at = now.getTime(), reviewedAt = Date.parse(review.evaluatedAt)
  const fail = () => { throw new BridgeCommandError('partial_close_dispatch_review_invalid',409) }
  if (command.status !== 'queued' || command.revision !== 1 || command.action !== 'position.close'
    || plan.parentCommandId !== command.id || plan.parentIntentId !== command.executionIntentId
    || plan.target.userId !== String(command.userId) || plan.target.accountId !== command.accountId
    || plan.target.terminalInstanceId !== command.route.terminalInstanceId || plan.target.brokerServer !== command.route.brokerServer || plan.target.login !== command.route.login
    || review.status !== 'approved' || review.rejectCode !== null || review.requestHash !== sha256Canonical(request)
    || !/^[a-f0-9]{64}$/.test(review.contextHash) || !/^[a-f0-9]{64}$/.test(review.policyHash)
    || !Number.isSafeInteger(at) || !Number.isSafeInteger(reviewedAt) || reviewedAt < request.notBefore || reviewedAt > at
    || at - reviewedAt > 5000 || at >= request.expiresAt || review.volume === null || review.remainingVolume === null
    || !partialCloseVolumeEquals(review.volume,plan.closeVolume)
    || !partialCloseVolumeEquals(review.remainingVolume,partialCloseRemainingVolume(plan.initialVolume,plan.closeVolume) ?? '0')) fail()
  return { workflowId: plan.workflowId, parentIntentId: plan.parentIntentId, commandId: command.id,
    commandHash: command.requestHash, planHash: sha256Canonical(plan), request,
    review: structuredClone(review), checkedAt: now.toISOString() }
}
