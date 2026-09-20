import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import type { PublicMarketSnapshot, PublicMarketTimeframe } from '../../application/public-market-snapshot.js'
import type { CalendarHttpAuth } from './calendar-routes.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'

export const publicMarketRoutes: FastifyPluginAsync<{ service: PublicMarketSnapshot; auth: CalendarHttpAuth }> = async (app, { service, auth }) => {
  const operation = 'getPublicMarketSnapshot'
  const contract = createHttpContractValidator(httpRuntimeContracts, [operation, 'listPublicMarketSymbols'])
  const problem = (operationId: string, error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const known = error instanceof AuthError || error instanceof HttpContractError
    const status = known ? error.status : 503
    const code = known ? error.code : 'public_market_unavailable'
    const body = { type: `urn:aurum:problem:${code}`, title: 'Market request failed', status, code, detail: code,
      instance: request.url, correlation_id: request.id, retryable: status >= 500 }
    return reply.code(status).type('application/problem+json').send(contract.response(operationId, body, status, 'application/problem+json'))
  }
  app.get('/market/public-symbols', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      await auth.authenticate(request)
      contract.request('listPublicMarketSymbols', request)
      return contract.response('listPublicMarketSymbols', { data: await service.symbols(), meta: { request_id: request.id, generated_at: new Date().toISOString() } })
    } catch (error) { return problem('listPublicMarketSymbols', error, request, reply) }
  })
  app.get<{ Querystring: { symbol: string; timeframe: PublicMarketTimeframe; page_size?: string; before?: string } }>('/market/public-snapshot', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      await auth.authenticate(request)
      contract.request(operation, request)
      const data = await service.read(request.query.symbol, request.query.timeframe, Number(request.query.page_size ?? 200), request.query.before)
      return contract.response(operation, { data, meta: { request_id: request.id, generated_at: new Date().toISOString() } })
    } catch (error) {
      return problem(operation, error, request, reply)
    }
  })
}
