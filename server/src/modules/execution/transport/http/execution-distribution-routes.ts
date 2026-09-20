import { randomUUID } from 'node:crypto'
import { AuthError } from '../../../auth/index.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
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
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
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
  const contract = createHttpContractValidator(httpRuntimeContracts, ['previewExecutionDistribution', 'getExecutionDistribution', 'createExecutionDistribution', 'createDistributionCloseCommand'])
  fastify.get<{ Querystring: { strategy_id?: string; symbol?: string } }>('/execution-distributions/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const actor = await options.auth.authenticate(request)
      if (Object.keys(request.query).some(key => key !== 'strategy_id' && key !== 'symbol')) throw new HttpContractError('api_request_invalid', 400)
      contract.request('previewExecutionDistribution', request)
      const preview = await options.service.previewManualOrderDistribution({
        actorUserId: actor.userId,
        actorRole: actor.role,
        strategyId: String(request.query.strategy_id ?? ''),
        symbol: String(request.query.symbol ?? ''),
      })
      return contract.response('previewExecutionDistribution', response(request.id, distributionPreviewDto(preview)))
    } catch (error) { return distributionProblem(error, request.id, reply, contract, 'previewExecutionDistribution') }
  })

  fastify.get<{ Params: { distribution_id: string } }>('/execution-distributions/:distribution_id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const actor = await options.auth.authenticate(request)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('getExecutionDistribution', request)
      const result = await options.service.getDistribution(actor.userId, actor.role, request.params.distribution_id)
      return contract.response('getExecutionDistribution', response(request.id, distributionDetailDto(result)))
    } catch (error) { return distributionProblem(error, request.id, reply, contract, 'getExecutionDistribution') }
  })

  fastify.post<{ Body: DistributionBody }>('/execution-distributions', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const actor = await options.auth.assertWrite(request)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('createExecutionDistribution', request)
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
      try { return reply.code(202).send(contract.response('createExecutionDistribution', response(request.id, operationDto(result)), 202)) }
      catch { throw new ExecutionDistributionError('distribution_commit_unknown', 503) }
    } catch (error) { return distributionProblem(error, request.id, reply, contract, 'createExecutionDistribution') }
  })

  fastify.post<{ Params: { distribution_id: string }; Body: CloseBody }>('/execution-distributions/:distribution_id/close-commands', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const actor = await options.auth.assertWrite(request)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('createDistributionCloseCommand', request)
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
      try { return reply.code(202).send(contract.response('createDistributionCloseCommand', response(request.id, operationDto(result)), 202)) }
      catch { throw new ExecutionDistributionError('distribution_commit_unknown', 503) }
    } catch (error) { return distributionProblem(error, request.id, reply, contract, 'createDistributionCloseCommand') }
  })
}

function distributionPreviewDto(value: Awaited<ReturnType<ExecutionDistributionService['previewManualOrderDistribution']>>) {
  return {
    strategy_id: value.strategyId,
    strategy_version_id: value.strategyVersionId,
    strategy_revision: String(value.strategyRevision),
    symbol: value.symbol,
    target_count: value.targetCount,
    targets: value.targets.map((target) => ({
      account_id: target.accountId,
      subscription_id: target.subscriptionId,
      trade_permission: target.tradePermission,
      ready: target.ready,
      missing_resources: target.missingResources,
    })),
  }
}

function distributionDetailDto(result: ExecutionDistributionResult) {
  const value = result.distribution
  return {
    id: value.id,
    operation_id: value.operationId,
    strategy_id: value.strategyId,
    strategy_version_id: value.strategyVersionId,
    kind: value.kind,
    source_distribution_id: value.sourceDistributionId,
    command: value.command,
    status: value.status,
    target_count: value.targetCount,
    result_summary: value.resultSummary,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
    completed_at: value.completedAt,
    revision: String(value.revision),
    targets: result.targets.map((target) => ({
      id: target.id,
      account_id: target.accountId,
      subscription_id: target.subscriptionId,
      child_operation_id: target.childOperationId,
      source_ticket: target.sourceTicket,
      status: target.status,
      error_code: target.errorCode,
      revision: String(target.revision),
    })),
  }
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

function distributionProblem(error: unknown, id: string, reply: FastifyReply, contract: ReturnType<typeof createHttpContractValidator>,
  operation: 'previewExecutionDistribution' | 'getExecutionDistribution' | 'createExecutionDistribution' | 'createDistributionCloseCommand') {
  const write = operation === 'createExecutionDistribution' || operation === 'createDistributionCloseCommand'
  const known = error instanceof ExecutionDistributionError || error instanceof AuthError || error instanceof HttpContractError
    ? error : new ExecutionDistributionError('distribution_unavailable', 503)
  const body = { type: `urn:aurum:problem:${known.code}`, title: 'Distribution read failed', status: known.status,
    code: known.code, detail: write && known.status >= 500 ? '暂时无法确认结果，请保留原请求编号和内容。' : known.code, instance: '/api/v4/execution-distributions', correlation_id: id, retryable: known.status >= 500 }
  try {
    return reply.type('application/problem+json').code(known.status).send(contract.response(operation, body, known.status, 'application/problem+json'))
  } catch {
    const code = write ? 'distribution_commit_unknown' : 'api_response_invalid'
    const fallback = { ...body, type: `urn:aurum:problem:${code}`, code, detail: write ? '暂时无法确认结果，请保留原请求编号和内容。' : code, status: 503, correlation_id: randomUUID(), retryable: true }
    return reply.type('application/problem+json').code(503).send(contract.response(operation, fallback, 503, 'application/problem+json'))
  }
}
