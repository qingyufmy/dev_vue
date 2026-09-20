import { BridgeCommandError } from './bridge-command.js'
import { PREPARED_EXECUTION_TTL_MS, sha256Canonical } from './execution.js'
import type { ExecutionAction } from './execution-input.js'
import type { PositionProtectionChild, PositionProtectionReview } from './position-protection-child.js'

export interface PositionProtectionCommandReview {
  workflowId: string
  childIntentId: string
  sourceRequestHash: string
  preparationReviewHash: string
  review: PositionProtectionReview
  reviewHash: string
  action: ExecutionAction
  expectedStateHash: string
  expiresAt: string
}
function fail(): never { throw new BridgeCommandError('position_protection_command_review_invalid',409) }

/** Current dispatch authority is a separate receipt; it never rewrites the original intent or extends its lifetime. */
export function reviewPositionProtectionCommand(child: PositionProtectionChild, current: PositionProtectionReview, now: Date): PositionProtectionCommandReview {
  const review = structuredClone(current), evaluation = review.evaluation, original = child.intent.action
  const evaluated = Date.parse(evaluation.evaluatedAt), at = now.getTime(), expiry = Date.parse(child.intent.expiresAt)
  if (child.intent.sourceType !== 'position_workflow' || child.intent.sourceId !== child.request.workflowId
    || child.reviewHash !== sha256Canonical(child.review) || child.review.requestHash !== sha256Canonical(child.request)
    || child.review.evaluation.status !== 'approved' || review.workflowId !== child.request.workflowId
    || review.workflowRevision !== child.request.workflowRevision || review.requestHash !== child.review.requestHash
    || !/^[0-9a-f]{64}$/.test(review.contextHash) || !/^[0-9a-f]{64}$/.test(evaluation.policyHash)
    || evaluation.status !== 'approved' || evaluation.rejectCode !== null || evaluation.manualReleaseId !== null || evaluation.manualReleaseRevision !== null
    || !Number.isSafeInteger(at) || !Number.isSafeInteger(evaluated) || !Number.isSafeInteger(expiry)
    || new Date(evaluated).toISOString() !== evaluation.evaluatedAt || new Date(expiry).toISOString() !== child.intent.expiresAt
    || evaluated < Date.parse(child.review.evaluation.evaluatedAt) || evaluated > at || at >= expiry
    || expiry > child.request.expiresAt || at >= evaluated+PREPARED_EXECUTION_TTL_MS || evaluation.approvedActions.length !== 1) fail()
  const action = evaluation.approvedActions[0]!, keys = ['accountRevision','positionsRevision','quoteRevision','contractRevision','riskRevision']
  if (action.kind !== 'modify_position' || action.actionId !== original.actionId || sha256Canonical(action.parameters) !== sha256Canonical(original.parameters)
    || Object.keys(action.expectedState).length !== keys.length
    || keys.some(key => !Number.isSafeInteger(action.expectedState[key]) || !Number.isSafeInteger(original.expectedState[key])
      || Number(action.expectedState[key]) < 1 || Number(action.expectedState[key]) < Number(original.expectedState[key]))
    || evaluation.rules.some(rule => rule.outcome === 'rejected')
    || !evaluation.rules.some(rule => rule.code === 'RISK_POSITION_PROTECTION_APPROVED' && rule.outcome === 'passed' && rule.actionId === action.actionId)) fail()
  return {workflowId:child.request.workflowId,childIntentId:child.intent.id,sourceRequestHash:child.intent.requestHash,
    preparationReviewHash:child.reviewHash,review,reviewHash:sha256Canonical(review),action,
    expectedStateHash:sha256Canonical(action.expectedState),expiresAt:child.intent.expiresAt}
}
