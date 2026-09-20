import type { ExecutionJsonObject } from './execution-input.js'
import type { Operation } from './execution.js'
import type {
  UserExecutionCommandInput,
  UserExecutionExpectedRevisions,
  UserExecutionOrderType,
} from './user-execution-command.js'
import { sha256Canonical } from './execution.js'

/**
 * The public distribution surface intentionally accepts only entry commands.
 * Protection changes and closes remain account-scoped commands; allowing them
 * here would make a batch operation much harder to attribute and reconcile.
 */
export const DISTRIBUTION_COMMAND_TYPES = ['market_order', 'pending_order'] as const
export type DistributionCommandType = typeof DISTRIBUTION_COMMAND_TYPES[number]

export const DISTRIBUTION_KINDS = ['manual_order', 'close'] as const
export type DistributionKind = typeof DISTRIBUTION_KINDS[number]

export const DISTRIBUTION_STATUSES = [
  'accepted', 'queued', 'running', 'succeeded', 'partially_succeeded', 'rejected',
  'failed', 'uncertain', 'cancelled', 'expired',
] as const
export type DistributionStatus = typeof DISTRIBUTION_STATUSES[number]

export const DISTRIBUTION_TARGET_STATUSES = [
  'queued', 'running', 'succeeded', 'rejected', 'failed', 'uncertain', 'cancelled', 'expired',
] as const
export type DistributionTargetStatus = typeof DISTRIBUTION_TARGET_STATUSES[number]

export interface DistributionMarketOrderCommand {
  commandType: 'market_order'
  symbol: string
  side: 'buy' | 'sell'
  volume: string
  stopLoss: string
  takeProfit: string | null
  referencePrice: string
}

export interface DistributionPendingOrderCommand {
  commandType: 'pending_order'
  symbol: string
  orderType: UserExecutionOrderType
  volume: string
  price: string
  stopLimitPrice: string | null
  stopLoss: string
  takeProfit: string | null
  referencePrice: string
  expirationUtcMsc: number | null
}

export type DistributionOrderCommand = DistributionMarketOrderCommand | DistributionPendingOrderCommand

export interface CreateDistributionInput {
  actorUserId: number
  actorRole: string
  strategyId: string
  idempotencyKey: string
  command: DistributionOrderCommand
}

export interface NormalizedCreateDistributionInput extends Omit<CreateDistributionInput, 'command'> {
  command: DistributionOrderCommand
  requestHash: string
}

export interface CreateDistributionCloseInput {
  actorUserId: number
  actorRole: string
  sourceDistributionId: string
  idempotencyKey: string
  expectedRevision: number
  targetIds: string[]
}

export interface NormalizedCreateDistributionCloseInput extends Omit<CreateDistributionCloseInput, 'targetIds'> {
  targetIds: string[]
  requestHash: string
}

/**
 * Revisions are frozen at the point a distribution is accepted.  The fields
 * used by a child user command are the six server-side state revisions; the
 * subscription revision and snapshot keys remain separate audit evidence.
 */
export interface FrozenDistributionContext {
  strategy: { id: string; versionId: string }
  subscription: { id: string | null; revision: number | null; symbol: string; windowHash?: string }
  account: { id: string; currency: string; tradePermission: boolean }
  expected: UserExecutionExpectedRevisions
  snapshots: {
    account: string | null
    quote: string | null
    contract: string | null
    risk: string | null
  }
  source?: {
    outcomeId: string
    ticket: string
    sourceTargetId: string
  }
}

export interface DistributionTargetCandidate {
  /** Absent for historical targets; never backfilled from today's settings. */
  subscriptionWindowHash?: string
  subscriptionId: string
  userId: number
  accountId: string
  symbol: string
  subscriptionRevision: number
  traderStrategyId: string
  traderStrategyVersionId: string
  accountCurrency: string
  tradePermission: boolean
  accountRevision: number
  positionsRevision: number
  pendingOrdersRevision: number
  quoteRevision: number
  contractRevision: number
  riskRevision: number
  accountSnapshotId: string | null
  quoteSnapshotId: string | null
  contractSnapshotId: string | null
  riskSnapshotId: string | null
}

export interface DistributionPreviewTarget {
  accountId: string
  subscriptionId: string
  tradePermission: boolean
  ready: boolean
  missingResources: Array<'account' | 'positions' | 'pending_orders' | 'quote' | 'contract' | 'risk'>
}

export interface ExecutionDistributionPreview {
  strategyId: string
  strategyVersionId: string
  strategyRevision: number
  symbol: string
  targetCount: number
  targets: DistributionPreviewTarget[]
}

