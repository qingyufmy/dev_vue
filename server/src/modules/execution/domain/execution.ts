import { createHash } from 'node:crypto'
import type { JsonObject, TraderAction, TraderExecutableActionKind } from '../../inference/domain/inference.js'
import type { RiskRuleResult } from '../../risk/domain/risk.js'

/** The preparation window is intentionally short: it starts at risk evaluation time. */
export const PREPARED_EXECUTION_TTL_MS = 30_000

export const EXECUTION_OPERATION_STATUSES = [
  'accepted', 'queued', 'running', 'succeeded', 'partially_succeeded', 'rejected', 'failed',
  'uncertain', 'cancelled', 'expired',
] as const
export type ExecutionOperationStatus = typeof EXECUTION_OPERATION_STATUSES[number]

export const EXECUTION_INTENT_STATUSES = [
  'preparing', 'risk_pending', 'prepared', 'dispatching', 'awaiting_result', 'reconciling',
  'succeeded', 'rejected', 'failed', 'uncertain', 'cancelled', 'expired',
] as const
export type ExecutionIntentStatus = typeof EXECUTION_INTENT_STATUSES[number]

export const RISK_RESERVATION_STATUSES = ['active', 'committed', 'absorbed', 'released', 'expired'] as const
export type RiskReservationStatus = typeof RISK_RESERVATION_STATUSES[number]

export type ExecutionPreparationNoopReason = 'no_approved_actions'

/**
 * A read-only, immutable view of one approved risk decision.
 *
 * The execution domain deliberately accepts a frozen source rather than a
 * model result or an inference context. The repository must load it again and
 * compare the source revision/hash in its persistence transaction.
 */
export interface ApprovedRiskExecutionSource {
  riskDecisionId: string
  tradeDecisionId: string
  userId: number
  accountId: string
  accountCurrency: string
  status: 'approved'
  rejectCode: null
  platformPolicyVersionId: string
  accountPolicyVersionId: string | null
  policySetRevision: number
  accountRiskRevision: number
  manualReleaseId: string | null
  manualReleaseRevision: number | null
  policyHash: string
  evaluatedAt: string
  revision: number
  approvedActions: TraderAction[]
  riskRules: RiskRuleResult[]
}

export interface Operation {
  id: string
  userId: number
  accountId: string
  kind: 'risk_decision_execution'
  status: ExecutionOperationStatus
  sourceType: 'risk_decision'
  sourceId: string
  idempotencyScope: 'risk_decision'
  idempotencyKey: string
  requestHash: string
  resourceType: 'execution_intent'
  resourceId: string | null
  errorCode: string | null
  acceptedAt: string
  updatedAt: string
  completedAt: string | null
  revision: number
  intentIds: string[]
}

export interface ExecutionIntent {
  id: string
  operationId: string
  riskDecisionId: string
  tradeDecisionId: string
  userId: number
  accountId: string
  actionId: string
  actionKind: TraderExecutableActionKind
  action: TraderAction
  sourceType: 'risk_decision'
  sourceId: string
  idempotencyKey: string
  requestHash: string
  expectedStateHash: string
  status: ExecutionIntentStatus
  expiresAt: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  errorCode: string | null
  revision: number
  riskReservationId: string | null
}

export interface RiskReservation {
  id: string
  executionIntentId: string
  userId: number
  accountId: string
  symbol: string
  accountCurrency: string
  reservedVolume: number
  reservedRiskAmount: number
  reservedRiskPercent: number
  reservedOpenPositions: number
  reservedPendingOrders: number
  reservedDailyOpens: number
  status: RiskReservationStatus
  expiresAt: string
  releasedAt: string | null
  releaseReason: string | null
  createdAt: string
  updatedAt: string
  revision: number
}

export interface PreparedExecutionBundle {
  kind: 'prepared'
  sourceHash: string
  riskDecisionId: string
  sourceRevision: number
  accountRiskRevision: number
  operation: Operation
  intents: ExecutionIntent[]
  reservations: RiskReservation[]
}

