import type { FastifyPluginAsync } from 'fastify'
import type { ExecutionService } from '../../application/execution-service.js'
import { ExecutionError, type Operation } from '../../domain/execution.js'

export interface ExecutionRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
}

export interface ExecutionRoutesOptions { service: ExecutionService; auth: ExecutionRequestAuthenticator }

const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })

export const executionRoutes: FastifyPluginAsync<ExecutionRoutesOptions> = async (fastify, options) => {
  fastify.get<{ Params: { operationId: string } }>('/operations/:operationId', async (request, reply) => {
    try {
      const { userId } = await options.auth.authenticate(request)
      return response(request.id, operationDto(await options.service.operation(userId, request.params.operationId)))
    } catch (error) { return problem(error, request, reply) }
  })
}

function operationDto(value: Operation) {
  return {
    operation_id: value.id, kind: value.kind, status: value.status,
    accepted_at: value.acceptedAt, updated_at: value.updatedAt, completed_at: value.completedAt,
    resource_id: value.resourceId, error_code: value.errorCode, revision: String(value.revision),
  }
}

function problem(error: unknown, request: { id: string; url: string }, reply: { code(status: number): { send(body: unknown): unknown } }) {
  const known = error instanceof ExecutionError ? error : new ExecutionError('execution_unavailable', 503)
  return reply.code(known.status).send({ type: `urn:aurum:problem:${known.code}`, title: 'Execution request failed', status: known.status, code: known.code, detail: known.code, instance: request.url, correlation_id: request.id, retryable: known.status >= 500 })
}