export interface FrozenDistributionTarget extends DistributionTargetCandidate {
  id: string
  distributionId: string
  sourceOutcomeId: string | null
  sourceTicket: string | null
  childOperationId: string | null
  requestHash: string
  frozenContext: FrozenDistributionContext
  status: DistributionTargetStatus
  errorCode: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  revision: number
}

export interface ExactDistributionOutcome {
  targetId: string
  outcomeId: string
  ticket: string
  resourceKind: 'position'
  status: 'succeeded'
  outcomeRevision?: number
}

export interface ExecutionDistribution {
  id: string
  operationId: string
  actorUserId: number
  strategyId: string
  strategyVersionId: string
  kind: DistributionKind
  sourceDistributionId: string | null
  idempotencyKey: string
  requestHash: string
  command: ExecutionJsonObject
  status: DistributionStatus
  targetCount: number
  resultSummary: ExecutionJsonObject
  createdAt: string
  updatedAt: string
  completedAt: string | null
  revision: number
}

export interface ExecutionDistributionResult {
  operation: Operation
  distribution: ExecutionDistribution
  targets: FrozenDistributionTarget[]
}

export interface DistributionIdempotencyMatch {
  requestHash: string
  result: ExecutionDistributionResult
}

export class ExecutionDistributionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details: ExecutionJsonObject = {},
  ) {
    super(code)
    this.name = 'ExecutionDistributionError'
  }
}

const opaquePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/
const idempotencyPattern = /^[A-Za-z0-9._:-]{8,128}$/
const symbolPattern = /^[A-Z0-9._-]{1,64}$/
const orderTypes = new Set<string>(['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'])

export function normalizeCreateDistributionInput(input: CreateDistributionInput): NormalizedCreateDistributionInput {
  if (!input || typeof input !== 'object') throw distributionError('distribution_input_invalid', 422)
  const actorUserId = userId(input.actorUserId)
  const actorRole = String(input.actorRole ?? '').trim()
  if (!actorRole) throw distributionError('distribution_actor_role_required', 403)
  const strategyId = opaque(input.strategyId, 'distribution_strategy_id_invalid')
  const idempotencyKey = idempotency(input.idempotencyKey)
  const command = normalizeOrderCommand(input.command)
  const requestHash = sha256Canonical({ actorUserId, strategyId, command })
  return { actorUserId, actorRole, strategyId, idempotencyKey, command, requestHash }
}

export function normalizeDistributionPreviewInput(input: { actorUserId: number; actorRole: string; strategyId: string; symbol: string }) {
  const actorUserId = userId(input.actorUserId)
  const actorRole = String(input.actorRole ?? '').trim()
  if (!actorRole) throw distributionError('distribution_actor_role_required', 403)
  return {
    actorUserId,
    actorRole,
    strategyId: opaque(input.strategyId, 'distribution_strategy_id_invalid'),
    symbol: normalizeSymbol(input.symbol),
  }
}

export function normalizeCreateDistributionCloseInput(input: CreateDistributionCloseInput): NormalizedCreateDistributionCloseInput {
  if (!input || typeof input !== 'object') throw distributionError('distribution_close_input_invalid', 422)
  const actorUserId = userId(input.actorUserId)
  const actorRole = String(input.actorRole ?? '').trim()
  if (!actorRole) throw distributionError('distribution_actor_role_required', 403)
  const sourceDistributionId = opaque(input.sourceDistributionId, 'distribution_source_id_invalid')
  const idempotencyKey = idempotency(input.idempotencyKey)
  const expectedRevision = positiveRevision(input.expectedRevision, 'distribution_revision_invalid')
  if (!Array.isArray(input.targetIds) || input.targetIds.length > 10_000) throw distributionError('distribution_target_ids_invalid', 422)
  const targetIds = input.targetIds.map((value) => opaque(value, 'distribution_target_id_invalid'))
  if (new Set(targetIds).size !== targetIds.length) throw distributionError('distribution_target_ids_duplicate', 422)
  const requestHash = sha256Canonical({ actorUserId, sourceDistributionId, expectedRevision, targetIds })
  return { actorUserId, actorRole, sourceDistributionId, idempotencyKey, expectedRevision, targetIds, requestHash }
}

