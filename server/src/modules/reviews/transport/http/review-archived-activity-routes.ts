import type { FastifyPluginAsync } from 'fastify'
import type { ReviewArchivedActivityReader } from '../../application/review-archived-activity-reader.js'
import type { ReviewRequestAuthenticator } from './review-routes.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import { contractProblem } from './review-http-response.js'

const operations = { jobs: 'listArchivedReviewJobs', events: 'listArchivedReviewEvents', stages: 'listArchivedReviewStages' } as const
const wire = (row: object) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), value]))
export const reviewArchivedActivityRoutes: FastifyPluginAsync<{ reader: ReviewArchivedActivityReader; auth: ReviewRequestAuthenticator }> = async (app, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, Object.values(operations))
  for (const kind of ['jobs', 'events', 'stages'] as const) {
    const operation = operations[kind]
    app.get<{ Params: { review_case_id: string }; Querystring: { page_size?: string; offset?: string } }>(`/review-cases/:review_case_id/history/${kind}`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      try {
        const { userId } = await options.auth.authenticate(request)
        if (Object.entries(request.query).some(([key, value]) => !['page_size', 'offset'].includes(key) || typeof value !== 'string' || !/^[0-9]+$/.test(value))) throw new HttpContractError('api_request_invalid', 400)
        contract.request(operation, request)
        const page = await options.reader.page(userId, request.params.review_case_id, kind, { limit: Number(request.query.page_size ?? 20), offset: Number(request.query.offset ?? 0) })
        return contract.response(operation, { data: { items: page.items.map(wire), total: page.total, next_offset: page.nextOffset },
          meta: { request_id: request.id, generated_at: new Date().toISOString() } })
      } catch (error) { return contractProblem(error, request, reply, contract, operation) }
    })
  }
}
