import { randomUUID } from 'node:crypto'
import { AuthError } from '../../../auth/index.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { ExecutionService } from '../../application/execution-service.js'
import { ExecutionError, type Operation } from '../../domain/execution.js'

export interface ExecutionRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
}

export interface ExecutionRoutesOptions { service: ExecutionService; auth: ExecutionRequestAuthenticator }

const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })

export const executionRoutes: FastifyPluginAsync<ExecutionRoutesOptions> = async (fastify, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['getOperation'])
  fastify.get<{ Params: { operation_id: string } }>('/operations/:operation_id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('getOperation', request)
      return contract.response('getOperation', response(request.id, operationDto(await options.service.operation(userId, request.params.operation_id))))
    } catch (error) { return problem(error, request, reply, contract) }
  })
}

function operationDto(value: Operation) {
  return {
    operation_id: value.id, kind: value.kind, status: value.status,
    accepted_at: value.acceptedAt, updated_at: value.updatedAt, completed_at: value.completedAt,
    resource_id: value.resourceId, error_code: value.errorCode, revision: String(value.revision),
    parent_operation_id: value.parentOperationId ?? null,
    distribution_id: value.distributionId ?? null,
    result_summary: value.resultSummary ?? null,
  }
}

function problem(error: unknown, request: { id: string; url: string }, reply: FastifyReply, contract: ReturnType<typeof createHttpContractValidator>) {
  const known = error instanceof ExecutionError || error instanceof AuthError || error instanceof HttpContractError ? error : new ExecutionError('execution_unavailable', 503)
  const body = { type: `urn:aurum:problem:${known.code}`, title: 'Execution request failed', status: known.status, code: known.code,
    detail: known.code, instance: '/api/v4/operations', correlation_id: request.id, retryable: known.status >= 500 }
  try {
    return reply.type('application/problem+json').code(known.status).send(contract.response('getOperation', body, known.status, 'application/problem+json'))
  } catch {
    const fallback = { ...body, type: 'urn:aurum:problem:api_response_invalid', code: 'api_response_invalid', detail: 'api_response_invalid', status: 503, correlation_id: randomUUID(), retryable: true }
    return reply.type('application/problem+json').code(503).send(contract.response('getOperation', fallback, 503, 'application/problem+json'))
  }
}