export function freezeDistributionTarget(candidate: DistributionTargetCandidate, distributionId: string, targetId: string, now: string, command: ExecutionJsonObject, source?: { outcomeId: string; ticket: string; sourceTargetId: string }): FrozenDistributionTarget {
  const frozenContext: FrozenDistributionContext = {
    strategy: { id: candidate.traderStrategyId, versionId: candidate.traderStrategyVersionId },
    subscription: { id: candidate.subscriptionId, revision: candidate.subscriptionRevision, symbol: candidate.symbol,
      ...(candidate.subscriptionWindowHash ? { windowHash: candidate.subscriptionWindowHash } : {}) },
    account: { id: candidate.accountId, currency: candidate.accountCurrency, tradePermission: candidate.tradePermission },
    expected: {
      accountRevision: candidate.accountRevision,
      positionsRevision: candidate.positionsRevision,
      pendingOrdersRevision: candidate.pendingOrdersRevision,
      quoteRevision: candidate.quoteRevision,
      contractRevision: candidate.contractRevision,
      riskRevision: candidate.riskRevision,
      resourceRevision: null,
    },
    snapshots: {
      account: candidate.accountSnapshotId,
      quote: candidate.quoteSnapshotId,
      contract: candidate.contractSnapshotId,
      risk: candidate.riskSnapshotId,
    },
  }
  if (source) frozenContext.source = source
  const sourceOutcomeId = source?.outcomeId ?? null
  const sourceTicket = source?.ticket ?? null
  return {
    ...candidate,
    id: targetId,
    distributionId,
    sourceOutcomeId,
    sourceTicket,
    childOperationId: null,
    requestHash: sha256Canonical({ distributionId, targetId, command, frozenContext, sourceOutcomeId, sourceTicket }),
    frozenContext,
    status: 'queued',
    errorCode: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    revision: 1,
  }
}

/**
 * Freeze exactly the subscriptions eligible at acceptance time.  No target is
 * silently dropped because a read projection is incomplete: those facts are
 * retained in the frozen context and the account command will fail closed
 * during its own deterministic server-side review.
 */
export function freezeEligibleDistributionTargets(candidates: DistributionTargetCandidate[], strategyId: string, strategyVersionId: string, symbol: string, distributionId: string, command: ExecutionJsonObject, now: string, idFactory: () => string): FrozenDistributionTarget[] {
  const normalizedSymbol = normalizeSymbol(symbol)
  const eligible = candidates
    .filter((candidate) => candidate.traderStrategyId === strategyId
      && candidate.traderStrategyVersionId === strategyVersionId
      && candidate.symbol === normalizedSymbol)
    .sort((left, right) => left.accountId.localeCompare(right.accountId) || left.subscriptionId.localeCompare(right.subscriptionId))
  const uniqueAccounts = eligible.filter((candidate, index) => index === 0 || eligible[index - 1]?.accountId !== candidate.accountId)
  return uniqueAccounts.map((candidate) => freezeDistributionTarget(candidate, distributionId, idFactory(), now, command))
}

/**
 * Select close targets by immutable source outcome identity.  Ticket and
 * target IDs are never inferred from a symbol or a strategy name.  If the
 * caller supplied IDs, every one must resolve to an attributable succeeded
 * position outcome; otherwise the whole request is rejected before any row
 * is created.
 */
export function selectExactDistributionCloseTargets(outcomes: ExactDistributionOutcome[], requestedTargetIds: string[]): ExactDistributionOutcome[] {
  const eligible = new Map<string, ExactDistributionOutcome>()
  for (const outcome of outcomes) {
    if (outcome.resourceKind !== 'position' || outcome.status !== 'succeeded' || !opaquePattern.test(outcome.outcomeId) || !opaquePattern.test(outcome.targetId) || !String(outcome.ticket).trim()) continue
    if (!eligible.has(outcome.targetId)) eligible.set(outcome.targetId, { ...outcome, ticket: String(outcome.ticket).trim() })
  }
  if (requestedTargetIds.length === 0) return [...eligible.values()].sort(compareExactTarget)
  const requested = requestedTargetIds.map((id) => String(id).trim())
  const selected = requested.map((targetId) => eligible.get(targetId))
  if (selected.some((value) => !value)) throw distributionError('distribution_close_target_not_attributable', 409)
  return selected as ExactDistributionOutcome[]
}

export function distributionCommandAsUserCommand(command: DistributionOrderCommand, target: FrozenDistributionTarget, parentOperationId: string, distributionId: string, idempotencyKey: string): UserExecutionCommandInput {
  const base = {
    userId: target.userId,
    accountId: target.accountId,
    idempotencyKey,
    expected: target.frozenContext.expected,
    sourceType: 'strategy_distribution' as const,
    sourceId: target.id,
    parentOperationId,
    distributionId,
  }
  if (command.commandType === 'market_order') return {
    ...base,
    commandType: 'market_order',
    parameters: {
      symbol: command.symbol,
      side: command.side,
      volume: command.volume,
      stopLoss: command.stopLoss,
      takeProfit: command.takeProfit,
      referencePrice: command.referencePrice,
      comment: null,
    },
  }
  return {
    ...base,
    commandType: 'pending_order',
    parameters: {
      symbol: command.symbol,
      orderType: command.orderType,
      volume: command.volume,
      price: command.price,
      stopLimitPrice: command.stopLimitPrice,
      stopLoss: command.stopLoss,
      takeProfit: command.takeProfit,
      referencePrice: command.referencePrice,
      expirationUtcMsc: command.expirationUtcMsc,
      comment: null,
    },
  }
}

