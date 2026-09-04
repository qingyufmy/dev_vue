import type { JsonObject, TraderAction, TraderExecutableActionKind } from '../../inference/domain/inference.js'
import type { RiskEvaluationResult } from '../../risk/domain/risk.js'
import type { ExecutionIntentStatus, ExecutionOperationStatus, RiskReservationStatus } from './execution.js'
import { sha256Canonical } from './execution.js'

/**
 * Commands accepted from the authenticated trading UI.
 *
 * This is deliberately a small command vocabulary.  A command is converted to
 * the same TraderAction shape used by the automated path, but it never invents
 * an AI trade/risk decision.  The user-command source remains explicit all the
 * way through persistence so that the execution worker can apply the same
 * Bridge lifecycle without weakening the AI lineage rules.
 */
export const USER_EXECUTION_COMMAND_TYPES = [
  'market_order', 'pending_order', 'modify_position', 'close_position', 'modify_order', 'cancel_order',
] as const
export type UserExecutionCommandType = typeof USER_EXECUTION_COMMAND_TYPES[number]

export type UserExecutionOrderType =
  | 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop' | 'buy_stop_limit' | 'sell_stop_limit'

export interface UserExecutionExpectedRevisions {
  accountRevision: number
  positionsRevision: number
  pendingOrdersRevision: number
  quoteRevision: number
  contractRevision: number
  riskRevision: number
  /** The exact position/order revision for a resource command; null for opens. */
  resourceRevision: number | null
}

export interface MarketOrderParameters {
  symbol: string
  side: 'buy' | 'sell'
  volume: string
  stopLoss: string
  takeProfit: string | null
  referencePrice: string
  comment: string | null
}

export interface PendingOrderParameters {
  symbol: string
  orderType: UserExecutionOrderType
  volume: string
  price: string
  stopLimitPrice: string | null
  stopLoss: string
  takeProfit: string | null
  referencePrice: string
  expirationUtcMsc: number | null
  comment: string | null
}

export interface ModifyPositionParameters {
  ticket: string
  stopLoss: string | null
  takeProfit: string | null
  removeStopLoss: boolean
  removeTakeProfit: boolean
}

export interface ClosePositionParameters {
  ticket: string
  volume: string | null
}

export interface ModifyOrderParameters {
  ticket: string
  price: string | null
  volume: string | null
  stopLimitPrice: string | null
  stopLoss: string | null
  takeProfit: string | null
  removeStopLoss: boolean
  removeTakeProfit: boolean
  removeExpiration: boolean
  expirationUtcMsc: number | null
}

export interface CancelOrderParameters { ticket: string }

export type UserExecutionCommandParameters =
  | MarketOrderParameters
  | PendingOrderParameters
  | ModifyPositionParameters
  | ClosePositionParameters
  | ModifyOrderParameters
  | CancelOrderParameters

export interface UserExecutionCommandInput {
  userId: number
  accountId: string
  commandType: UserExecutionCommandType
  idempotencyKey: string
  expected: UserExecutionExpectedRevisions
  parameters: UserExecutionCommandParameters
  sourceType?: UserExecutionCommandSourceType
  sourceId?: string
  parentOperationId?: string | null
  distributionId?: string | null
}

export interface NormalizedUserExecutionCommand extends UserExecutionCommandInput {
  commandId: string
  requestHash: string
  sourceType: UserExecutionCommandSourceType
  sourceId: string
  parentOperationId: string | null
  distributionId: string | null
}

export type UserExecutionCommandSourceType = 'user_command' | 'strategy_distribution' | 'distribution_close'
export type UserExecutionCommandIdempotencyScope = 'user_command'

