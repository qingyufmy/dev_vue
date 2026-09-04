import type { FastifyPluginAsync } from 'fastify'
import {
  ExecutionDistributionError,
  type CreateDistributionCloseInput,
  type CreateDistributionInput,
  type DistributionOrderCommand,
  type ExecutionDistributionResult,
} from '../../domain/execution-distribution.js'
import type { ExecutionDistributionService } from '../../application/execution-distribution-service.js'
import type { UserExecutionOrderType } from '../../domain/user-execution-command.js'

export interface ExecutionDistributionRequestAuthenticator {
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
}

export interface ExecutionDistributionRoutesOptions {
  service: ExecutionDistributionService
  auth: ExecutionDistributionRequestAuthenticator
}

interface DistributionBody extends Record<string, unknown> {
  strategy_id?: unknown
  command?: unknown
}

interface CloseBody extends Record<string, unknown> {
  expected_revision?: unknown
  target_ids?: unknown
}

const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })

/**
 * V4 distribution endpoints.  They only authenticate, validate the wire
 * shape and enqueue a durable freeze; all subscription/account selection is
 * performed by the execution distribution repository transaction.
 */
export const executionDistributionRoutes: FastifyPluginAsync<ExecutionDistributionRoutesOptions> = async (fastify, options) => {
  fastify.post<{ Body: DistributionBody }>('/execution-distributions', async (request, reply) => {
    try {
      const actor = await options.auth.assertWrite(request)
      const body = object(request.body, 'distribution_body_invalid')
      const command = wireOrderCommand(object(body.command, 'distribution_command_required'))
      const input: CreateDistributionInput = {
        actorUserId: actor.userId,
        actorRole: actor.role,
        strategyId: String(body.strategy_id ?? ''),
        idempotencyKey: header(request.headers['idempotency-key']),
        command,
      }
      const result = await options.service.createManualOrderDistribution(input)
      return reply.code(202).send(response(request.id, operationDto(result)))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.post<{ Params: { distribution_id: string }; Body: CloseBody }>('/execution-distributions/:distribution_id/close-commands', async (request, reply) => {
    try {
      const actor = await options.auth.assertWrite(request)
      const body = object(request.body, 'distribution_close_body_invalid')
      const targetIds = body.target_ids === undefined ? [] : arrayOfStrings(body.target_ids, 'distribution_target_ids_invalid')
      const input: CreateDistributionCloseInput = {
        actorUserId: actor.userId,
        actorRole: actor.role,
        sourceDistributionId: request.params.distribution_id,
        idempotencyKey: header(request.headers['idempotency-key']),
        expectedRevision: numberValue(body.expected_revision),
        targetIds,
      }
      const result = await options.service.createDistributionClose(input)
      return reply.code(202).send(response(request.id, operationDto(result)))
    } catch (error) { return problem(error, request, reply) }
  })
}

function wireOrderCommand(body: Record<string, unknown>): DistributionOrderCommand {
  const commandType = String(body.command_type ?? '')
  if (commandType === 'market_order') return {
    commandType,
    side: String(body.side ?? '') as 'buy' | 'sell',
    symbol: String(body.symbol ?? ''),
    volume: String(body.volume ?? ''),
    stopLoss: String(body.stop_loss ?? ''),
    takeProfit: body.take_profit === undefined ? null : nullableString(body.take_profit),
    referencePrice: String(body.reference_price ?? ''),
  }
  if (commandType === 'pending_order') return {
    commandType,
    orderType: String(body.order_type ?? '') as UserExecutionOrderType,
    symbol: String(body.symbol ?? ''),
    volume: String(body.volume ?? ''),
    price: String(body.price ?? ''),
    stopLimitPrice: body.stop_limit_price === undefined ? null : nullableString(body.stop_limit_price),
    stopLoss: String(body.stop_loss ?? ''),
    takeProfit: body.take_profit === undefined ? null : nullableString(body.take_profit),
    referencePrice: String(body.reference_price ?? ''),
    expirationUtcMsc: body.expiration_utc_msc === undefined ? null : numberValue(body.expiration_utc_msc),
  }
  throw new ExecutionDistributionError('distribution_command_type_invalid', 422)
}

function operationDto(result: ExecutionDistributionResult) {
  const operation = result.operation
  return {
    operation_id: operation.id,
    kind: operation.kind,
    status: operation.status,
    accepted_at: operation.acceptedAt,
    updated_at: operation.updatedAt,
    completed_at: operation.completedAt,
    resource_id: operation.resourceId,
    error_code: operation.errorCode,
    revision: String(operation.revision),
    parent_operation_id: operation.parentOperationId ?? null,
    distribution_id: operation.distributionId ?? null,
    result_summary: operation.resultSummary ?? null,
  }
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExecutionDistributionError(code, 422)
  return value as Record<string, unknown>
}
function arrayOfStrings(value: unknown, code: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new ExecutionDistributionError(code, 422)
  return value as string[]
}
function nullableString(value: unknown) { if (value === null) return null; if (typeof value !== 'string' && typeof value !== 'number') throw new ExecutionDistributionError('distribution_decimal_invalid', 422); return String(value) }
function numberValue(value: unknown) { const number = typeof value === 'number' ? value : Number(String(value ?? '').trim()); if (!Number.isSafeInteger(number) || number < 1) throw new ExecutionDistributionError('distribution_revision_invalid', 422); return number }
function header(value: unknown) { const normalized = Array.isArray(value) ? value[0] : value; return String(normalized ?? '') }

function problem(error: unknown, request: { id: string; url: string }, reply: { code(status: number): { send(body: unknown): unknown } }) {
  const known = error instanceof ExecutionDistributionError ? error : new ExecutionDistributionError('distribution_unavailable', 503)
  return reply.code(known.status).send({
    type: `urn:aurum:problem:${known.code}`,
    title: 'Execution distribution request failed',
    status: known.status,
    code: known.code,
    detail: known.code,
    instance: request.url,
    correlation_id: request.id,
    retryable: known.status >= 500,
  })
}
