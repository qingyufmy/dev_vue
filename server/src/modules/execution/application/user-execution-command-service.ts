import { userCommandTargetVersion } from '../domain/user-command-target-version.js'
import { matchesMarketSymbol, type InstrumentCollectionRequester } from '../../trading/index.js'
import { randomUUID } from 'node:crypto'
import { evaluateRisk, riskPolicyHash, type RiskEvaluationInput, type RiskEvaluationResult } from '../../risk/index.js'
import type { TraderAction, TraderDecisionResult } from '../../inference/index.js'
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
 * This service validates ownership, current snapshots and exact resource
 * versions. Strategy-originated commands receive deterministic risk review;
 * direct user commands record an explicit risk bypass. It never invokes Bridge
 * or a terminal; dispatch remains asynchronous.
 */
export class UserExecutionCommandService {
  constructor(
    private readonly repository: UserExecutionCommandRepository,
    private readonly riskEvaluator: UserExecutionRiskEvaluator = { evaluate: evaluateRisk },
    private readonly instrumentRequests?: InstrumentCollectionRequester,
    private readonly pause: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  ) {}

  async commandContext(input: { userId: number; accountId: string; symbol?: string | null; ticket?: string | null }) {
    if (!Number.isSafeInteger(input.userId) || input.userId < 1) throw new UserExecutionCommandError('user_command_user_invalid', 422)
    const accountId = String(input.accountId ?? '').trim()
    const symbol = input.symbol === undefined || input.symbol === null || input.symbol === '' ? null : String(input.symbol).trim()
    const ticket = input.ticket === undefined || input.ticket === null || input.ticket === '' ? null : String(input.ticket).trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(accountId)) throw new UserExecutionCommandError('user_command_account_invalid', 400)
    if (symbol !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(symbol)) throw new UserExecutionCommandError('user_command_symbol_invalid', 400)
    if (ticket !== null && !/^[0-9A-Za-z._:-]{1,64}$/.test(ticket)) throw new UserExecutionCommandError('user_command_ticket_invalid', 400)
    if (symbol === null && ticket === null) throw new UserExecutionCommandError('user_command_target_required', 400)
    let context = await this.repository.loadContext({ userId: input.userId, accountId, symbol, ticket })
    if (!context) throw new UserExecutionCommandError('user_command_account_not_found', 404)
    if (symbol !== null && context.instrument.revision === 0 && this.instrumentRequests) {
      await this.instrumentRequests.request({ userId: input.userId, accountId, symbol })
      for (let attempt = 0; attempt < 8 && context.instrument.revision === 0; attempt++) {
        await this.pause(250)
        const refreshed = await this.repository.loadContext({ userId: input.userId, accountId, symbol, ticket })
        if (!refreshed) throw new UserExecutionCommandError('user_command_account_not_found', 404)
        context = refreshed
      }
      if (context.instrument.revision === 0) throw new UserExecutionCommandError('user_command_instrument_refresh_incomplete', 503)
    }
    return { context, symbol, ticket }
  }

  async execute(input: UserExecutionCommandInput, now = new Date()): Promise<UserExecutionCommandResult> {
    assertDate(now)
    if (this.repository.withAccountTransaction) {
      const normalized = normalizeUserExecutionCommand(input, randomUUID())
      return this.repository.withAccountTransaction(normalized,
        repository => new UserExecutionCommandService(repository, this.riskEvaluator, this.instrumentRequests, this.pause).execute(input, now))
    }
    // A stale transaction rolls back before any command or outbox is committed.
    // Re-evaluate at most twice; never retry unknown outcomes or terminal operations.
    for (let attempt = 0; ; attempt++) {
      try { return await this.executeAttempt(input, now) }
      catch (error) {
        if (attempt >= 2 || !(error instanceof UserExecutionCommandError)
          || error.code !== 'user_command_expected_state_stale') throw error
      }
    }
  }

  private async executeAttempt(input: UserExecutionCommandInput, now: Date): Promise<UserExecutionCommandResult> {
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
    if (command.commandType === 'market_order' || command.commandType === 'pending_order') {
      // New orders have no existing ticket to protect. Evaluate the confirmed
      // parameters against the latest exposure, rather than freezing live data
      // for the time spent filling out the form. Contract changes still conflict.
      for (const key of ['account', 'positions', 'pendingOrders', 'quote', 'risk'] as const) {
        const current = context.currentRevisions[key]
        if (!Number.isSafeInteger(current) || current < command.expected[`${key}Revision`]) {
          throw new UserExecutionCommandError('user_command_expected_state_stale', 409, { resource: key })
        }
        command.expected[`${key}Revision`] = current
      }
    }
    const target = ticket ? (command.commandType === 'modify_position' || command.commandType === 'close_position'
      ? context.positions : context.pendingOrders).find(item => String(item.ticket) === ticket) : null
    if (target && command.expected.resourceRevision === userCommandTargetVersion(target)) {
      // The request hash remains the original client intent. Only the evaluated copy
      // binds current runtime revisions; persistence rechecks them under the account lock.
      for (const key of ['account', 'positions', 'pendingOrders', 'quote', 'contract', 'risk'] as const) {
        const current = context.currentRevisions[key]
        if (!Number.isSafeInteger(current) || current < command.expected[`${key}Revision`]) {
          throw new UserExecutionCommandError('user_command_expected_state_stale', 409, { resource: key })
        }
        command.expected[`${key}Revision`] = current
      }
      command.expected.resourceRevision = Number(target.revision)
    }
    assertCurrentRevisions(command.expected, context.currentRevisions)
    assertTargetRevision(command, context)
    if (symbol && (!matchesMarketSymbol(context.quote.symbol, symbol) || !matchesMarketSymbol(context.instrument.symbol, symbol))) {
      throw new UserExecutionCommandError('user_command_symbol_context_mismatch', 409)
    }

    const action = userCommandAction(command)
    const riskAction = riskActionFor(command, action, context)
    const riskInput = riskInputFor(command, riskAction, context, now)
    const riskEvaluation = command.sourceType === 'user_command'
      ? manualCommandEvaluation(action, context, now)
      : this.riskEvaluator.evaluate(riskInput, now)
    if (riskEvaluation.status === 'rejected') {
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

function manualCommandEvaluation(action: TraderAction, context: UserExecutionCommandContext, now: Date): RiskEvaluationResult {
  return {
    status: 'approved',
    rejectCode: null,
    rules: [{
      code: 'RISK_MANUAL_COMMAND_BYPASS',
      outcome: 'passed',
      actionId: action.actionId,
      details: { source_type: 'user_command' },
    }],
    approvedActions: [action],
    evaluatedAt: now.toISOString(),
    policyHash: riskPolicyHash(context.policy),
    manualReleaseId: null,
    manualReleaseRevision: null,
  }
}

/**
 * Resource commands still bind the exact current ticket and validate close
 * volume before either manual bypass or strategy risk evaluation is recorded.
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
