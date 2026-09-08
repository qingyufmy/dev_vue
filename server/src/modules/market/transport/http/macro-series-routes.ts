import type { FastifyPluginAsync } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import type { MacroSeriesService } from '../../application/macro-series-service.js'
import type { CalendarHttpAuth } from './calendar-routes.js'
import { MarketReadError } from '../../domain/calendar.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'

export const macroSeriesRoutes: FastifyPluginAsync<{ service: MacroSeriesService; auth: CalendarHttpAuth }> = async (app, options) => {
  const operation = 'listMacroSeriesPoints'
  const contract = createHttpContractValidator(httpRuntimeContracts, [operation])
  app.get<{ Querystring: { code: string; from?: string; to?: string; limit?: string; cursor?: string } }>('/market/macro-series', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      await options.auth.authenticate(request)
      contract.request(operation, request)
      const data = await options.service.list({ ...request.query, limit: Number(request.query.limit ?? 20) })
      return contract.response(operation, { data, meta: { request_id: request.id, generated_at: new Date().toISOString() } })
    } catch (error) {
      const known = error instanceof AuthError || error instanceof MarketReadError || error instanceof HttpContractError
        ? error : new MarketReadError('macro_series_unavailable', 503)
      const body = { type: `urn:aurum:problem:${known.code}`, title: 'Macro series request failed', status: known.status,
        code: known.code, detail: known.code, instance: request.url, correlation_id: request.id, retryable: known.status >= 500 }
      return reply.type('application/problem+json').code(known.status).send(contract.response(operation, body, known.status, 'application/problem+json'))
    }
  })
}
