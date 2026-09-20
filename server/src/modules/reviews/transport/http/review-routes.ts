import { reviewContentDto, contractProblem } from './review-http-response.js'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import type { ReviewService } from '../../application/review-service.js'
import { ReviewError, type ReviewCaseDetail, type ReviewCaseSummary, type StrategyMemoryDetail, type StrategyMemorySummary, type StrategyMemoryUpdate } from '../../domain/review.js'

export interface ReviewRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
}
export interface ReviewRoutesOptions { service: ReviewService; auth: ReviewRequestAuthenticator }
const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })

export const reviewRoutes: FastifyPluginAsync<ReviewRoutesOptions> = async (fastify, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['listReviewCases', 'getReviewCase', 'listManualReviewCandidates', 'listStrategyMemories', 'getStrategyMemory', 'listStrategyMemoryUpdates', 'requestReviewGeneration', 'createReviewVersion', 'confirmReviewVersion', 'returnReviewCase', 'createManualReviewCase', 'decideStrategyMemoryUpdate'])
  const validateRequest = (operation: string, request: FastifyRequest, reply: FastifyReply, queryKeys: string[] = []) => {
    reply.header('Cache-Control', 'no-store')
    if (Object.keys(request.query ?? {}).some(key => !queryKeys.includes(key))) throw new HttpContractError('api_request_invalid', 400)
    contract.request(operation, request)
  }
  const writeResponse = (operation: string, request: FastifyRequest, reply: FastifyReply, status: number, build: () => { revision: number; data: unknown }) => {
    try {
      const result = build()
      const body = contract.response(operation, response(request.id, result.data), status)
      return reply.code(status).header('ETag', etag(result.revision)).send(body)
    } catch {
      throw new ReviewError('review_result_unknown', 503)
    }
  }
  fastify.get<{ Querystring: { kind?: string; account_id?: string; page_size?: string } }>('/review-cases', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); validateRequest('listReviewCases', request, reply, ['kind', 'account_id', 'page_size']); return contract.response('listReviewCases', response(request.id, { items: (await options.service.cases(userId, { ...(request.query.kind === undefined ? {} : { kind: request.query.kind }), ...(request.query.account_id === undefined ? {} : { tradingAccountId: request.query.account_id }), limit: Number(request.query.page_size ?? 50) })).map(caseDto) })) }
    catch (error) { return contractProblem(error, request, reply, contract, 'listReviewCases') }
  })
  fastify.get<{ Params: { review_case_id: string } }>('/review-cases/:review_case_id', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); validateRequest('getReviewCase', request, reply); const detail = await options.service.detail(userId, request.params.review_case_id); return reply.header('ETag', etag(detail.summary.revision)).send(contract.response('getReviewCase', response(request.id, detailDto(detail)))) }
    catch (error) { return contractProblem(error, request, reply, contract, 'getReviewCase') }
  })
  fastify.post<{ Params: { review_case_id: string }; Body: { mode?: string } }>('/review-cases/:review_case_id/generations', async (request, reply) => {
    try { const { userId } = await options.auth.assertWrite(request); ifMatch(request.headers['if-match']); validateRequest('requestReviewGeneration', request, reply); const detail = await options.service.requestGeneration(userId, request.params.review_case_id, ifMatch(request.headers['if-match']), request.body.mode!, String(request.headers['idempotency-key'] ?? '')); return writeResponse('requestReviewGeneration', request, reply, 202, () => ({ revision: detail.summary.revision, data: detailDto(detail) })) }
    catch (error) { return contractProblem(error, request, reply, contract, 'requestReviewGeneration') }
  })
  fastify.post<{ Params: { review_case_id: string }; Body: { content?: unknown } }>('/review-cases/:review_case_id/versions', async (request, reply) => {
    try { const { userId } = await options.auth.assertWrite(request); ifMatch(request.headers['if-match']); validateRequest('createReviewVersion', request, reply); if (!request.body?.content) throw new ReviewError('review_content_required', 422); const detail = await options.service.createVersion(userId, request.params.review_case_id, ifMatch(request.headers['if-match']), request.body.content, String(request.headers['idempotency-key'] ?? '')); return writeResponse('createReviewVersion', request, reply, 201, () => ({ revision: detail.summary.revision, data: detailDto(detail) })) }
    catch (error) { return contractProblem(error, request, reply, contract, 'createReviewVersion') }
  })
  fastify.post<{ Params: { review_case_id: string }; Body: { version_id?: string } }>('/review-cases/:review_case_id/confirm', async (request, reply) => {
    try { const { userId } = await options.auth.assertWrite(request); ifMatch(request.headers['if-match']); validateRequest('confirmReviewVersion', request, reply); const versionId = request.body.version_id!; const detail = await options.service.confirm(userId, request.params.review_case_id, versionId, ifMatch(request.headers['if-match']), String(request.headers['idempotency-key'] ?? '')); return writeResponse('confirmReviewVersion', request, reply, 200, () => ({ revision: detail.summary.revision, data: detailDto(detail) })) }
    catch (error) { return contractProblem(error, request, reply, contract, 'confirmReviewVersion') }
  })
  fastify.post<{ Params: { review_case_id: string }; Body: { reason?: string } }>('/review-cases/:review_case_id/return', async (request, reply) => {
    try { const { userId } = await options.auth.assertWrite(request); ifMatch(request.headers['if-match']); validateRequest('returnReviewCase', request, reply); const detail = await options.service.returnForChanges(userId, request.params.review_case_id, ifMatch(request.headers['if-match']), request.body.reason!, String(request.headers['idempotency-key'] ?? '')); return writeResponse('returnReviewCase', request, reply, 200, () => ({ revision: detail.summary.revision, data: detailDto(detail) })) }
    catch (error) { return contractProblem(error, request, reply, contract, 'returnReviewCase') }
  })
  fastify.get<{ Querystring: { account_id?: string; page_size?: string } }>('/manual-review-candidates', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); validateRequest('listManualReviewCandidates', request, reply, ['account_id', 'page_size']); return contract.response('listManualReviewCandidates', response(request.id, { items: (await options.service.manualCandidates(userId, request.query.account_id, Number(request.query.page_size ?? 50))).map(manualCandidateDto) })) }
    catch (error) { return contractProblem(error, request, reply, contract, 'listManualReviewCandidates') }
  })
  fastify.post<{ Body: { candidate_ids?: string[]; selection_tokens?: string[]; strategy_id?: string; user_thesis?: string | null } }>('/manual-review-cases', async (request, reply) => {
    try {
      const { userId } = await options.auth.assertWrite(request); validateRequest('createManualReviewCase', request, reply)
      const detail = await options.service.createManualCase(userId, { candidateIds: request.body?.candidate_ids ?? [], selectionTokens: request.body?.selection_tokens ?? [], strategyId: request.body.strategy_id!, ...(request.body?.user_thesis === undefined ? {} : { userThesis: request.body.user_thesis }), idempotencyKey: String(request.headers['idempotency-key'] ?? '') })
      return writeResponse('createManualReviewCase', request, reply, 202, () => ({ revision: detail.summary.revision, data: detailDto(detail) }))
    } catch (error) { return contractProblem(error, request, reply, contract, 'createManualReviewCase') }
  })
  fastify.get('/strategy-memories', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); validateRequest('listStrategyMemories', request, reply); return contract.response('listStrategyMemories', response(request.id, { items: (await options.service.memories(userId)).map(memorySummaryDto) })) }
    catch (error) { return contractProblem(error, request, reply, contract, 'listStrategyMemories') }
  })
  fastify.get<{ Params: { memory_id: string } }>('/strategy-memories/:memory_id', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); validateRequest('getStrategyMemory', request, reply); const memory = await options.service.memory(userId, request.params.memory_id); return reply.header('ETag', etag(memory.revision)).send(contract.response('getStrategyMemory', response(request.id, memoryDetailDto(memory)))) }
    catch (error) { return contractProblem(error, request, reply, contract, 'getStrategyMemory') }
  })
  fastify.get<{ Params: { memory_id: string } }>('/strategy-memories/:memory_id/updates', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); validateRequest('listStrategyMemoryUpdates', request, reply); return contract.response('listStrategyMemoryUpdates', response(request.id, { items: (await options.service.memoryUpdates(userId, request.params.memory_id)).map(memoryUpdateDto) })) }
    catch (error) { return contractProblem(error, request, reply, contract, 'listStrategyMemoryUpdates') }
  })
  fastify.post<{ Params: { update_id: string }; Body: { decision?: string } }>('/strategy-memory-updates/:update_id/decision', async (request, reply) => {
    try { const { userId } = await options.auth.assertWrite(request); ifMatch(request.headers['if-match']); validateRequest('decideStrategyMemoryUpdate', request, reply); const update = await options.service.decideMemoryUpdate(userId, request.params.update_id, ifMatch(request.headers['if-match']), request.body.decision!, String(request.headers['idempotency-key'] ?? '')); return writeResponse('decideStrategyMemoryUpdate', request, reply, 200, () => ({ revision: update.revision, data: memoryUpdateDto(update) })) }
    catch (error) { return contractProblem(error, request, reply, contract, 'decideStrategyMemoryUpdate') }
  })
}

