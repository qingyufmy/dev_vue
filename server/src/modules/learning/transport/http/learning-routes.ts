import type { FastifyPluginAsync } from 'fastify'
import { AuthError, transportSessionCookieName, type AuthService } from '../../../auth/index.js'
import { LearningError } from '../../domain/learning.js'
import type { LearningService } from '../../application/learning-service.js'
export interface LearningRoutesOptions { service: LearningService; auth: Pick<AuthService, 'cookieName' | 'resolveSession'>; wwwOrigin: string; secureCookies?: boolean }
export const learningRoutes: FastifyPluginAsync<LearningRoutesOptions> = async (app, options) => {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    if (String(request.headers.host ?? '').toLowerCase() !== new URL(options.wwwOrigin).host.toLowerCase()) {
      return reply.code(421).send({ code: 'www_host_required', status: 421, correlation_id: request.id })
    }
  })
  const envelope = (id: string, data: unknown) => ({ data, meta: { request_id: id, generated_at: new Date().toISOString() } })
  app.get<{ Querystring: { cursor?: string } }>('/learning/courses', async (request, reply) => {
    try { return envelope(request.id, await options.service.list(request.query.cursor)) }
    catch (error) { return failure(error, request.id, reply) }
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
      return envelope(request.id, await options.service.detail(request.params.id, userId))
    } catch (error) { return failure(error, request.id, reply) }
  })
}
function failure(error: unknown, id: string, reply: { code(status: number): { send(body: unknown): unknown } }) {
  const known = error instanceof LearningError || error instanceof AuthError ? error : new LearningError('learning_read_failed', 503)
  return reply.code(known.status).send({ type: `urn:aurum:problem:${known.code}`, title: 'Learning request failed',
    status: known.status, code: known.code, correlation_id: id, retryable: known.status >= 500 })
}
