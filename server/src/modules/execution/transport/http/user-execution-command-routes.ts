import { userCommandTargetVersion } from '../../domain/user-command-target-version.js'
import { randomUUID } from 'node:crypto'
import { AuthError } from '../../../auth/index.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import {
  UserExecutionCommandError,
  type UserExecutionCommandInput,
  type UserExecutionCommandResult,
  type UserExecutionCommandType,
  type UserExecutionExpectedRevisions,
} from '../../domain/user-execution-command.js'
import type { UserExecutionCommandService } from '../../application/user-execution-command-service.js'

export interface UserExecutionCommandRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
  /** Must perform the write-authentication and CSRF checks for this request. */
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
}

export interface UserExecutionCommandRoutesOptions {
  service: UserExecutionCommandService
  auth: UserExecutionCommandRequestAuthenticator
}

interface RequestBody extends Record<string, unknown> {
  command_type?: unknown
  expected_state?: unknown
}

const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })

/**
 * Single public write endpoint for the authenticated user's own command.
 * Distribution source metadata is internal-only and cannot be supplied here.
 * Body parsing is kept here at the transport boundary; the application/domain
 * still performs the authoritative validation and normalization.
 */
export const userExecutionCommandRoutes: FastifyPluginAsync<UserExecutionCommandRoutesOptions> = async (fastify, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['getExecutionCommandContext', 'createExecutionCommand'])
  fastify.get<{ Params: { account_id: string }; Querystring: { symbol?: string; ticket?: string } }>('/trading-accounts/:account_id/execution-context', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      if (Object.keys(request.query).some(key => key !== 'symbol' && key !== 'ticket')) throw new HttpContractError('api_request_invalid', 400)
      contract.request('getExecutionCommandContext', request)
      const result = await options.service.commandContext({
        userId,
        accountId: request.params.account_id,
        symbol: request.query.symbol ?? null,
        ticket: request.query.ticket ?? null,
      })
      return contract.response('getExecutionCommandContext', response(request.id, commandContextDto(result.context, result.symbol, result.ticket)))
    } catch (error) { return contextProblem(error, request.id, reply, contract) }
  })

  fastify.post<{ Params: { account_id: string }; Body: RequestBody }>('/trading-accounts/:account_id/execution-commands', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      // Authenticate before parsing or mutating anything.  assertWrite owns
      // the CSRF/write-token decision and is mandatory for this route.
      const { userId } = await options.auth.assertWrite(request)
      const idempotencyKey = request.headers['idempotency-key']
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw new UserExecutionCommandError('idempotency_key_required', 428)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('createExecutionCommand', request)
      const body = request.body ?? {}
      const input = toCommandInput(userId, request.params.account_id, body, idempotencyKey)
      const result = await options.service.execute(input)
      try { return reply.code(202).send(contract.response('createExecutionCommand', response(request.id, commandResultDto(result)), 202)) }
      catch { throw new UserExecutionCommandError('user_command_commit_unknown', 503) }
    } catch (error: any) { console.error('[EXEC-CMD]', error?.code ?? error?.message ?? String(error)); return problem(error, request, reply, contract) }
  })
}

function commandContextDto(context: Awaited<ReturnType<UserExecutionCommandService['commandContext']>>['context'], requestedSymbol: string | null, ticket: string | null) {
  const target = ticket
    ? [...context.positions, ...context.pendingOrders].find((item) => String(item.ticket ?? '') === ticket) ?? null
    : null
  const symbol = String(requestedSymbol ?? target?.symbol ?? context.quote.symbol ?? '').trim().toUpperCase()
  const quote = context.quote.revision > 0 && positiveDecimal(context.quote.bid) && positiveDecimal(context.quote.ask)
    ? { bid: context.quote.bid, ask: context.quote.ask, observed_at: context.quote.observedAt }
    : null
  const instrument = context.instrument.revision > 0
    && [context.instrument.point, context.instrument.tickSize, context.instrument.tickValue, context.instrument.volumeMin, context.instrument.volumeMax, context.instrument.volumeStep].every(positiveDecimal)
    ? {
        point: context.instrument.point,
        tick_size: context.instrument.tickSize,
        tick_value: context.instrument.tickValue,
        volume_min: context.instrument.volumeMin,
        volume_max: context.instrument.volumeMax,
        volume_step: context.instrument.volumeStep,
        trade_enabled: context.instrument.tradeEnabled,
      }
    : null
  return {
    account_id: context.accountId,
    symbol,
    ticket,
    read_only: context.observer,
    trade_permission: context.tradePermission,
    expected_state: {
      account_revision: String(context.currentRevisions.account),
      positions_revision: String(context.currentRevisions.positions),
      pending_orders_revision: String(context.currentRevisions.pendingOrders),
      quote_revision: String(context.currentRevisions.quote),
      contract_revision: String(context.currentRevisions.contract),
      risk_revision: String(context.currentRevisions.risk),
    },
    target_revision: target && Number(target.revision) > 0 ? String(userCommandTargetVersion(target)) : null,
    quote,
    instrument,
  }
}

function positiveDecimal(value: unknown) {
  const normalized = String(value ?? '').trim()
  return /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(normalized) && Number(normalized) > 0
}

function toCommandInput(userId: number, accountId: string, body: RequestBody, idempotencyKey: string): UserExecutionCommandInput {
  const commandType = body.command_type as UserExecutionCommandType
  return {
    userId,
    accountId,
    commandType,
    idempotencyKey: idempotencyKey.trim(),
    expected: expectedFromHttp(body.expected_state),
    parameters: parametersFromHttp(commandType, body),
  }
}

