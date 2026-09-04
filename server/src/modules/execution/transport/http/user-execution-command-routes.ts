import type { FastifyPluginAsync } from 'fastify'
import {
  UserExecutionCommandError,
  type UserExecutionCommandInput,
  type UserExecutionCommandResult,
  type UserExecutionCommandType,
  type UserExecutionExpectedRevisions,
} from '../../domain/user-execution-command.js'
import type { UserExecutionCommandService } from '../../application/user-execution-command-service.js'

export interface UserExecutionCommandRequestAuthenticator {
  /** Must perform the write-authentication and CSRF checks for this request. */
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
}

export interface UserExecutionCommandRoutesOptions {
  service: UserExecutionCommandService
  auth: UserExecutionCommandRequestAuthenticator
}

interface RequestBody extends Record<string, unknown> {
  command_type?: unknown
  commandType?: unknown
  expected_state?: unknown
  expected?: unknown
  parameters?: unknown
}

const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })

/**
 * Single public write endpoint for the authenticated user's own command.
 * Distribution source metadata is internal-only and cannot be supplied here.
 * Body parsing is kept here at the transport boundary; the application/domain
 * still performs the authoritative validation and normalization.
 */
export const userExecutionCommandRoutes: FastifyPluginAsync<UserExecutionCommandRoutesOptions> = async (fastify, options) => {
  fastify.post<{ Params: { accountId: string }; Body: RequestBody }>('/trading-accounts/:accountId/execution-commands', async (request, reply) => {
    try {
      // Authenticate before parsing or mutating anything.  assertWrite owns
      // the CSRF/write-token decision and is mandatory for this route.
      const { userId } = await options.auth.assertWrite(request)
      const idempotencyKey = request.headers['idempotency-key']
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw new UserExecutionCommandError('idempotency_key_required', 428)
      const body = request.body ?? {}
      const input = toCommandInput(userId, request.params.accountId, body, idempotencyKey)
      const result = await options.service.execute(input)
      return reply.code(202).send(response(request.id, commandResultDto(result)))
    } catch (error) { return problem(error, request, reply) }
  })
}

function toCommandInput(userId: number, accountId: string, body: RequestBody, idempotencyKey: string): UserExecutionCommandInput {
  const commandType = (body.command_type ?? body.commandType) as UserExecutionCommandType
  const source = body.parameters && isObject(body.parameters) ? body.parameters : body
  const expectedValue = body.expected_state ?? body.expected ?? {
    account_revision: body.account_revision,
    positions_revision: body.positions_revision,
    pending_orders_revision: body.pending_orders_revision,
    quote_revision: body.quote_revision,
    contract_revision: body.contract_revision,
    risk_revision: body.risk_revision,
    resource_revision: body.resource_revision,
  }
  return {
    userId,
    accountId,
    commandType,
    idempotencyKey: idempotencyKey.trim(),
    expected: expectedFromHttp(expectedValue),
    parameters: parametersFromHttp(commandType, source),
  }
}

function expectedFromHttp(value: unknown): UserExecutionExpectedRevisions {
  if (!isObject(value)) return value as UserExecutionExpectedRevisions
  return {
    accountRevision: value.account_revision ?? value.accountRevision,
    positionsRevision: value.positions_revision ?? value.positionsRevision,
    pendingOrdersRevision: value.pending_orders_revision ?? value.pendingOrdersRevision,
    quoteRevision: value.quote_revision ?? value.quoteRevision,
    contractRevision: value.contract_revision ?? value.contractRevision,
    riskRevision: value.risk_revision ?? value.riskRevision,
    resourceRevision: value.resource_revision === undefined && value.resourceRevision === undefined
      ? null : value.resource_revision ?? value.resourceRevision,
  } as UserExecutionExpectedRevisions
}

function parametersFromHttp(commandType: UserExecutionCommandType, value: Record<string, unknown>): UserExecutionCommandInput['parameters'] {
  switch (commandType) {
    case 'market_order':
      return {
        symbol: value.symbol, side: value.side, volume: value.volume, stopLoss: value.stop_loss ?? value.stopLoss,
        takeProfit: value.take_profit ?? value.takeProfit, referencePrice: value.reference_price ?? value.referencePrice, comment: value.comment,
      } as UserExecutionCommandInput['parameters']
    case 'pending_order':
      return {
        symbol: value.symbol, orderType: value.order_type ?? value.orderType ?? value.type, volume: value.volume, price: value.price,
        stopLimitPrice: value.stop_limit_price ?? value.stopLimitPrice, stopLoss: value.stop_loss ?? value.stopLoss,
        takeProfit: value.take_profit ?? value.takeProfit, referencePrice: value.reference_price ?? value.referencePrice,
        expirationUtcMsc: value.expiration_utc_msc ?? value.expirationUtcMsc, comment: value.comment,
      } as UserExecutionCommandInput['parameters']
    case 'modify_position':
      return {
        ticket: value.ticket, stopLoss: value.stop_loss ?? value.stopLoss, takeProfit: value.take_profit ?? value.takeProfit,
        removeStopLoss: value.remove_stop_loss ?? value.removeStopLoss, removeTakeProfit: value.remove_take_profit ?? value.removeTakeProfit,
      } as UserExecutionCommandInput['parameters']
    case 'close_position': return { ticket: value.ticket, volume: value.volume } as UserExecutionCommandInput['parameters']
    case 'modify_order':
      return {
        ticket: value.ticket, price: value.price, volume: value.volume, stopLimitPrice: value.stop_limit_price ?? value.stopLimitPrice,
        stopLoss: value.stop_loss ?? value.stopLoss, takeProfit: value.take_profit ?? value.takeProfit,
        removeStopLoss: value.remove_stop_loss ?? value.removeStopLoss, removeTakeProfit: value.remove_take_profit ?? value.removeTakeProfit,
        removeExpiration: value.remove_expiration ?? value.removeExpiration,
        expirationUtcMsc: value.expiration_utc_msc ?? value.expirationUtcMsc,
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

function problem(error: unknown, request: { id: string; url: string }, reply: { code(status: number): { send(body: unknown): unknown } }) {
  const known = error instanceof UserExecutionCommandError
    ? error
    : new UserExecutionCommandError('execution_command_unavailable', 503)
  return reply.code(known.status).send({
    type: `urn:aurum:problem:${known.code}`, title: 'Execution command failed', status: known.status,
    code: known.code, detail: known.code, instance: request.url, correlation_id: request.id,
    retryable: known.status >= 500, ...(Object.keys(known.details).length ? { details: known.details } : {}),
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