export interface UserExecutionOperation {
  id: string
  userId: number
  accountId: string
  kind: 'user_execution_command'
  status: ExecutionOperationStatus
  sourceType: UserExecutionCommandSourceType
  sourceId: string
  parentOperationId: string | null
  distributionId: string | null
  idempotencyScope: UserExecutionCommandIdempotencyScope
  /** Client key is scoped to user+account in the command audit table. */
  clientIdempotencyKey: string
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

export interface UserExecutionIntent {
  id: string
  operationId: string
  /** User commands have no AI decision foreign key. */
  riskDecisionId: null
  /** User commands have no AI trader decision foreign key. */
  tradeDecisionId: null
  userId: number
  accountId: string
  actionId: string
  actionKind: TraderExecutableActionKind
  action: TraderAction
  sourceType: UserExecutionCommandSourceType
  sourceId: string
  parentOperationId: string | null
  distributionId: string | null
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

export interface UserExecutionRiskReservation {
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

export interface PreparedUserExecutionBundle {
  kind: 'prepared'
  command: NormalizedUserExecutionCommand
  sourceHash: string
  operation: UserExecutionOperation
  intent: UserExecutionIntent
  reservations: UserExecutionRiskReservation[]
  riskEvaluation: RiskEvaluationResult
}

export interface RejectedUserExecutionCommandResult {
  kind: 'rejected'
  command: NormalizedUserExecutionCommand
  sourceHash: string
  operation: UserExecutionOperation
  intent: null
  reservations: []
  riskEvaluation: RiskEvaluationResult
}

export type UserExecutionCommandResult = PreparedUserExecutionBundle | RejectedUserExecutionCommandResult

export class UserExecutionCommandError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details: JsonObject = {},
  ) {
    super(code)
    this.name = 'UserExecutionCommandError'
  }
}

const commandTypes = new Set<string>(USER_EXECUTION_COMMAND_TYPES)
const orderTypes = new Set<string>(['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'])

/**
 * Normalize and validate the user input before any repository access.  The
 * normalized request is also the canonical idempotency hash input.
 */
export function normalizeUserExecutionCommand(input: UserExecutionCommandInput, commandId: string): NormalizedUserExecutionCommand {
  if (!input || typeof input !== 'object') throw commandError('user_command_invalid', 422)
  if (!Number.isSafeInteger(input.userId) || input.userId < 1) throw commandError('user_command_user_invalid', 422)
  const accountId = opaque(input.accountId, 'user_command_account_invalid')
  const commandType = String(input.commandType ?? '').trim() as UserExecutionCommandType
  if (!commandTypes.has(commandType)) throw commandError('user_command_type_invalid', 422)
  const idempotencyKey = String(input.idempotencyKey ?? '').trim()
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw commandError('user_command_idempotency_key_invalid', 422)
  const sourceType = normalizeSourceType(input.sourceType)
  const normalizedCommandId = opaque(commandId, 'user_command_id_invalid')
  const sourceId = input.sourceId === undefined ? normalizedCommandId : opaque(input.sourceId, 'user_command_source_id_invalid')
  const parentOperationId = nullableOpaque(input.parentOperationId, 'user_command_parent_operation_invalid')
  const distributionId = nullableOpaque(input.distributionId, 'user_command_distribution_invalid')
  if (sourceType !== 'user_command' && (!input.sourceId || !parentOperationId || !distributionId)) throw commandError('user_command_distribution_context_required', 422)
  const expected = normalizeExpected(input.expected, commandType)
  const parameters = normalizeParameters(commandType, input.parameters)
  const normalized = { userId: input.userId, accountId, commandType, idempotencyKey, expected, parameters, commandId: normalizedCommandId, requestHash: '', sourceType, sourceId, parentOperationId, distributionId }
  normalized.requestHash = userExecutionRequestHash(normalized)
  return normalized
}

/** Convert the normalized command into the shared immutable TraderAction contract. */
export function userCommandAction(command: NormalizedUserExecutionCommand): TraderAction {
  const expectedState: JsonObject = {
    // Manual commands do not bind an AI analysis/subscription revision.  The
    // risk adapter explicitly narrows requiredRevisionKeys to the six values
    // captured below; zero is never treated as an authoritative AI revision.
    analysisRevision: 0,
    subscriptionRevision: 0,
    accountRevision: command.expected.accountRevision,
    positionsRevision: command.expected.positionsRevision,
    pendingOrdersRevision: command.expected.pendingOrdersRevision,
    quoteRevision: command.expected.quoteRevision,
    contractRevision: command.expected.contractRevision,
    riskRevision: command.expected.riskRevision,
  }
  const parameters = commandParametersForAction(command)
  return { actionId: `user-command:${command.commandId}`, kind: command.commandType, parameters, expectedState }
}

/**
 * Build the operation/intent layer after deterministic risk evaluation passed.
 * No terminal, Bridge, database, or network call happens here.
 */
export function buildPreparedUserExecutionBundle(input: {
  command: NormalizedUserExecutionCommand
  action: TraderAction
  riskEvaluation: RiskEvaluationResult
  accountCurrency: string
  operationId: string
  intentId: string
  reservationId?: string
  now: Date
}): PreparedUserExecutionBundle {
  assertDate(input.now)
  const accountCurrency = String(input.accountCurrency ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(accountCurrency)) throw commandError('user_command_account_currency_invalid', 422)
  if (input.riskEvaluation.status !== 'approved' || input.riskEvaluation.approvedActions.length !== 1) {
    throw commandError('user_command_risk_not_approved', 409)
  }
  if (input.riskEvaluation.approvedActions[0]?.actionId !== input.action.actionId) {
    throw commandError('user_command_risk_action_mismatch', 409)
  }
  const operationId = opaque(input.operationId, 'user_command_operation_id_invalid')
  const intentId = opaque(input.intentId, 'user_command_intent_id_invalid')
  const createdAt = input.now.toISOString()
  const expiresAt = new Date(input.now.getTime() + 30_000).toISOString()
  const intentRequestHash = sha256Canonical({ command: input.command.requestHash, action: input.action })
  const reservation = reservationFor({ ...input, accountCurrency }, expiresAt, createdAt)
  const operation: UserExecutionOperation = {
    id: operationId,
    userId: input.command.userId,
    accountId: input.command.accountId,
    kind: 'user_execution_command',
    status: 'queued',
    sourceType: input.command.sourceType,
    sourceId: input.command.sourceId,
    parentOperationId: input.command.parentOperationId,
    distributionId: input.command.distributionId,
    idempotencyScope: 'user_command',
    clientIdempotencyKey: input.command.idempotencyKey,
    idempotencyKey: sha256Canonical({ userId: input.command.userId, accountId: input.command.accountId, idempotencyKey: input.command.idempotencyKey }),
    requestHash: input.command.requestHash,
    resourceType: 'execution_intent',
    resourceId: intentId,
    errorCode: null,
    acceptedAt: createdAt,
    updatedAt: createdAt,
    completedAt: null,
    revision: 1,
    intentIds: [intentId],
  }
  const intent: UserExecutionIntent = {
    id: intentId,
    operationId,
    riskDecisionId: null,
    tradeDecisionId: null,
    userId: input.command.userId,
    accountId: input.command.accountId,
    actionId: input.action.actionId,
    actionKind: input.action.kind,
    action: input.action,
    sourceType: input.command.sourceType,
    sourceId: input.command.sourceId,
    parentOperationId: input.command.parentOperationId,
    distributionId: input.command.distributionId,
    idempotencyKey: sha256Canonical({ source: input.command.idempotencyKey, command: input.command.requestHash }),
    requestHash: intentRequestHash,
    expectedStateHash: sha256Canonical(input.action.expectedState),
    status: 'prepared',
    expiresAt,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    errorCode: null,
    revision: 1,
    riskReservationId: reservation?.id ?? null,
  }
  return {
    kind: 'prepared', command: input.command, sourceHash: input.command.requestHash,
    operation, intent, reservations: reservation ? [reservation] : [], riskEvaluation: input.riskEvaluation,
  }
}

/**
 * Persist a deterministic risk rejection as a terminal operation.  The
 * operation is intentionally intent-less: a rejected command must remain
 * auditable without ever creating something a Bridge worker could dispatch.
 */
export function buildRejectedUserExecutionResult(input: {
  command: NormalizedUserExecutionCommand
  riskEvaluation: RiskEvaluationResult
  operationId: string
  now: Date
}): RejectedUserExecutionCommandResult {
  assertDate(input.now)
  if (input.riskEvaluation.status !== 'rejected' || input.riskEvaluation.approvedActions.length !== 0) throw commandError('user_command_rejection_mismatch', 409)
  const operationId = opaque(input.operationId, 'user_command_operation_id_invalid')
  const createdAt = input.now.toISOString()
  const reason = input.riskEvaluation.rejectCode ?? 'RISK_REJECTED'
  const operation: UserExecutionOperation = {
    id: operationId, userId: input.command.userId, accountId: input.command.accountId,
    kind: 'user_execution_command', status: 'rejected', sourceType: input.command.sourceType,
    sourceId: input.command.sourceId, parentOperationId: input.command.parentOperationId, distributionId: input.command.distributionId,
    idempotencyScope: 'user_command', clientIdempotencyKey: input.command.idempotencyKey,
    idempotencyKey: sha256Canonical({ userId: input.command.userId, accountId: input.command.accountId, idempotencyKey: input.command.idempotencyKey }), requestHash: input.command.requestHash,
    resourceType: 'execution_intent', resourceId: null, errorCode: reason,
    acceptedAt: createdAt, updatedAt: createdAt, completedAt: createdAt, revision: 1, intentIds: [],
  }
  return { kind: 'rejected', command: input.command, sourceHash: input.command.requestHash, operation, intent: null, reservations: [], riskEvaluation: input.riskEvaluation }
}

export function userExecutionRequestHash(command: Pick<NormalizedUserExecutionCommand, 'userId' | 'accountId' | 'commandType' | 'expected' | 'parameters' | 'sourceType' | 'sourceId' | 'parentOperationId' | 'distributionId'>) {
  return sha256Canonical({ userId: command.userId, accountId: command.accountId, commandType: command.commandType, expected: command.expected, parameters: command.parameters, sourceType: command.sourceType, sourceId: command.sourceType === 'user_command' ? null : command.sourceId, parentOperationId: command.parentOperationId, distributionId: command.distributionId })
}

function normalizeExpected(value: UserExecutionExpectedRevisions, commandType: UserExecutionCommandType): UserExecutionExpectedRevisions {
  if (!value || typeof value !== 'object') throw commandError('user_command_expected_state_required', 422)
  const expected = {
    accountRevision: revision(value.accountRevision, 'user_command_account_revision_invalid', 1),
    positionsRevision: revision(value.positionsRevision, 'user_command_positions_revision_invalid', 0),
    pendingOrdersRevision: revision(value.pendingOrdersRevision, 'user_command_pending_orders_revision_invalid', 0),
    quoteRevision: revision(value.quoteRevision, 'user_command_quote_revision_invalid', 1),
    contractRevision: revision(value.contractRevision, 'user_command_contract_revision_invalid', 1),
    riskRevision: revision(value.riskRevision, 'user_command_risk_revision_invalid', 1),
    resourceRevision: value.resourceRevision === null || value.resourceRevision === undefined
      ? null : revision(value.resourceRevision, 'user_command_resource_revision_invalid', 1),
  }
  const requiresResource = commandType === 'modify_position' || commandType === 'close_position' || commandType === 'modify_order' || commandType === 'cancel_order'
  if (requiresResource && expected.resourceRevision === null) throw commandError('user_command_resource_revision_required', 422)
  if (!requiresResource && expected.resourceRevision !== null) throw commandError('user_command_resource_revision_forbidden', 422)
  return expected
}

function normalizeParameters(commandType: UserExecutionCommandType, value: UserExecutionCommandParameters): UserExecutionCommandParameters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw commandError('user_command_parameters_required', 422)
  switch (commandType) {
    case 'market_order': {
      const source = value as Partial<MarketOrderParameters>
      return {
        symbol: symbol(source.symbol), side: side(source.side), volume: decimal(source.volume, 'user_command_volume_invalid'),
        stopLoss: decimal(source.stopLoss, 'user_command_stop_loss_required'),
        takeProfit: nullableDecimal(source.takeProfit, 'user_command_take_profit_invalid'),
        referencePrice: decimal(source.referencePrice, 'user_command_reference_price_required'),
        comment: nullableText(source.comment, 128),
      }
    }
    case 'pending_order': {
      const source = value as Partial<PendingOrderParameters>
      const orderType = String(source.orderType ?? '').trim() as UserExecutionOrderType
      if (!orderTypes.has(orderType)) throw commandError('user_command_order_type_invalid', 422)
      const expirationUtcMsc = nullableEpochMsc(source.expirationUtcMsc, 'user_command_expiration_invalid')
      return {
        symbol: symbol(source.symbol), orderType, volume: decimal(source.volume, 'user_command_volume_invalid'),
        price: decimal(source.price, 'user_command_price_required'), stopLimitPrice: nullableDecimal(source.stopLimitPrice, 'user_command_stop_limit_price_invalid'), stopLoss: decimal(source.stopLoss, 'user_command_stop_loss_required'),
        takeProfit: nullableDecimal(source.takeProfit, 'user_command_take_profit_invalid'),
        referencePrice: decimal(source.referencePrice, 'user_command_reference_price_required'), expirationUtcMsc,
        comment: nullableText(source.comment, 128),
      }
    }
    case 'modify_position': {
      const source = value as Partial<ModifyPositionParameters>
      const result = {
        ticket: ticket(source.ticket), stopLoss: nullableDecimal(source.stopLoss, 'user_command_stop_loss_invalid'),
        takeProfit: nullableDecimal(source.takeProfit, 'user_command_take_profit_invalid'),
        removeStopLoss: boolean(source.removeStopLoss), removeTakeProfit: boolean(source.removeTakeProfit),
      }
      if (result.stopLoss === null && result.takeProfit === null && !result.removeStopLoss && !result.removeTakeProfit) throw commandError('user_command_modification_required', 422)
      if (result.stopLoss !== null && result.removeStopLoss) throw commandError('user_command_stop_loss_conflict', 422)
      if (result.takeProfit !== null && result.removeTakeProfit) throw commandError('user_command_take_profit_conflict', 422)
      return result
    }
    case 'close_position': {
      const source = value as Partial<ClosePositionParameters>
      return { ticket: ticket(source.ticket), volume: nullableDecimal(source.volume, 'user_command_close_volume_invalid') }
    }
    case 'modify_order': {
      const source = value as Partial<ModifyOrderParameters>
      const result = {
        ticket: ticket(source.ticket), price: nullableDecimal(source.price, 'user_command_price_invalid'),
        volume: nullableDecimal(source.volume, 'user_command_volume_invalid'), stopLoss: nullableDecimal(source.stopLoss, 'user_command_stop_loss_invalid'),
        stopLimitPrice: nullableDecimal(source.stopLimitPrice, 'user_command_stop_limit_price_invalid'),
        takeProfit: nullableDecimal(source.takeProfit, 'user_command_take_profit_invalid'), removeStopLoss: boolean(source.removeStopLoss),
        removeTakeProfit: boolean(source.removeTakeProfit), removeExpiration: boolean(source.removeExpiration), expirationUtcMsc: nullableEpochMsc(source.expirationUtcMsc, 'user_command_expiration_invalid'),
      }
      if (result.price === null && result.volume === null && result.stopLoss === null && result.takeProfit === null
        && result.stopLimitPrice === null && !result.removeStopLoss && !result.removeTakeProfit && !result.removeExpiration && result.expirationUtcMsc === null) throw commandError('user_command_modification_required', 422)
      if (result.stopLoss !== null && result.removeStopLoss) throw commandError('user_command_stop_loss_conflict', 422)
      if (result.takeProfit !== null && result.removeTakeProfit) throw commandError('user_command_take_profit_conflict', 422)
      if (result.expirationUtcMsc !== null && result.removeExpiration) throw commandError('user_command_expiration_conflict', 422)
      return result
    }
    case 'cancel_order': {
      const source = value as Partial<CancelOrderParameters>
      return { ticket: ticket(source.ticket) }
    }
  }
}

