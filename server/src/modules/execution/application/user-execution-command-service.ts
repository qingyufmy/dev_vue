import { randomUUID } from 'node:crypto'
import { evaluateRisk, type RiskEvaluationInput } from '../../risk/domain/risk.js'
import type { TraderAction, TraderDecisionResult } from '../../inference/domain/inference.js'
import {
  buildPreparedUserExecutionBundle,
  buildRejectedUserExecutionResult,
  normalizeUserExecutionCommand,
  UserExecutionCommandError,
  userCommandAction,
  type PreparedUserExecutionBundle,
  type UserExecutionCommandInput,
  type UserExecutionCommandResult,
  type UserExecutionExpectedRevisions,
  type NormalizedUserExecutionCommand,
  type ModifyPositionParameters,
  type ModifyOrderParameters,
  type ClosePositionParameters,
} from '../domain/user-execution-command.js'
import type {
  UserExecutionCommandContext,
  UserExecutionCommandRepository,
  UserExecutionRiskEvaluator,
} from './user-execution-command-ports.js'

const USER_COMMAND_RISK_REVISIONS: Array<keyof RiskEvaluationInput['currentRevisions']> = [
  'account', 'positions', 'pendingOrders', 'quote', 'contract', 'risk',
]

/**
 * Application boundary for authenticated single-account execution commands.
 *
 * This service performs validation and deterministic risk evaluation only.  It
 * never invokes Bridge or a terminal; the returned result is handed to the
 * execution preparation/dispatch workers by the composition root.
 */
export class UserExecutionCommandService {
  constructor(
    private readonly repository: UserExecutionCommandRepository,
    private readonly riskEvaluator: UserExecutionRiskEvaluator = { evaluate: evaluateRisk },
  ) {}

  async execute(input: UserExecutionCommandInput, now = new Date()): Promise<UserExecutionCommandResult> {
    assertDate(now)
    // The ID is generated before hashing only as the default user-command
    // source ID.  userExecutionRequestHash deliberately ignores that generated
    // value for the normal single-account source, preserving replay semantics.
    const command = normalizeUserExecutionCommand(input, randomUUID())
    const existing = await this.repository.findByIdempotency({
      userId: command.userId,
      accountId: command.accountId,
      idempotencyKey: command.idempotencyKey,
    })
    if (existing) {
      if (existing.requestHash !== command.requestHash) throw new UserExecutionCommandError('idempotency_conflict', 409)
      if (!existing.result) throw new UserExecutionCommandError('user_command_idempotency_replay_unavailable', 503)
      return existing.result
    }

    const ticket = commandTargetTicket(command)
    const symbol = commandTargetSymbol(command)
    const context = await this.repository.loadContext({ userId: command.userId, accountId: command.accountId, symbol, ticket })
    if (!context) throw new UserExecutionCommandError('user_command_account_forbidden', 403)
    assertAccess(command, context)
    assertCurrentRevisions(command.expected, context.currentRevisions)
    assertTargetRevision(command, context)
    if (symbol && (context.quote.symbol !== symbol || context.instrument.symbol !== symbol)) {
      throw new UserExecutionCommandError('user_command_symbol_context_mismatch', 409)
    }

    const action = userCommandAction(command)
    const riskAction = riskActionFor(command, action, context)
    const riskInput = riskInputFor(command, riskAction, context, now)
    const riskEvaluation = this.riskEvaluator.evaluate(riskInput, now)
    if (riskEvaluation.status === 'rejected') {
      // Syntax-valid commands that reached deterministic risk are persisted as
      // terminal rejected operations for audit/idempotent replay.  No intent or
      // reservation is created in this branch.
      const rejected = buildRejectedUserExecutionResult({ command, riskEvaluation, operationId: randomUUID(), now })
      return this.repository.persistCommand({ command, action, riskEvaluation, result: rejected, expected: command.expected })
    }
    const normalizedRiskEvaluation = riskAction === action
      ? riskEvaluation
      : { ...riskEvaluation, approvedActions: riskEvaluation.approvedActions.map(() => action) }
    const prepared = buildPreparedUserExecutionBundle({
      command,
      action,
      riskEvaluation: normalizedRiskEvaluation,
      accountCurrency: context.accountCurrency,
      operationId: randomUUID(),
      intentId: randomUUID(),
      now,
    })
    return this.repository.persistCommand({ command, action, riskEvaluation: normalizedRiskEvaluation, result: prepared, expected: command.expected })
  }
}

/**
 * Generic evaluateRisk intentionally rejects arbitrary modification actions.
 * User commands may still tighten protection, but only after an explicit
 * current-snapshot diff proves the operation reduces exposure.  The probe adds
 * a conservative stop-loss field solely for the generic evaluator; the
 * persisted action remains the original user action.
 */
