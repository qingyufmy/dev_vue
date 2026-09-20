import type { FastifyPluginAsync } from 'fastify'
import type { ReviewHistoryReader, ReviewVersionSummary } from '../../application/review-history-reader.js'
import type { ReviewRequestAuthenticator } from './review-routes.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import { contractProblem, reviewContentDto } from './review-http-response.js'
const summary = (v: ReviewVersionSummary) => ({ id: v.id, review_case_id: v.caseId, version: v.versionNumber, author_kind: v.authorKind, conclusion: v.conclusion, created_at: v.createdAt })
export const reviewHistoryRoutes: FastifyPluginAsync<{ reader: ReviewHistoryReader; auth: ReviewRequestAuthenticator }> = async (app, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['listReviewVersions', 'getReviewVersion', 'getReviewHistoricalMetadata'])
  for (const [path, operation] of [['versions', 'listReviewVersions'], ['versions/:version_id', 'getReviewVersion'], ['history', 'getReviewHistoricalMetadata']] as const) {
    app.get<{ Params: { review_case_id: string; version_id?: string }; Querystring: { page_size?: string; before_version?: string } }>('/review-cases/:review_case_id/' + path, async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      try {
        const { userId } = await options.auth.authenticate(request)
        if (Object.keys(request.query).some(key => operation !== 'listReviewVersions' || !['page_size', 'before_version'].includes(key))) throw new HttpContractError('api_request_invalid', 400)
        if (Object.values(request.query).some(value => typeof value !== 'string' || !/^[0-9]+$/.test(value))) throw new HttpContractError('api_request_invalid', 400)
        contract.request(operation, request)
        const caseId = request.params.review_case_id
        let data: unknown
        if (operation === 'listReviewVersions') {
          const result = await options.reader.listVersions(userId, caseId, { limit: Number(request.query.page_size ?? 20), ...(request.query.before_version === undefined ? {} : { beforeVersion: Number(request.query.before_version) }) })
          data = { items: result.items.map(summary), next_before_version: result.nextBeforeVersion }
        } else if (operation === 'getReviewVersion') {
          const v = await options.reader.version(userId, caseId, request.params.version_id!)
          data = { ...summary(v), content: reviewContentDto(v.content) }
        } else {
          const v = await options.reader.metadata(userId, caseId)
          data = v ? { review_case_id: v.caseId, source_table: v.sourceTable, source_id: v.sourceId, source_status: v.sourceStatus,
            source_evidence_status: v.sourceEvidenceStatus, source_strategy_id: v.sourceStrategyId, source_strategy_version: v.sourceStrategyVersion, timezone_source: v.timezoneSource } : null
        }
        return contract.response(operation, { data, meta: { request_id: request.id, generated_at: new Date().toISOString() } })
      } catch (error) { return contractProblem(error, request, reply, contract, operation) }
    })
  }
}