function commandParametersForAction(command: NormalizedUserExecutionCommand): JsonObject {
  const p = command.parameters
  switch (command.commandType) {
    case 'market_order': {
      const parameters = p as MarketOrderParameters
      return compact({ symbol: parameters.symbol, side: parameters.side, volume: parameters.volume, stop_loss: parameters.stopLoss, take_profit: parameters.takeProfit, reference_price: parameters.referencePrice, comment: parameters.comment })
    }
    case 'pending_order': {
      const parameters = p as PendingOrderParameters
      return compact({ symbol: parameters.symbol, type: parameters.orderType, volume: parameters.volume, price: parameters.price, stop_limit_price: parameters.stopLimitPrice, stop_loss: parameters.stopLoss, take_profit: parameters.takeProfit, reference_price: parameters.referencePrice, expiration_utc_msc: parameters.expirationUtcMsc, comment: parameters.comment })
    }
    case 'modify_position': {
      const parameters = p as ModifyPositionParameters
      return compact({ ticket: parameters.ticket, stop_loss: parameters.stopLoss, take_profit: parameters.takeProfit, remove_stop_loss: parameters.removeStopLoss, remove_take_profit: parameters.removeTakeProfit, resource_revision: command.expected.resourceRevision })
    }
    case 'close_position': {
      const parameters = p as ClosePositionParameters
      return compact({ ticket: parameters.ticket, volume: parameters.volume, resource_revision: command.expected.resourceRevision })
    }
    case 'modify_order': {
      const parameters = p as ModifyOrderParameters
      return compact({ ticket: parameters.ticket, price: parameters.price, volume: parameters.volume, stop_limit_price: parameters.stopLimitPrice, stop_loss: parameters.stopLoss, take_profit: parameters.takeProfit, remove_stop_loss: parameters.removeStopLoss, remove_take_profit: parameters.removeTakeProfit, remove_expiration: parameters.removeExpiration, expiration_utc_msc: parameters.expirationUtcMsc, resource_revision: command.expected.resourceRevision })
    }
    case 'cancel_order': {
      const parameters = p as CancelOrderParameters
      return compact({ ticket: parameters.ticket, resource_revision: command.expected.resourceRevision })
    }
  }
}