function riskActionFor(command: NormalizedUserExecutionCommand, action: TraderAction, context: UserExecutionCommandContext): TraderAction {
  if (command.commandType === 'close_position' || command.commandType === 'cancel_order' || command.commandType === 'market_order' || command.commandType === 'pending_order') {
    if (command.commandType === 'close_position') validateCloseVolume(command, context)
    return action
  }
  if (command.commandType === 'modify_position') {
    const parameters = command.parameters as ModifyPositionParameters
    const position = context.positions.find(item => String(item.ticket ?? '') === parameters.ticket)
    if (!position) throw new UserExecutionCommandError('user_command_target_not_found', 409, { ticket: parameters.ticket })
    return action
  }
  const parameters = command.parameters as ModifyOrderParameters
  const order = context.pendingOrders.find(item => String(item.ticket ?? '') === parameters.ticket)
  if (!order) throw new UserExecutionCommandError('user_command_target_not_found', 409, { ticket: parameters.ticket })
  return action
}

function validateCloseVolume(command: NormalizedUserExecutionCommand, context: UserExecutionCommandContext) {
  const parameters = command.parameters as ClosePositionParameters
  if (command.commandType !== 'close_position' || parameters.volume === null) return
  const position = context.positions.find(item => String(item.ticket ?? '') === parameters.ticket)
  const currentVolume = position ? numberFrom(position.volume) : null
  const requested = numberFrom(parameters.volume)
  if (currentVolume === null || requested === null || requested > currentVolume) throw new UserExecutionCommandError('user_command_close_volume_invalid', 422)
}

function numberFrom(value: unknown) { const result = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(result) ? result : null }

function riskInputFor(command: NormalizedUserExecutionCommand, action: TraderAction, context: UserExecutionCommandContext, now: Date): RiskEvaluationInput {
  const result: TraderDecisionResult = {
    action: action.kind,
    side: actionSide(action),
    confidence: 100,
    summary: '用户发起的交易命令',
    actions: [action],
    reasoning: '该命令由用户直接发起，已进入服务端确定性风控校验。',
  }
  return {
    decisionId: command.commandId,
    decisionRevision: 1,
    decisionCreatedAt: now.toISOString(),
    decisionStatus: 'proposed',
    result,
    policy: context.policy,
    summary: context.summary,
    quote: context.quote,
    instrument: context.instrument,
    positions: context.positions,
    pendingOrders: context.pendingOrders,
    manualRelease: context.manualRelease,
    currentRevisions: context.currentRevisions,
    requiredRevisionKeys: USER_COMMAND_RISK_REVISIONS,
  }
}

function actionSide(action: TraderAction): 'buy' | 'sell' | null {
  const side = action.parameters.side
  if (side === 'buy' || side === 'sell') return side
  const type = action.parameters.type
  if (typeof type === 'string' && type.startsWith('buy')) return 'buy'
  if (typeof type === 'string' && type.startsWith('sell')) return 'sell'
  return null
}

function commandTargetTicket(command: NormalizedUserExecutionCommand) {
  if ('ticket' in command.parameters) return command.parameters.ticket
  return null
}

function commandTargetSymbol(command: NormalizedUserExecutionCommand) {
  if ('symbol' in command.parameters) return command.parameters.symbol
  return null
}

function assertAccess(command: NormalizedUserExecutionCommand, context: UserExecutionCommandContext) {
  if (context.userId !== command.userId || context.accountId !== command.accountId || !context.owned) {
    throw new UserExecutionCommandError('user_command_account_forbidden', 403)
  }
  if (context.observer) throw new UserExecutionCommandError('user_command_observer_forbidden', 403)
  if (!context.tradePermission) throw new UserExecutionCommandError('user_command_trade_permission_required', 409)
}

function assertCurrentRevisions(expected: UserExecutionExpectedRevisions, current: UserExecutionCommandContext['currentRevisions']) {
  const checks: Array<[keyof UserExecutionExpectedRevisions, number]> = [
    ['accountRevision', current.account], ['positionsRevision', current.positions], ['pendingOrdersRevision', current.pendingOrders],
    ['quoteRevision', current.quote], ['contractRevision', current.contract], ['riskRevision', current.risk],
  ]
  for (const [key, actual] of checks) {
    if (expected[key] !== actual) throw new UserExecutionCommandError('user_command_expected_state_stale', 409, { resource: key.replace(/Revision$/, '') })
  }
}

function assertTargetRevision(command: NormalizedUserExecutionCommand, context: UserExecutionCommandContext) {
  const ticket = commandTargetTicket(command)
  if (!ticket) return
  const inventory = command.commandType === 'modify_position' || command.commandType === 'close_position' ? context.positions : context.pendingOrders
  const item = inventory.find(candidate => String(candidate.ticket ?? '') === ticket)
  if (!item) throw new UserExecutionCommandError('user_command_target_not_found', 409, { ticket })
  const actual = Number(item.revision)
  if (!Number.isSafeInteger(actual) || actual !== command.expected.resourceRevision) throw new UserExecutionCommandError('user_command_target_stale', 409, { ticket })
}

function assertDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new UserExecutionCommandError('user_command_time_invalid', 422)
}
