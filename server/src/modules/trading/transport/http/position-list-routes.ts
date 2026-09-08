import type { FastifyPluginAsync } from 'fastify'
import type { PositionListService } from '../../application/position-list-service.js'
import type { TradeSessionAuthenticator } from '../../application/request-authentication.js'
import { createTradingHttpContract } from './trading-http-contract.js'
import { positionDto } from './position-dto.js'

export const positionListRoutes: FastifyPluginAsync<{ service: PositionListService; auth: TradeSessionAuthenticator }> = async (app, options) => {
  const contract = createTradingHttpContract()
  app.get<{ Querystring: { account_id: string; page_size?: string; cursor?: string } }>('/positions', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      contract.request('listPositions', request)
      const result = await options.service.list(userId, request.query.account_id, Number(request.query.page_size ?? 50), request.query.cursor)
      reply.header('ETag', `W/"positions-${request.query.account_id}-${result.revision}-${request.query.page_size ?? 50}-${request.query.cursor ?? 'first'}"`)
      return contract.response('listPositions', { data: result.items.map(positionDto), meta: {
        request_id: request.id, generated_at: new Date().toISOString(), page_size: result.items.length,
        next_cursor: result.nextCursor, has_more: result.hasMore,
      } })
    } catch (error) { return contract.problem('listPositions', error, request, reply) }
  })
}