export interface PreparedExecutionNoop {
  kind: 'noop'
  reason: ExecutionPreparationNoopReason
  riskDecisionId: string
  sourceHash: string
}

export type PreparedExecutionResult = PreparedExecutionBundle | PreparedExecutionNoop

export type ExecutionErrorCode =
  | 'execution_source_invalid'
  | 'execution_source_not_approved'
  | 'execution_source_expired'
  | 'execution_source_time_invalid'
  | 'execution_action_invalid'
  | 'execution_action_id_duplicate'
  | 'execution_risk_data_missing'
  | 'execution_risk_data_invalid'
  | 'execution_risk_data_mismatch'
  | 'execution_account_currency_invalid'
  | 'execution_persistence_conflict'
  | 'execution_source_revision_conflict'
  | 'execution_operation_not_found'
  | 'execution_operation_id_invalid'
  | 'execution_expire_limit_invalid'

export class ExecutionError extends Error {
  constructor(public readonly code: ExecutionErrorCode | string, public readonly status: number) {
    super(code)
    this.name = 'ExecutionError'
  }
}

const executableKinds = new Set<TraderExecutableActionKind>([
  'market_order', 'pending_order', 'modify_position', 'close_position', 'modify_order', 'cancel_order',
])
const reservingKinds = new Set<TraderExecutableActionKind>(['market_order', 'pending_order'])
const riskRuleCode = 'RISK_ACTION_APPROVED'

/**
 * Convert an approved risk decision into immutable prepared intents.
 *
 * This function only builds a deterministic in-memory bundle. It never talks
 * to a terminal, creates a command, or performs network I/O. Persistence and
 * concurrent capacity revalidation belong to the repository transaction.
 */
export function prepareExecutionBundle(source: ApprovedRiskExecutionSource, now = new Date()): PreparedExecutionResult {
  assertSource(source)
  assertNow(now)
  const sourceHash = executionSourceHash(source)

  // An approved hold is a valid risk outcome, but there is no executable work
  // and therefore no operation, intent, or reservation to persist.
  if (source.approvedActions.length === 0) {
    return { kind: 'noop', reason: 'no_approved_actions', riskDecisionId: source.riskDecisionId, sourceHash }
  }

  const evaluatedAt = parseTimestamp(source.evaluatedAt)
  if (evaluatedAt === null || evaluatedAt > now.getTime()) throw new ExecutionError('execution_source_time_invalid', 422)
  const expiresAtMs = evaluatedAt + PREPARED_EXECUTION_TTL_MS
  if (expiresAtMs <= now.getTime()) throw new ExecutionError('execution_source_expired', 409)
  const expiresAt = new Date(expiresAtMs).toISOString()
  const operationId = stableUuid({ kind: 'operation', riskDecisionId: source.riskDecisionId })
  const operationKey = `risk_decision:${source.riskDecisionId}`
  const createdAt = now.toISOString()
  const intents: ExecutionIntent[] = []
  const reservations: RiskReservation[] = []
  const intentIds: string[] = []

  for (const action of source.approvedActions) {
    assertAction(action)
    if (intentIds.includes(action.actionId)) throw new ExecutionError('execution_action_id_duplicate', 422)
    intentIds.push(action.actionId)

    const intentId = stableUuid({ kind: 'intent', riskDecisionId: source.riskDecisionId, actionId: action.actionId })
    const idempotencyKey = sha256Canonical({ riskDecisionId: source.riskDecisionId, actionId: action.actionId })
    const requestHash = sha256Canonical({
      riskDecisionId: source.riskDecisionId,
      tradeDecisionId: source.tradeDecisionId,
      action,
    })
    const expectedStateHash = sha256Canonical(action.expectedState)
    const risk = reservingKinds.has(action.kind)
      ? approvedRiskData(source, action)
      : null
    const riskReservationId = risk ? stableUuid({ kind: 'reservation', intentId }) : null
    intents.push({
      id: intentId, operationId, riskDecisionId: source.riskDecisionId, tradeDecisionId: source.tradeDecisionId,
      userId: source.userId, accountId: source.accountId, actionId: action.actionId, actionKind: action.kind,
      action, sourceType: 'risk_decision', sourceId: source.riskDecisionId, idempotencyKey, requestHash,
      expectedStateHash, status: 'prepared', expiresAt, createdAt, updatedAt: createdAt, completedAt: null,
      errorCode: null, revision: 1, riskReservationId,
    })
    if (risk && riskReservationId) {
      reservations.push({
        id: riskReservationId, executionIntentId: intentId, userId: source.userId, accountId: source.accountId,
        symbol: risk.symbol, accountCurrency: source.accountCurrency.trim().toUpperCase(),
        reservedVolume: risk.volume, reservedRiskAmount: risk.riskAmount, reservedRiskPercent: risk.riskPercent,
        reservedOpenPositions: action.kind === 'market_order' ? 1 : 0,
        reservedPendingOrders: action.kind === 'pending_order' ? 1 : 0,
        reservedDailyOpens: 1, status: 'active', expiresAt, releasedAt: null, releaseReason: null,
        createdAt, updatedAt: createdAt, revision: 1,
      })
    }
  }

  const operation: Operation = {
    id: operationId, userId: source.userId, accountId: source.accountId, kind: 'risk_decision_execution',
    status: 'queued', sourceType: 'risk_decision', sourceId: source.riskDecisionId,
    idempotencyScope: 'risk_decision', idempotencyKey: operationKey, requestHash: sourceHash,
    resourceType: 'execution_intent', resourceId: intents.length === 1 ? intents[0]!.id : null,
    errorCode: null, acceptedAt: createdAt, updatedAt: createdAt, completedAt: null, revision: 1,
    intentIds: intents.map(intent => intent.id),
  }
  return {
    kind: 'prepared', sourceHash, riskDecisionId: source.riskDecisionId, sourceRevision: source.revision,
    accountRiskRevision: source.accountRiskRevision, operation, intents, reservations,
  }
}

