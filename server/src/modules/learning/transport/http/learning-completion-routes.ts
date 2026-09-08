import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
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
  const contract = createHttpContractValidator(httpRuntimeContracts, ['setLearningCompletion'])
  const problem = (code: string, status: number, request: { id: string; url: string }, reply: FastifyReply) => {
    const body = { type: `urn:aurum:problem:${code}`, title: '学习进度保存未完成', status, code,
      detail: code, instance: request.url.split('?')[0]!, correlation_id: request.id, retryable: status >= 500 }
    try {
      return reply.type('application/problem+json').code(status).send(contract.response('setLearningCompletion', body, status, 'application/problem+json'))
    } catch {
      const fallback = { ...body, type: 'urn:aurum:problem:learning_commit_unknown', status: 503,
        code: 'learning_commit_unknown', detail: 'learning_commit_unknown', instance: '/api/v4/learning', correlation_id: randomUUID(), retryable: true }
      return reply.type('application/problem+json').code(503).send(contract.response('setLearningCompletion', fallback, 503, 'application/problem+json'))
    }
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    if (String(request.headers.host ?? '').toLowerCase() !== new URL(options.wwwOrigin).host.toLowerCase()) {
      return problem('www_host_required', 421, request, reply)
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
        try { contract.request('setLearningCompletion', request) } catch (error) {
          if (error instanceof HttpContractError) throw new LearningError('learning_completion_invalid', 400)
          throw error
        }
        const body = request.body, requestId = request.headers['idempotency-key']
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(request.query as object).length || typeof requestId !== 'string') throw new LearningError('learning_completion_invalid', 400)
        const row = body as Record<string, unknown>
        const result = await options.service.save({ userId: resolved.user.id, courseId: request.params.courseId, lessonId: request.params.lessonId,
          requestId, completed: row.completed as boolean, expectedRevision: row.expected_revision as string })
        try {
          return contract.response('setLearningCompletion', { data: result, meta: { request_id: request.id, generated_at: new Date().toISOString() } })
        } catch {
          // The write may already be committed. Preserve the original key/body recovery path.
          throw new LearningError('learning_commit_unknown', 503)
        }
      } catch (error) {
        const known = error instanceof LearningError || error instanceof AuthError ? error : new LearningError('learning_write_failed', 503)
        return problem(known.code, known.status, request, reply)
      }
    })
}
