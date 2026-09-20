import { sha256Canonical, PREPARED_EXECUTION_TTL_MS, type ExecutionIntent, type Operation } from './execution.js'
import type { ExecutionRiskEvaluation } from './execution-input.js'
import { BridgeCommandError } from './bridge-command.js'
import { evaluatePartialCloseProtection, partialCloseRemainingVolume, partialCloseVolumeEquals, type PartialCloseProtectionPlan, type ProtectionEligibility } from './partial-close-protection.js'

type Ready = Extract<ProtectionEligibility, { state: 'risk_review_required' }>
export interface PositionProtectionRequest {
  workflowId: string
  workflowRevision: number
  userId: number
  accountId: string
  target: Omit<PartialCloseProtectionPlan['target'], 'userId' | 'accountId'>
  remainingVolume: string
  minimumPositionRevision: number
  notBefore: number
  expiresAt: number
  protection: PartialCloseProtectionPlan['protection']
}
export interface PositionProtectionReview {
  workflowId: string
  workflowRevision: number
  requestHash: string
  contextHash: string
  evaluation: ExecutionRiskEvaluation
}
export interface PositionProtectionChild {
  operation: Omit<Operation, 'kind' | 'sourceType' | 'idempotencyScope'> & {
    kind: 'position_workflow'; sourceType: 'position_workflow'; idempotencyScope: 'position_workflow'
  }
  intent: Omit<ExecutionIntent, 'sourceType'> & { sourceType: 'position_workflow' }
  request: PositionProtectionRequest
  review: PositionProtectionReview
  reviewHash: string
}
const fail = (): never => { throw new BridgeCommandError('position_protection_review_mismatch', 409) }
const hash = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
function stableId(workflowId: string, kind: string) {
  const hex = sha256Canonical({ namespace: 'position-protection-child:v1', workflowId, kind })
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-${['8','9','a','b'][parseInt(hex[16]!,16)%4]}${hex.slice(17,20)}-${hex.slice(20,32)}`
}

/** Only call with the locked plan and its verified persisted eligibility event. */
export function positionProtectionRequest(plan: PartialCloseProtectionPlan, ready: Ready, revision: number): PositionProtectionRequest {
  if (!Number.isSafeInteger(revision) || revision < 2 || revision >= Number.MAX_SAFE_INTEGER
    || ready.state !== 'risk_review_required' || ready.workflowId !== plan.workflowId
    || sha256Canonical(ready.target) !== sha256Canonical(plan.target)
    || sha256Canonical(ready.protection) !== sha256Canonical(plan.protection)) fail()
  const validPlan = evaluatePartialCloseProtection({ plan, parentState: 'pending', history: null, projection: null,
    now: ready.projectionObservedAt, maxProjectionAgeMs: 1 }).state === 'wait_close'
  const remaining = partialCloseRemainingVolume(plan.initialVolume, plan.closeVolume)
  if (!validPlan || remaining === null || !partialCloseVolumeEquals(remaining, ready.remainingVolume)
    || !Number.isSafeInteger(ready.projectionRevision) || ready.projectionRevision <= plan.initialRevision
    || !/^[1-9][0-9]*$/.test(plan.target.userId) || !Number.isSafeInteger(Number(plan.target.userId))
    || Number(plan.target.userId) > 2147483647) fail()
  const { userId, accountId, ...target } = plan.target
  return structuredClone({ workflowId: plan.workflowId, workflowRevision: revision, userId: Number(userId), accountId, target,
    remainingVolume: ready.remainingVolume, minimumPositionRevision: ready.projectionRevision,
    notBefore: ready.projectionObservedAt, expiresAt: plan.expiresAt, protection: plan.protection })
}

/** Pure preparation. Persistence must reload the source, review on its connection and insert atomically. */
export function preparePositionProtectionChild(input: {
  plan: PartialCloseProtectionPlan; ready: Ready; revision: number; parentOperationId: string; review: PositionProtectionReview; now: Date
}): PositionProtectionChild {
  const request = positionProtectionRequest(input.plan, input.ready, input.revision)
  const review = structuredClone(input.review), evaluation = review.evaluation
  const at = Date.parse(evaluation.evaluatedAt), now = input.now.getTime()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.parentOperationId)
    || review.workflowId !== request.workflowId || review.workflowRevision !== request.workflowRevision
    || review.requestHash !== sha256Canonical(request) || !hash(review.contextHash) || !hash(evaluation.policyHash)
    || evaluation.status !== 'approved' || evaluation.rejectCode !== null || evaluation.manualReleaseId !== null || evaluation.manualReleaseRevision !== null
    || evaluation.approvedActions.length !== 1 || !Number.isSafeInteger(at) || new Date(at).toISOString() !== evaluation.evaluatedAt
    || !Number.isSafeInteger(now) || at > now || at < request.notBefore || now >= Math.min(request.expiresAt, at + PREPARED_EXECUTION_TTL_MS)) fail()
  const action = evaluation.approvedActions[0]!
  const parameters = { ticket: request.target.ticket,
    ...(request.protection.stopLoss === undefined ? {} : { stop_loss: request.protection.stopLoss }),
    ...(request.protection.takeProfit === undefined ? {} : { take_profit: request.protection.takeProfit }) }
  const revisions = ['accountRevision','positionsRevision','quoteRevision','contractRevision','riskRevision']
  if (action.actionId !== `protection:${request.workflowId}:${request.workflowRevision}` || action.kind !== 'modify_position'
    || sha256Canonical(action.parameters) !== sha256Canonical(parameters)
    || Object.keys(action.expectedState).length !== revisions.length
    || revisions.some(key => !Number.isSafeInteger(action.expectedState[key]) || Number(action.expectedState[key]) < 1)
    || Number(action.expectedState.positionsRevision) < request.minimumPositionRevision
    || evaluation.rules.length === 0 || evaluation.rules.some(rule => rule.outcome === 'rejected')
    || !evaluation.rules.some(rule => rule.code === 'RISK_POSITION_PROTECTION_APPROVED' && rule.outcome === 'passed' && rule.actionId === action.actionId)) fail()
  const operationId = stableId(request.workflowId, 'operation'), intentId = stableId(request.workflowId, 'intent')
  const reviewHash = sha256Canonical(review), createdAt = input.now.toISOString()
  const requestHash = sha256Canonical({ request, reviewHash, parentOperationId: input.parentOperationId })
  const idempotencyKey = sha256Canonical({ sourceType: 'position_workflow', workflowId: request.workflowId })
  const intent: PositionProtectionChild['intent'] = { id: intentId, operationId, riskDecisionId: null, tradeDecisionId: null,
    userId: request.userId, accountId: request.accountId, actionId: action.actionId, actionKind: 'modify_position', action,
    sourceType: 'position_workflow', sourceId: request.workflowId, idempotencyKey, requestHash,
    expectedStateHash: sha256Canonical(action.expectedState), status: 'prepared',
    expiresAt: new Date(Math.min(request.expiresAt, at + PREPARED_EXECUTION_TTL_MS)).toISOString(), createdAt, updatedAt: createdAt,
    completedAt: null, errorCode: null, revision: 1, riskReservationId: null, userCommandId: null }
  const operation: PositionProtectionChild['operation'] = { id: operationId, userId: request.userId, accountId: request.accountId,
    kind: 'position_workflow', sourceType: 'position_workflow', sourceId: request.workflowId, idempotencyScope: 'position_workflow',
    idempotencyKey, requestHash, resourceType: 'execution_intent', resourceId: intentId, status: 'queued', errorCode: null,
    acceptedAt: createdAt, updatedAt: createdAt, completedAt: null, revision: 1, intentIds: [intentId], parentOperationId: input.parentOperationId }
  return { request, review, reviewHash, operation, intent }
}
