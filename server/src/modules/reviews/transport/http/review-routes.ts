import type { FastifyPluginAsync } from 'fastify'
import type { ReviewService } from '../../application/review-service.js'
import { ReviewError, reviewContentFromWire, type ReviewCaseDetail, type ReviewCaseSummary, type ReviewContent, type StrategyMemoryDetail, type StrategyMemorySummary, type StrategyMemoryUpdate } from '../../domain/review.js'

export interface ReviewRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
}
export interface ReviewRoutesOptions { service: ReviewService; auth: ReviewRequestAuthenticator }
const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })

export const reviewRoutes: FastifyPluginAsync<ReviewRoutesOptions> = async (fastify, options) => {
  fastify.get<{ Querystring: { kind?: string; account_id?: string; page_size?: string } }>('/review-cases', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); return response(request.id, { items: (await options.service.cases(userId, { ...(request.query.kind === undefined ? {} : { kind: request.query.kind }), ...(request.query.account_id === undefined ? {} : { tradingAccountId: request.query.account_id }), limit: Number(request.query.page_size ?? 50) })).map(caseDto) }) }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.get<{ Params: { caseId: string } }>('/review-cases/:caseId', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); const detail = await options.service.detail(userId, request.params.caseId); return reply.header('ETag', etag(detail.summary.revision)).send(response(request.id, detailDto(detail))) }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.post<{ Params: { caseId: string }; Body: { mode?: string } }>('/review-cases/:caseId/generations', async (request, reply) => {
    try { const { userId } = await options.auth.assertWrite(request); const detail = await options.service.requestGeneration(userId, request.params.caseId, ifMatch(request.headers['if-match']), request.body?.mode ?? 'retry'); return reply.code(202).header('ETag', etag(detail.summary.revision)).send(response(request.id, detailDto(detail))) }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.post<{ Params: { caseId: string }; Body: { content?: unknown } }>('/review-cases/:caseId/versions', async (request, reply) => {
    try { const { userId } = await options.auth.assertWrite(request); if (!request.body?.content) throw new ReviewError('review_content_required', 422); const detail = await options.service.createVersion(userId, request.params.caseId, ifMatch(request.headers['if-match']), reviewContentFromWire(request.body.content)); return reply.code(201).header('ETag', etag(detail.summary.revision)).send(response(request.id, detailDto(detail))) }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.post<{ Params: { caseId: string }; Body: { version_id?: string } }>('/review-cases/:caseId/confirm', async (request, reply) => {
    try { const { userId } = await options.auth.assertWrite(request); const versionId = text(request.body?.version_id, 'review_version_id'); const detail = await options.service.confirm(userId, request.params.caseId, versionId, ifMatch(request.headers['if-match'])); return reply.header('ETag', etag(detail.summary.revision)).send(response(request.id, detailDto(detail))) }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.post<{ Params: { caseId: string }; Body: { reason?: string } }>('/review-cases/:caseId/return', async (request, reply) => {
    try { const { userId } = await options.auth.assertWrite(request); const detail = await options.service.returnForChanges(userId, request.params.caseId, ifMatch(request.headers['if-match']), text(request.body?.reason, 'reason')); return reply.header('ETag', etag(detail.summary.revision)).send(response(request.id, detailDto(detail))) }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.get<{ Querystring: { account_id?: string; page_size?: string } }>('/manual-review-candidates', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); return response(request.id, { items: (await options.service.manualCandidates(userId, request.query.account_id, Number(request.query.page_size ?? 50))).map(manualCandidateDto) }) }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.post<{ Body: { candidate_ids?: string[]; selection_tokens?: string[]; strategy_id?: string; user_thesis?: string | null } }>('/manual-review-cases', async (request, reply) => {
    try {
      const { userId } = await options.auth.assertWrite(request)
      const detail = await options.service.createManualCase(userId, { candidateIds: request.body?.candidate_ids ?? [], selectionTokens: request.body?.selection_tokens ?? [], strategyId: text(request.body?.strategy_id, 'strategy_id'), ...(request.body?.user_thesis === undefined ? {} : { userThesis: request.body.user_thesis }), idempotencyKey: String(request.headers['idempotency-key'] ?? '') })
      return reply.code(202).header('ETag', etag(detail.summary.revision)).send(response(request.id, detailDto(detail)))
    } catch (error) { return problem(error, request, reply) }
  })
  fastify.get('/strategy-memories', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); return response(request.id, { items: (await options.service.memories(userId)).map(memorySummaryDto) }) }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.get<{ Params: { memoryId: string } }>('/strategy-memories/:memoryId', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); const memory = await options.service.memory(userId, request.params.memoryId); return reply.header('ETag', etag(memory.revision)).send(response(request.id, memoryDetailDto(memory))) }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.get<{ Params: { memoryId: string } }>('/strategy-memories/:memoryId/updates', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); return response(request.id, { items: (await options.service.memoryUpdates(userId, request.params.memoryId)).map(memoryUpdateDto) }) }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.post<{ Params: { updateId: string }; Body: { decision?: string } }>('/strategy-memory-updates/:updateId/decision', async (request, reply) => {
    try { const { userId } = await options.auth.assertWrite(request); const update = await options.service.decideMemoryUpdate(userId, request.params.updateId, ifMatch(request.headers['if-match']), request.body?.decision ?? ''); return reply.header('ETag', etag(update.revision)).send(response(request.id, memoryUpdateDto(update))) }
    catch (error) { return problem(error, request, reply) }
  })
}

function caseDto(value: ReviewCaseSummary) { return { id: value.id, kind: value.kind, user_id: String(value.userId), trading_account_id: value.tradingAccountId, account_label: value.accountLabel, symbol: value.standardSymbol, subscription_id: value.subscriptionId, subscription_revision: value.subscriptionRevision === null ? null : String(value.subscriptionRevision), analysis_strategy_id: value.analysisStrategyId, analysis_strategy_name: value.analysisStrategyName, trader_strategy_id: value.traderStrategyId, trader_strategy_name: value.traderStrategyName, terminal_period_start: value.terminalPeriodStart, terminal_period_end: value.terminalPeriodEnd, terminal_timezone_offset_minutes: value.terminalTimezoneOffsetMinutes, status: value.status, evidence_status: value.evidenceStatus, evidence_revision: String(value.evidenceRevision), evidence_hash: value.evidenceHash, current_version_id: value.currentVersionId, confirmed_version_id: value.confirmedVersionId, updated_at: value.updatedAt, revision: String(value.revision) } }
function detailDto(value: ReviewCaseDetail) { return { summary: caseDto(value.summary), current_version: value.currentVersion ? { id: value.currentVersion.id, review_case_id: value.currentVersion.caseId, version: value.currentVersion.versionNumber, author_kind: value.currentVersion.authorKind, conclusion: value.currentVersion.conclusion, content: reviewContentDto(value.currentVersion.content), created_at: value.currentVersion.createdAt } : null, sources: value.sources.map(item => ({ kind: item.kind, source_id: item.sourceId, relation: item.relation, evidence_hash: item.evidenceHash })), current_job: value.currentJob ? { id: value.currentJob.id, generation: value.currentJob.generation, mode: value.currentJob.mode, status: value.currentJob.status, progress_percent: value.currentJob.progressPercent, current_stage: value.currentJob.currentStage, last_error_code: value.currentJob.lastErrorCode, updated_at: value.currentJob.updatedAt } : null, return_reason: value.returnReason } }
function reviewContentDto(value: ReviewContent) { return { schema_version: value.schemaVersion, conclusion: value.conclusion, headline: value.headline, summary: value.summary, metrics: { net_profit: value.metrics.netProfit, trade_count: value.metrics.tradeCount, win_rate_percent: value.metrics.winRatePercent, profit_factor: value.metrics.profitFactor }, trade_episodes: value.tradeEpisodes.map(item => ({ source_id: item.sourceId, symbol: item.symbol, side: item.side, opened_at: item.openedAt, closed_at: item.closedAt, net_profit: item.netProfit, outcome: item.outcome, summary: item.summary })), roles: Object.fromEntries(Object.entries(value.roles).map(([key, item]) => [key, { assessment: item.assessment, summary: item.summary, evidence_refs: item.evidenceRefs }])), counterexamples: value.counterexamples.map(item => ({ kind: item.kind, title: item.title, summary: item.summary, evidence_refs: item.evidenceRefs, status: item.status })), memory_candidates: value.memoryCandidates.map(item => ({ strategy_id: item.strategyId, memory_key: item.memoryKey, update_kind: item.updateKind, title: item.title, content: item.content, evidence_refs: item.evidenceRefs })), evidence_refs: value.evidenceRefs, full_analysis_text: value.fullAnalysisText } }
function manualCandidateDto(value: Awaited<ReturnType<ReviewService['manualCandidates']>>[number]) { return { id: value.id, trading_account_id: value.tradingAccountId, account_label: value.accountLabel, ticket: value.ticket, position_id: value.positionId, symbol: value.symbol, side: value.side, volume: value.volume, opened_at: value.openedAt, closed_at: value.closedAt, net_profit: value.netProfit, terminal_timezone_offset_minutes: value.terminalTimezoneOffsetMinutes, source_classification: value.sourceClassification, eligibility_status: value.eligibilityStatus, selection_token: value.selectionToken, selection_expires_at: value.selectionExpiresAt, revision: String(value.revision) } }
function memorySummaryDto(value: StrategyMemorySummary) { return { id: value.id, strategy_id: value.strategyId, strategy_name: value.strategyName, strategy_kind: value.strategyKind, owner_user_id: value.ownerUserId === null ? null : String(value.ownerUserId), mode: value.mode, status: value.status, current_version: value.currentVersionNumber, pending_count: value.pendingCount, updated_at: value.updatedAt, revision: String(value.revision) } }
function memoryDetailDto(value: StrategyMemoryDetail) { return { ...memorySummaryDto(value), current_revision_id: value.currentRevisionId, content_text: value.contentText, content_hash: value.contentHash, max_context_tokens: value.maxContextTokens } }
function memoryUpdateDto(value: StrategyMemoryUpdate) { return { id: value.id, library_id: value.libraryId, source_review_case_id: value.sourceReviewCaseId, source_review_version_id: value.sourceReviewVersionId, update_kind: value.updateKind, status: value.status, expected_library_revision: String(value.expectedLibraryRevision), proposal: { memory_key: value.proposal.memoryKey, title: value.proposal.title, content: value.proposal.content, evidence_refs: value.proposal.evidenceRefs }, diff_preview_text: value.diffPreviewText, conflicts: value.conflicts.map(conflict => ({ type: conflict.type, prior_update_id: conflict.priorUpdateId, memory_key: conflict.memoryKey })), created_at: value.createdAt, revision: String(value.revision) } }
function text(value: unknown, field: string) { const result = typeof value === 'string' ? value.trim() : ''; if (!result) throw new ReviewError(`${field}_required`, 422); return result }
function ifMatch(value: unknown) { const normalized = String(value ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, ''); if (!/^\d+$/.test(normalized)) throw new ReviewError('if_match_required', 428); return Number(normalized) }
function etag(value: number) { return `"${value}"` }
function problem(error: unknown, request: { id: string; url: string }, reply: { code(status: number): { send(body: unknown): unknown } }) { const known = error instanceof ReviewError ? error : new ReviewError('review_unavailable', 503); return reply.code(known.status).send({ type: `urn:aurum:problem:${known.code}`, title: 'Review request failed', status: known.status, code: known.code, detail: known.code, instance: request.url, correlation_id: request.id, retryable: known.status >= 500 }) }
