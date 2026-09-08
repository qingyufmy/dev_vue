import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { AuthError } from '../../../auth/index.js'
import type { CalendarService } from '../../application/calendar-service.js'
import { MarketReadError, type CalendarImportance } from '../../domain/calendar.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'

export interface CalendarHttpAuth { authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }> }
export const calendarRoutes: FastifyPluginAsync<{ service: CalendarService; auth: CalendarHttpAuth }> = async (app, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['listEconomicCalendarEvents', 'getEconomicCalendarEvent'])
  const response = (id: string, data: unknown) => ({ data, meta: { request_id: id, generated_at: new Date().toISOString() } })
  const problem = (operation: string, error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const known = error instanceof MarketReadError || error instanceof AuthError || error instanceof HttpContractError ? error : new MarketReadError('calendar_unavailable', 503)
    const body = { type: `urn:aurum:problem:${known.code}`, title: 'Calendar request failed', status: known.status,
      code: known.code, detail: known.code, instance: request.url, correlation_id: request.id, retryable: known.status >= 500 }
    return reply.type('application/problem+json').code(known.status).send(contract.response(operation, body, known.status, 'application/problem+json'))
  }
  app.get<{ Querystring: { from: string; to: string; importance?: CalendarImportance; limit?: string; cursor?: string } }>('/market/calendar-events', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      await options.auth.authenticate(request); contract.request('listEconomicCalendarEvents', request)
      const data = await options.service.list({ ...request.query, limit: Number(request.query.limit ?? 20) })
      return contract.response('listEconomicCalendarEvents', response(request.id, data))
    } catch (error) { return problem('listEconomicCalendarEvents', error, request, reply) }
  })
  app.get<{ Params: { event_id: string } }>('/market/calendar-events/:event_id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      await options.auth.authenticate(request); contract.request('getEconomicCalendarEvent', request)
      const data = await options.service.find(request.params.event_id)
      reply.header('ETag', `W/"calendar-${createHash('sha256').update(JSON.stringify(data)).digest('hex')}"`)
      return contract.response('getEconomicCalendarEvent', response(request.id, data))
    } catch (error) { return problem('getEconomicCalendarEvent', error, request, reply) }
  })
}