function expectedFromHttp(value: unknown): UserExecutionExpectedRevisions {
  if (!isObject(value)) return value as UserExecutionExpectedRevisions
  return {
    accountRevision: value.account_revision,
    positionsRevision: value.positions_revision,
    pendingOrdersRevision: value.pending_orders_revision,
    quoteRevision: value.quote_revision,
    contractRevision: value.contract_revision,
    riskRevision: value.risk_revision,
    resourceRevision: value.resource_revision ?? null,
  } as UserExecutionExpectedRevisions
}

function parametersFromHttp(commandType: UserExecutionCommandType, value: Record<string, unknown>): UserExecutionCommandInput['parameters'] {
  switch (commandType) {
    case 'market_order':
      return {
        symbol: value.symbol, side: value.side, volume: value.volume, stopLoss: value.stop_loss,
        takeProfit: value.take_profit, referencePrice: value.reference_price, comment: value.comment,
      } as UserExecutionCommandInput['parameters']
    case 'pending_order':
      return {
        symbol: value.symbol, orderType: value.order_type, volume: value.volume, price: value.price,
        stopLimitPrice: value.stop_limit_price, stopLoss: value.stop_loss,
        takeProfit: value.take_profit, referencePrice: value.reference_price,
        expirationUtcMsc: value.expiration_utc_msc, comment: value.comment,
      } as UserExecutionCommandInput['parameters']
    case 'modify_position':
      return {
        ticket: value.ticket, stopLoss: value.stop_loss, takeProfit: value.take_profit,
        removeStopLoss: value.remove_stop_loss, removeTakeProfit: value.remove_take_profit,
      } as UserExecutionCommandInput['parameters']
    case 'close_position': return { ticket: value.ticket, volume: value.volume } as UserExecutionCommandInput['parameters']
    case 'modify_order':
      return {
        ticket: value.ticket, price: value.price, volume: value.volume, stopLimitPrice: value.stop_limit_price,
        stopLoss: value.stop_loss, takeProfit: value.take_profit,
        removeStopLoss: value.remove_stop_loss, removeTakeProfit: value.remove_take_profit,
        removeExpiration: value.remove_expiration,
        expirationUtcMsc: value.expiration_utc_msc,
      } as UserExecutionCommandInput['parameters']
    case 'cancel_order': return { ticket: value.ticket } as UserExecutionCommandInput['parameters']
    default: throw new UserExecutionCommandError('user_command_type_invalid', 422)
  }
}

function commandResultDto(result: UserExecutionCommandResult) {
  return {
    operation_id: result.operation.id,
    kind: result.operation.kind,
    status: result.operation.status,
    parent_operation_id: result.operation.parentOperationId,
    distribution_id: result.operation.distributionId,
    accepted_at: result.operation.acceptedAt,
    updated_at: result.operation.updatedAt,
    completed_at: result.operation.completedAt,
    resource_id: result.operation.resourceId,
    error_code: result.operation.errorCode,
    revision: String(result.operation.revision),
    result_summary: result.operation.status === 'rejected'
      ? { reject_code: result.operation.errorCode }
      : { command_type: result.command.commandType },
  }
}

function problem(error: unknown, request: { id: string; url: string }, reply: FastifyReply, contract: ReturnType<typeof createHttpContractValidator>) {
  const known = error instanceof UserExecutionCommandError || error instanceof AuthError || error instanceof HttpContractError
    ? error : new UserExecutionCommandError('execution_command_unavailable', 503)
  const body = {
    type: `urn:aurum:problem:${known.code}`, title: 'Execution command failed', status: known.status,
    code: known.code, detail: known.status >= 500 ? '暂时无法确认结果，请保留原请求编号和内容。' : known.code,
    instance: '/api/v4/trading-accounts', correlation_id: request.id,
    retryable: known.status >= 500, ...(known instanceof UserExecutionCommandError && Object.keys(known.details).length ? { errors: Object.entries(known.details)
      .filter(([field]) => field === 'resource' || field === 'ticket')
      .map(([field, value]) => ({ field, code: known.code, message: String(value) })) } : {}),
  }
  try {
    return reply.type('application/problem+json').code(known.status).send(contract.response('createExecutionCommand', body, known.status, 'application/problem+json'))
  } catch {
    const fallback = { type: 'urn:aurum:problem:user_command_commit_unknown', title: 'Execution command result unknown', status: 503,
      code: 'user_command_commit_unknown', detail: '暂时无法确认结果，请保留原请求编号和内容。',
      instance: '/api/v4/trading-accounts', correlation_id: randomUUID(), retryable: true }
    return reply.type('application/problem+json').code(503).send(contract.response('createExecutionCommand', fallback, 503, 'application/problem+json'))
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contextProblem(error: unknown, requestId: string, reply: FastifyReply, contract: ReturnType<typeof createHttpContractValidator>) {
  const known = error instanceof UserExecutionCommandError || error instanceof AuthError || error instanceof HttpContractError
    ? error : new UserExecutionCommandError('execution_command_unavailable', 503)
  const body = { type: `urn:aurum:problem:${known.code}`, title: 'Execution context unavailable', status: known.status,
    code: known.code, detail: known.code, instance: '/api/v4/trading-accounts', correlation_id: requestId, retryable: known.status >= 500 }
  try {
    return reply.type('application/problem+json').code(known.status).send(contract.response('getExecutionCommandContext', body, known.status, 'application/problem+json'))
  } catch {
    const fallback = { ...body, type: 'urn:aurum:problem:api_response_invalid', code: 'api_response_invalid', detail: 'api_response_invalid', status: 503, correlation_id: randomUUID(), retryable: true }
    return reply.type('application/problem+json').code(503).send(contract.response('getExecutionCommandContext', fallback, 503, 'application/problem+json'))
  }
}
