import { randomUUID } from 'node:crypto'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { AuthError, transportSessionCookieName, type AuthService } from '../../../auth/index.js'
import { LearningError } from '../../domain/learning.js'
import type { LearningService } from '../../application/learning-service.js'
export interface LearningRoutesOptions { service: LearningService; auth: Pick<AuthService, 'cookieName' | 'resolveSession'>; wwwOrigin: string; secureCookies?: boolean }
export const learningRoutes: FastifyPluginAsync<LearningRoutesOptions> = async (app, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['listLearningCourses', 'getLearningCourse'])
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    if (String(request.headers.host ?? '').toLowerCase() !== new URL(options.wwwOrigin).host.toLowerCase()) {
      return failure(new LearningError('www_host_required', 421), request.id, reply, contract, 'listLearningCourses')
    }
  })
  const envelope = (id: string, data: unknown) => ({ data, meta: { request_id: id, generated_at: new Date().toISOString() } })
  app.get<{ Querystring: { cursor?: string } }>('/learning/courses', async (request, reply) => {
    try {
      contract.request('listLearningCourses', request)
      return contract.response('listLearningCourses', envelope(request.id, await options.service.list(request.query.cursor)))
    }
    catch (error) { return failure(error, request.id, reply, contract, 'listLearningCourses') }
  })
  app.get<{ Params: { id: string } }>('/learning/courses/:id', async (request, reply) => {
    try {
      const name = transportSessionCookieName('www-web', options.secureCookies ?? true, options.auth.cookieName('www-web'))
      const cookies = (request.headers.cookie ?? '').split(';').map(item => item.trim())
      const raw = cookies.find(item => item.startsWith(`${name}=`))?.slice(name.length + 1)
      let userId: number | null = null
      if (raw) {
        let decoded: string
        try { decoded = decodeURIComponent(raw) } catch { throw new AuthError('auth_session_invalid', 401) }
        userId = (await options.auth.resolveSession(decoded, 'www-web')).user.id
      }
      contract.request('getLearningCourse', request)
      return contract.response('getLearningCourse', envelope(request.id, await options.service.detail(request.params.id, userId)))
    } catch (error) { return failure(error, request.id, reply, contract, 'getLearningCourse') }
  })
}
function failure(error: unknown, id: string, reply: FastifyReply, contract: ReturnType<typeof createHttpContractValidator>, operationId: string) {
  const known = error instanceof LearningError || error instanceof AuthError || error instanceof HttpContractError ? error : new LearningError('learning_read_failed', 503)
  const body = { type: `urn:aurum:problem:${known.code}`, title: 'Learning request failed', detail: known.code,
    instance: '/api/v4/learning/courses', status: known.status, code: known.code, correlation_id: id, retryable: known.status >= 500 }
  try {
    return reply.type('application/problem+json').code(known.status).send(contract.response(operationId, body, known.status, 'application/problem+json'))
  } catch {
    const fallback = { ...body, type: 'urn:aurum:problem:api_response_invalid', title: 'Response validation failed',
      detail: 'api_response_invalid', code: 'api_response_invalid', status: 503, correlation_id: randomUUID(), retryable: true }
    return reply.type('application/problem+json').code(503).send(contract.response(operationId, fallback, 503, 'application/problem+json'))
  }
}
