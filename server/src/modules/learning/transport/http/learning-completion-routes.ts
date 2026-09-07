import type { FastifyPluginAsync } from 'fastify'
import { AuthError, transportSessionCookieName, type AuthService } from '../../../auth/index.js'
import { LearningError } from '../../domain/learning.js'
import type { LearningCompletionService } from '../../application/learning-completion-service.js'

interface Options {
  service: LearningCompletionService
  auth: Pick<AuthService, 'cookieName' | 'resolveSession' | 'assertCsrf'>
  wwwOrigin: string
  secureCookies: boolean
}
export const learningCompletionRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    if (String(request.headers.host ?? '').toLowerCase() !== new URL(options.wwwOrigin).host.toLowerCase()) {
      return reply.code(421).send({ code: 'www_host_required', status: 421, correlation_id: request.id })
    }
  })
  app.put<{ Params: { courseId: string; lessonId: string }; Body: unknown }>(
    '/learning/courses/:courseId/lessons/:lessonId/completion', { bodyLimit: 1024 }, async (request, reply) => {
      try {
        const name = transportSessionCookieName('www-web', options.secureCookies, options.auth.cookieName('www-web'))
        const cookie = (request.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))
        let raw: string
        try { raw = decodeURIComponent(cookie?.slice(name.length + 1) ?? '') } catch { throw new AuthError('auth_session_invalid', 401) }
        const resolved = await options.auth.resolveSession(raw, 'www-web')
        const csrf = request.headers['x-csrf-token']
        options.auth.assertCsrf(raw, resolved.session, typeof csrf === 'string' ? csrf : undefined, request.headers.origin)
        const body = request.body, requestId = request.headers['idempotency-key']
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'completed,expected_revision'
          || Object.keys(request.query as object).length || typeof requestId !== 'string') throw new LearningError('learning_completion_invalid', 400)
        const row = body as Record<string, unknown>
        const result = await options.service.save({ userId: resolved.user.id, courseId: request.params.courseId, lessonId: request.params.lessonId,
          requestId, completed: row.completed as boolean, expectedRevision: row.expected_revision as string })
        return { data: result, meta: { request_id: request.id, generated_at: new Date().toISOString() } }
      } catch (error) {
        const known = error instanceof LearningError || error instanceof AuthError ? error : new LearningError('learning_write_failed', 503)
        return reply.code(known.status).send({ type: `urn:aurum:problem:${known.code}`, title: '学习进度保存未完成',
          status: known.status, code: known.code, correlation_id: request.id, retryable: known.status >= 500 })
      }
    })
}