function assertSource(source: ApprovedRiskExecutionSource) {
  if (!source || typeof source !== 'object') throw new ExecutionError('execution_source_invalid', 422)
  for (const [name, value] of [['riskDecisionId', source.riskDecisionId], ['tradeDecisionId', source.tradeDecisionId], ['accountId', source.accountId], ['platformPolicyVersionId', source.platformPolicyVersionId], ['policyHash', source.policyHash], ['evaluatedAt', source.evaluatedAt]] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) throw new ExecutionError(`execution_source_${name}_invalid`, 422)
  }
  if (!/^[a-f0-9]{64}$/.test(source.policyHash)) throw new ExecutionError('execution_source_policy_hash_invalid', 422)
  if (source.status !== 'approved' || source.rejectCode !== null) throw new ExecutionError('execution_source_not_approved', 409)
  if (!Number.isSafeInteger(source.userId) || source.userId < 1
    || !Number.isSafeInteger(source.revision) || source.revision < 1
    || !Number.isSafeInteger(source.accountRiskRevision) || source.accountRiskRevision < 1
    || !Number.isSafeInteger(source.policySetRevision) || source.policySetRevision < 0) throw new ExecutionError('execution_source_invalid', 422)
  if (!Array.isArray(source.approvedActions) || !Array.isArray(source.riskRules) || source.approvedActions.length > 16) throw new ExecutionError('execution_source_invalid', 422)
  if ((source.manualReleaseId === null) !== (source.manualReleaseRevision === null)
    || (source.manualReleaseId !== null && (source.manualReleaseId.trim().length === 0 || !Number.isSafeInteger(source.manualReleaseRevision) || source.manualReleaseRevision! < 1))) {
    throw new ExecutionError('execution_source_invalid', 422)
  }
  if (typeof source.accountCurrency !== 'string') throw new ExecutionError('execution_account_currency_invalid', 422)
  if (!/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(source.accountCurrency.trim().toUpperCase())) throw new ExecutionError('execution_account_currency_invalid', 422)
  for (const rule of source.riskRules) {
    if (!rule || typeof rule !== 'object' || typeof rule.code !== 'string' || !isJsonObject(rule.details)
      || (rule.actionId !== null && typeof rule.actionId !== 'string')) throw new ExecutionError('execution_source_invalid', 422)
  }
}

