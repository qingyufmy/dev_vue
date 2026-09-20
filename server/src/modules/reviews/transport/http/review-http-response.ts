import type { FastifyRequest, FastifyReply } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import { ReviewError, type ReviewContent } from '../../domain/review.js'
import { assertLegacyReviewContent, type LegacyReviewContent } from '../../domain/legacy-review-content.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'

export function reviewContentDto(value: ReviewContent | LegacyReviewContent) {
  if (value.schemaVersion === 'review.legacy.v1') {
    assertLegacyReviewContent(value)
    return { schema_version: value.schemaVersion, source_table: value.sourceTable, source_id: value.sourceId,
      source_sha256: value.sourceSha256, original_content_hash: value.originalContentHash, raw_text: value.rawText }
  }
  return { schema_version: value.schemaVersion, conclusion: value.conclusion, headline: value.headline, summary: value.summary, metrics: { net_profit: value.metrics.netProfit, trade_count: value.metrics.tradeCount, win_rate_percent: value.metrics.winRatePercent, profit_factor: value.metrics.profitFactor }, trade_episodes: value.tradeEpisodes.map(item => ({ source_id: item.sourceId, symbol: item.symbol, side: item.side, opened_at: item.openedAt, closed_at: item.closedAt, net_profit: item.netProfit, outcome: item.outcome, summary: item.summary })), roles: Object.fromEntries(Object.entries(value.roles).map(([key, item]) => [key, { assessment: item.assessment, summary: item.summary, evidence_refs: item.evidenceRefs }])), counterexamples: value.counterexamples.map(item => ({ kind: item.kind, title: item.title, summary: item.summary, evidence_refs: item.evidenceRefs, status: item.status })), memory_candidates: value.memoryCandidates.map(item => ({ strategy_id: item.strategyId, memory_key: item.memoryKey, update_kind: item.updateKind, title: item.title, content: item.content, evidence_refs: item.evidenceRefs })), evidence_refs: value.evidenceRefs, full_analysis_text: value.fullAnalysisText } }
export function contractProblem(error: unknown, request: FastifyRequest, reply: FastifyReply, contract: ReturnType<typeof createHttpContractValidator>, operation: string) {
  const known = error instanceof ReviewError || error instanceof AuthError || error instanceof HttpContractError ? error : new ReviewError('review_unavailable', 503)
  const body = { type: `urn:aurum:problem:${known.code}`, title: 'Review request failed', status: known.status,
    code: known.code, detail: known.code, instance: request.url.split('?')[0], correlation_id: request.id, retryable: known.status >= 500 && !['review_commit_unknown', 'review_result_unknown'].includes(known.code) }
  return reply.header('Cache-Control', 'no-store').removeHeader('ETag').type('application/problem+json').code(known.status)
    .send(contract.response(operation, body, known.status, 'application/problem+json'))
}
