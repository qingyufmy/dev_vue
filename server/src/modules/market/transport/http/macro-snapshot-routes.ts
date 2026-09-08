import { createHash } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import type { MacroSnapshotService } from '../../application/macro-snapshot-service.js'
import type { CalendarHttpAuth } from './calendar-routes.js'
import { MarketReadError } from '../../domain/calendar.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'

export const macroSnapshotRoutes: FastifyPluginAsync<{ service: MacroSnapshotService; auth: CalendarHttpAuth }> = async (app, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts,
    ['listMacroSnapshots', 'getMacroSnapshot', 'getLatestMacroSnapshot', 'getMacroMarketOverview'])
  async function respond(operation: string, request: FastifyRequest, reply: FastifyReply, read: () => Promise<unknown>, etag = false) {
    reply.header('Cache-Control', 'no-store')
    try {
      await options.auth.authenticate(request)
      contract.request(operation, request)
      const data = await read()
      const result = contract.response(operation, { data, meta: { request_id: request.id, generated_at: new Date().toISOString() } })
      if (etag) reply.header('ETag', `W/"macro-${createHash('sha256').update(JSON.stringify(data)).digest('hex')}"`)
      return result
    } catch (error) {
      const known = error instanceof AuthError || error instanceof MarketReadError || error instanceof HttpContractError
        ? error : new MarketReadError('macro_snapshot_unavailable', 503)
      const body = { type: `urn:aurum:problem:${known.code}`, title: 'Macro snapshot request failed', status: known.status,
        code: known.code, detail: known.code, instance: request.url, correlation_id: request.id, retryable: known.status >= 500 }
      return reply.type('application/problem+json').code(known.status).send(contract.response(operation, body, known.status, 'application/problem+json'))
    }
  }
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/market/macro-snapshots', (request, reply) =>
    respond('listMacroSnapshots', request, reply, () => options.service.list({ ...request.query, limit: Number(request.query.limit ?? 20) })))
  app.get('/market/macro-snapshots/latest', (request, reply) => respond('getLatestMacroSnapshot', request, reply, () => options.service.latest(), true))
  app.get<{ Params: { snapshot_id: string } }>('/market/macro-snapshots/:snapshot_id', (request, reply) =>
    respond('getMacroSnapshot', request, reply, () => options.service.find(request.params.snapshot_id), true))
  app.get('/market/overview', (request, reply) => respond('getMacroMarketOverview', request, reply, () => options.service.overview()))
}