function assertAction(action: TraderAction) {
  if (!action || typeof action !== 'object' || typeof action.actionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(action.actionId)) throw new ExecutionError('execution_action_invalid', 422)
  if (!executableKinds.has(action.kind) || !isJsonObject(action.parameters) || !isJsonObject(action.expectedState)) throw new ExecutionError('execution_action_invalid', 422)
  if (Object.keys(action.parameters).length === 0 || Object.keys(action.expectedState).length === 0) throw new ExecutionError('execution_action_invalid', 422)
}

function approvedRiskData(source: ApprovedRiskExecutionSource, action: TraderAction) {
  const matches = source.riskRules.filter(rule => rule.code === riskRuleCode && rule.actionId === action.actionId && rule.outcome === 'passed')
  if (matches.length !== 1) throw new ExecutionError('execution_risk_data_missing', 422)
  const details = matches[0]!.details
  if (!['risk_amount', 'risk_percent', 'volume'].every(key => Object.prototype.hasOwnProperty.call(details, key))) {
    throw new ExecutionError('execution_risk_data_missing', 422)
  }
  const riskAmount = finiteNonNegative(details.risk_amount)
  const riskPercent = finiteNonNegative(details.risk_percent)
  const volume = finitePositive(details.volume)
  if (riskAmount === null || riskPercent === null || volume === null) throw new ExecutionError('execution_risk_data_invalid', 422)
  const actionVolume = finitePositive(action.parameters.volume)
  if (actionVolume === null || !nearlyEqual(actionVolume, volume)) throw new ExecutionError('execution_risk_data_mismatch', 422)
  const symbol = typeof action.parameters.symbol === 'string' ? action.parameters.symbol.trim().toUpperCase() : ''
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(symbol)) throw new ExecutionError('execution_action_invalid', 422)
  return { riskAmount, riskPercent, volume, symbol }
}

function finiteNonNegative(value: unknown) {
  const result = finiteNumber(value)
  return result !== null && result >= 0 ? result : null
}

function finitePositive(value: unknown) {
  const result = finiteNumber(value)
  return result !== null && result > 0 ? result : null
}

function finiteNumber(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function nearlyEqual(left: number, right: number) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right))
  return Math.abs(left - right) <= scale * 1e-9
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNow(now: Date) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new ExecutionError('execution_source_time_invalid', 422)
}

function parseTimestamp(value: string) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Canonical JSON is shared by the idempotency and optimistic-state hashes. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ExecutionError('execution_action_invalid', 422)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new ExecutionError('execution_action_invalid', 422)
}

export function sha256Canonical(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function executionSourceHash(source: ApprovedRiskExecutionSource) {
  return sha256Canonical({
    riskDecisionId: source.riskDecisionId, tradeDecisionId: source.tradeDecisionId, userId: source.userId,
    accountId: source.accountId, accountCurrency: source.accountCurrency, status: source.status,
    platformPolicyVersionId: source.platformPolicyVersionId, accountPolicyVersionId: source.accountPolicyVersionId,
    policySetRevision: source.policySetRevision, accountRiskRevision: source.accountRiskRevision,
    manualReleaseId: source.manualReleaseId, manualReleaseRevision: source.manualReleaseRevision,
    policyHash: source.policyHash, evaluatedAt: source.evaluatedAt, revision: source.revision,
    approvedActions: source.approvedActions, riskRules: source.riskRules,
  })
}

function stableUuid(seed: unknown) {
  const hex = sha256Canonical(seed)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