function caseDto(value: ReviewCaseSummary) { return { id: value.id, kind: value.kind, user_id: String(value.userId), trading_account_id: value.tradingAccountId, account_label: value.accountLabel, symbol: value.standardSymbol, subscription_id: value.subscriptionId, subscription_revision: value.subscriptionRevision === null ? null : String(value.subscriptionRevision), analysis_strategy_id: value.analysisStrategyId, analysis_strategy_name: value.analysisStrategyName, trader_strategy_id: value.traderStrategyId, trader_strategy_name: value.traderStrategyName, terminal_period_start: value.terminalPeriodStart, terminal_period_end: value.terminalPeriodEnd, terminal_timezone_offset_minutes: value.terminalTimezoneOffsetMinutes, status: value.status, evidence_status: value.evidenceStatus, evidence_revision: String(value.evidenceRevision), evidence_hash: value.evidenceHash, current_version_id: value.currentVersionId, confirmed_version_id: value.confirmedVersionId, updated_at: value.updatedAt, revision: String(value.revision) } }
function detailDto(value: ReviewCaseDetail) { return { summary: caseDto(value.summary), current_version: value.currentVersion ? { id: value.currentVersion.id, review_case_id: value.currentVersion.caseId, version: value.currentVersion.versionNumber, author_kind: value.currentVersion.authorKind, conclusion: value.currentVersion.conclusion, content: reviewContentDto(value.currentVersion.content), created_at: value.currentVersion.createdAt } : null, sources: value.sources.map(item => ({ kind: item.kind, source_id: item.sourceId, relation: item.relation, evidence_hash: item.evidenceHash })), current_job: value.currentJob ? { id: value.currentJob.id, generation: value.currentJob.generation, mode: value.currentJob.mode, status: value.currentJob.status, progress_percent: value.currentJob.progressPercent, current_stage: value.currentJob.currentStage, last_error_code: value.currentJob.lastErrorCode, updated_at: value.currentJob.updatedAt } : null, return_reason: value.returnReason } }
function manualCandidateDto(value: Awaited<ReturnType<ReviewService['manualCandidates']>>[number]) { return { id: value.id, trading_account_id: value.tradingAccountId, account_label: value.accountLabel, ticket: value.ticket, position_id: value.positionId, symbol: value.symbol, side: value.side, volume: value.volume, opened_at: value.openedAt, closed_at: value.closedAt, net_profit: value.netProfit, terminal_timezone_offset_minutes: value.terminalTimezoneOffsetMinutes, source_classification: value.sourceClassification, eligibility_status: value.eligibilityStatus, selection_token: value.selectionToken, selection_expires_at: value.selectionExpiresAt, revision: String(value.revision) } }
function memorySummaryDto(value: StrategyMemorySummary) { return { id: value.id, strategy_id: value.strategyId, strategy_name: value.strategyName, strategy_kind: value.strategyKind, owner_user_id: value.ownerUserId === null ? null : String(value.ownerUserId), mode: value.mode, status: value.status, current_version: value.currentVersionNumber, pending_count: value.pendingCount, updated_at: value.updatedAt, revision: String(value.revision) } }
function memoryDetailDto(value: StrategyMemoryDetail) { return { ...memorySummaryDto(value), current_revision_id: value.currentRevisionId, content_text: value.contentText, content_hash: value.contentHash, max_context_tokens: value.maxContextTokens } }
function memoryUpdateDto(value: StrategyMemoryUpdate) { return { id: value.id, library_id: value.libraryId, source_review_case_id: value.sourceReviewCaseId, source_review_version_id: value.sourceReviewVersionId, update_kind: value.updateKind, status: value.status, expected_library_revision: String(value.expectedLibraryRevision), proposal: { memory_key: value.proposal.memoryKey, title: value.proposal.title, content: value.proposal.content, evidence_refs: value.proposal.evidenceRefs }, diff_preview_text: value.diffPreviewText, conflicts: value.conflicts.map(conflict => ({ type: conflict.type, prior_update_id: conflict.priorUpdateId, memory_key: conflict.memoryKey })), created_at: value.createdAt, revision: String(value.revision) } }
function text(value: unknown, field: string) { const result = typeof value === 'string' ? value.trim() : ''; if (!result) throw new ReviewError(`${field}_required`, 422); return result }
function ifMatch(value: unknown) { const normalized = String(value ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, ''); if (!/^\d+$/.test(normalized)) throw new ReviewError('if_match_required', 428); return Number(normalized) }
function etag(value: number) { return `"${value}"` }
