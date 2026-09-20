import type { FastifyPluginAsync } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import { StrategyAccessError } from '../../domain/strategy.js'
import type { StrategyService } from '../../application/strategy-service.js'
import type { PlatformStrategyPublisher } from '../../application/platform-strategy-publisher.js'
import { detailDto, summaryDto } from './strategy-routes.js'

interface Options {
  service: StrategyService
  publisher: PlatformStrategyPublisher
  auth: {
    authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
    assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
  }
}
export const platformStrategyRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['listPlatformStrategies', 'getPlatformStrategy', 'publishPlatformStrategyVersion', 'createPlatformStrategyVersion'])
  for (const [method, path, operation] of [
    ['GET', '/admin/strategies', 'listPlatformStrategies'],
    ['GET', '/admin/strategies/:strategy_id', 'getPlatformStrategy'],
    ['POST', '/admin/strategies/:strategy_id/versions', 'createPlatformStrategyVersion'],
    ['POST', '/admin/strategies/:strategy_id/versions/:version_id/publish', 'publishPlatformStrategyVersion'],
  ] as const) app.route<{ Params: { strategy_id: string; version_id: string }; Body: { name?: string; description?: string; status?: 'active' | 'draft'; prompt_text: string; config: Record<string, unknown> } }>({ method, url: path, async handler(request, reply) {
    reply.header('Cache-Control', 'no-store')
    let completed = false
    try {
      const actor = await options.auth[method === 'POST' ? 'assertWrite' : 'authenticate'](request)
      if (actor.role !== 'admin') throw new StrategyAccessError('strategy_admin_required', 403)
      if (Object.keys(request.query as object).length || (operation !== 'createPlatformStrategyVersion' && request.body !== undefined)) throw new HttpContractError('api_request_invalid', 400)
      contract.request(operation, request)
      let data: unknown
      if (operation === 'listPlatformStrategies') data = { items: (await options.service.list(actor.userId)).filter(s => s.scope === 'platform').map(summaryDto) }
      else {
        const detail = operation === 'getPlatformStrategy'
          ? await options.service.detail(actor.userId, request.params.strategy_id)
          : operation === 'createPlatformStrategyVersion'
          ? await options.publisher.createVersion({ userId: actor.userId, strategyId: request.params.strategy_id,
            promptText: request.body.prompt_text, config: request.body.config,
            ...(request.body.name === undefined ? {} : { name: request.body.name }),
            ...(request.body.description === undefined ? {} : { description: request.body.description }),
            ...(request.body.status === undefined ? {} : { status: request.body.status }),
            expectedRevision: Number(String(request.headers['if-match']).replace(/^"|"$/g, '')), idempotencyKey: String(request.headers['idempotency-key']) })
          : await options.publisher.publish({ userId: actor.userId, strategyId: request.params.strategy_id, versionId: request.params.version_id,
            expectedRevision: Number(String(request.headers['if-match']).replace(/^"|"$/g, '')), idempotencyKey: String(request.headers['idempotency-key']) })
        completed = method === 'POST'
        if (!detail || detail.summary.scope !== 'platform') throw new StrategyAccessError('strategy_not_found', 404)
        reply.header('ETag', `"${detail.summary.revision}"`)
        data = detailDto(detail)
      }
      const status = operation === 'createPlatformStrategyVersion' ? 201 : 200
      reply.code(status)
      return contract.response(operation, { data, meta: { request_id: request.id, generated_at: new Date().toISOString() } }, status)
    } catch (error) {
      const known = completed ? new StrategyAccessError('strategy_commit_unknown', 503)
        : error instanceof AuthError || error instanceof HttpContractError || error instanceof StrategyAccessError ? error : new StrategyAccessError('strategy_unavailable', 503)
      return reply.code(known.status).send({ type: `urn:aurum:problem:${known.code}`, title: 'Strategy request failed', status: known.status,
        code: known.code, detail: known.code, instance: request.url, correlation_id: request.id })
    }
  } })
}