export function distributionCloseAsUserCommand(target: FrozenDistributionTarget, parentOperationId: string, distributionId: string, idempotencyKey: string, volume: string | null = null): UserExecutionCommandInput {
  const source = target.frozenContext.source
  if (!source) throw distributionError('distribution_close_source_missing', 409)
  return {
    userId: target.userId,
    accountId: target.accountId,
    commandType: 'close_position',
    idempotencyKey,
    expected: target.frozenContext.expected,
    parameters: { ticket: source.ticket, volume },
    sourceType: 'distribution_close',
    sourceId: target.id,
    parentOperationId,
    distributionId,
  }
}

function normalizeOrderCommand(value: DistributionOrderCommand): DistributionOrderCommand {
  if (!value || typeof value !== 'object') throw distributionError('distribution_command_required', 422)
  if (value.commandType === 'market_order') return {
    commandType: 'market_order', symbol: normalizeSymbol(value.symbol), side: normalizeSide(value.side),
    volume: positiveDecimal(value.volume, 'distribution_volume_invalid'), stopLoss: positiveDecimal(value.stopLoss, 'distribution_stop_loss_invalid'),
    takeProfit: nullableDecimal(value.takeProfit, 'distribution_take_profit_invalid'), referencePrice: positiveDecimal(value.referencePrice, 'distribution_reference_price_invalid'),
  }
  if (value.commandType === 'pending_order') {
    const orderType = String(value.orderType ?? '').trim() as UserExecutionOrderType
    if (!orderTypes.has(orderType)) throw distributionError('distribution_order_type_invalid', 422)
    return {
      commandType: 'pending_order', orderType, symbol: normalizeSymbol(value.symbol),
      volume: positiveDecimal(value.volume, 'distribution_volume_invalid'), price: positiveDecimal(value.price, 'distribution_price_invalid'),
      stopLimitPrice: nullableDecimal(value.stopLimitPrice, 'distribution_stop_limit_price_invalid'), stopLoss: positiveDecimal(value.stopLoss, 'distribution_stop_loss_invalid'),
      takeProfit: nullableDecimal(value.takeProfit, 'distribution_take_profit_invalid'), referencePrice: positiveDecimal(value.referencePrice, 'distribution_reference_price_invalid'),
      expirationUtcMsc: nullableEpochMsc(value.expirationUtcMsc),
    }
  }
  throw distributionError('distribution_command_type_invalid', 422)
}

function compareExactTarget(left: ExactDistributionOutcome, right: ExactDistributionOutcome) { return left.targetId.localeCompare(right.targetId) || left.outcomeId.localeCompare(right.outcomeId) }
function normalizeSymbol(value: unknown) { const normalized = String(value ?? '').trim().toUpperCase(); if (!symbolPattern.test(normalized)) throw distributionError('distribution_symbol_invalid', 422); return normalized }
function normalizeSide(value: unknown): 'buy' | 'sell' { if (value !== 'buy' && value !== 'sell') throw distributionError('distribution_side_invalid', 422); return value }
function positiveDecimal(value: unknown, code: string) { const normalized = String(value ?? '').trim(); const number = Number(normalized); if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized) || !Number.isFinite(number) || number <= 0) throw distributionError(code, 422); return normalized }
function nullableDecimal(value: unknown, code: string) { if (value === undefined || value === null || value === '') return null; return positiveDecimal(value, code) }
function nullableEpochMsc(value: unknown) { if (value === undefined || value === null) return null; const number = typeof value === 'number' ? value : Number(String(value).trim()); if (!Number.isSafeInteger(number) || number <= 0) throw distributionError('distribution_expiration_invalid', 422); return number }
function opaque(value: unknown, code: string) { const normalized = String(value ?? '').trim(); if (!opaquePattern.test(normalized)) throw distributionError(code, 422); return normalized }
function idempotency(value: unknown) { const normalized = String(value ?? '').trim(); if (!idempotencyPattern.test(normalized)) throw distributionError('distribution_idempotency_key_invalid', 422); return normalized }
function userId(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 1) throw distributionError('distribution_actor_invalid', 422); return Number(value) }
function positiveRevision(value: unknown, code: string) { const number = typeof value === 'number' ? value : Number(String(value ?? '').trim()); if (!Number.isSafeInteger(number) || number < 1) throw distributionError(code, 422); return number }
function distributionError(code: string, status: number, details: ExecutionJsonObject = {}) { return new ExecutionDistributionError(code, status, details) }