function compact(value: Record<string, unknown>): JsonObject {
  const result: JsonObject = {}
  for (const [key, candidate] of Object.entries(value)) {
    if (candidate === undefined) continue
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') result[key] = candidate
  }
  return result
}

function reservationFor(input: { command: NormalizedUserExecutionCommand; intentId: string; reservationId?: string; riskEvaluation: RiskEvaluationResult; accountCurrency: string }, expiresAt: string, createdAt: string): UserExecutionRiskReservation | null {
  if (input.command.commandType !== 'market_order' && input.command.commandType !== 'pending_order') return null
  const action = input.riskEvaluation.approvedActions[0]
  const details = input.riskEvaluation.rules.find(rule => rule.code === 'RISK_ACTION_APPROVED' && rule.actionId === action?.actionId)?.details
  if (!details || typeof details !== 'object') throw commandError('user_command_risk_data_missing', 422)
  const riskAmount = positiveOrZero(details.risk_amount)
  const riskPercent = positiveOrZero(details.risk_percent)
  const volume = positive(details.volume)
  const symbol = typeof action?.parameters.symbol === 'string' ? action.parameters.symbol : ''
  if (riskAmount === null || riskPercent === null || volume === null || !symbol) throw commandError('user_command_risk_data_invalid', 422)
  const reservationId = input.reservationId ? opaque(input.reservationId, 'user_command_reservation_id_invalid') : stableId({ kind: 'reservation', intentId: input.intentId })
  return {
    id: reservationId, executionIntentId: input.intentId, userId: input.command.userId, accountId: input.command.accountId,
    symbol, accountCurrency: input.accountCurrency.trim().toUpperCase(), reservedVolume: volume, reservedRiskAmount: riskAmount, reservedRiskPercent: riskPercent,
    reservedOpenPositions: input.command.commandType === 'market_order' ? 1 : 0,
    reservedPendingOrders: input.command.commandType === 'pending_order' ? 1 : 0,
    reservedDailyOpens: 1, status: 'active', expiresAt, releasedAt: null, releaseReason: null,
    createdAt, updatedAt: createdAt, revision: 1,
  }
}

function stableId(seed: unknown) {
  const hash = sha256Canonical(seed)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${['8', '9', 'a', 'b'][Number.parseInt(hash[16]!, 16) % 4]}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function side(value: unknown): 'buy' | 'sell' {
  if (value !== 'buy' && value !== 'sell') throw commandError('user_command_side_invalid', 422)
  return value
}

function symbol(value: unknown) {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(normalized)) throw commandError('user_command_symbol_invalid', 422)
  return normalized
}

function ticket(value: unknown) { return opaque(value, 'user_command_ticket_invalid') }
function normalizeSourceType(value: unknown): UserExecutionCommandSourceType {
  const source = value === undefined || value === null || value === '' ? 'user_command' : String(value).trim()
  if (source !== 'user_command' && source !== 'strategy_distribution' && source !== 'distribution_close') throw commandError('user_command_source_type_invalid', 422)
  return source
}

function nullableOpaque(value: unknown, code: string) {
  return value === null || value === undefined || value === '' ? null : opaque(value, code)
}

function opaque(value: unknown, code: string) {
  const normalized = String(value ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(normalized)) throw commandError(code, 422)
  return normalized
}

function revision(value: unknown, code: string, minimum: number) {
  const normalized = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN
  if (!Number.isSafeInteger(normalized) || normalized < minimum) throw commandError(code, 422)
  return normalized
}

function decimal(value: unknown, code: string) {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim()))) throw commandError(code, 422)
  const normalized = String(value).trim()
  const number = Number(normalized)
  if (!Number.isFinite(number) || number <= 0) throw commandError(code, 422)
  return normalized
}

function nullableDecimal(value: unknown, code: string) {
  return value === null || value === undefined || value === '' ? null : decimal(value, code)
}

function nullableText(value: unknown, max: number) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.trim().length > max) throw commandError('user_command_comment_invalid', 422)
  return value.trim()
}

function nullableEpochMsc(value: unknown, code: string) {
  if (value === null || value === undefined || value === '') return null
  const normalized = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw commandError(code, 422)
  return normalized
}

function boolean(value: unknown) {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw commandError('user_command_boolean_invalid', 422)
  return value
}

function positive(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const result = Number(value)
  return Number.isFinite(result) && result > 0 ? result : null
}

function positiveOrZero(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const result = Number(value)
  return Number.isFinite(result) && result >= 0 ? result : null
}

function assertDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw commandError('user_command_time_invalid', 422)
}

function commandError(code: string, status: number, details: JsonObject = {}) {
  return new UserExecutionCommandError(code, status, details)
}
