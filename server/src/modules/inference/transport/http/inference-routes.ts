import type { FastifyPluginAsync } from 'fastify'
import type { StrategyKind, StrategySummary } from '../../../strategies/domain/strategy.js'
import { assertStrategyKind, StrategyAccessError } from '../../../strategies/domain/strategy.js'
import type { StrategyService } from '../../../strategies/application/strategy-service.js'
import type { InferenceService } from '../../application/inference-service.js'
import type { AnalysisRun, MarketAnalysisDetail, MarketAnalysisSummary, TraderDecisionDetail, TraderDecisionSummary, TraderRun } from '../../domain/inference.js'
import { InferenceError } from '../../domain/inference.js'

export interface InferenceRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
}

export interface InferenceRoutesOptions {
  service: InferenceService
  strategies: StrategyService
  auth: InferenceRequestAuthenticator
}

const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })
const strategyDto = (value: StrategySummary) => ({ id: value.id, kind: value.kind, scope: value.scope, owner_user_id: value.ownerUserId === null ? null : String(value.ownerUserId), name: value.name, description: value.description, status: value.status, active_version_id: value.activeVersionId, revision: String(value.revision) })
const analysisJobDto = (value: AnalysisRun) => ({ analysis_id: value.id, strategy_id: value.strategyId, strategy_version_id: value.strategyVersionId, symbol: value.symbol, trigger: value.trigger, status: value.status, created_at: value.createdAt, updated_at: value.updatedAt, revision: String(value.revision) })
const analysisSummaryDto = (value: MarketAnalysisSummary) => ({ analysis_id: value.id, strategy_id: value.strategyId, strategy_version_id: value.strategyVersionId, symbol: value.symbol, market_bias: value.marketBias, opportunity: value.opportunity, confidence: value.confidence, summary: value.summary, analyzed_at: value.analyzedAt, valid_until: value.validUntil, revision: String(value.revision) })
const analysisDetailDto = (value: MarketAnalysisDetail) => ({ summary: analysisSummaryDto(value.summary), market_regime: value.result.marketRegime, supporting_evidence: value.result.supportingEvidence, counter_evidence: value.result.counterEvidence, key_levels: value.result.keyLevels, invalidation: value.result.invalidation, data_gaps: value.result.dataGaps, analysis_body: value.result.analysisBody, input_snapshot_hash: value.summary.inputSnapshotHash })
const traderRunDto = (value: TraderRun) => ({ trader_run_id: value.id, analysis_id: value.marketAnalysisId, trading_account_id: value.tradingAccountId, strategy_id: value.strategyId, strategy_version_id: value.strategyVersionId, task_mode: value.taskMode, status: value.status, created_at: value.createdAt, updated_at: value.updatedAt, revision: String(value.revision) })
const decisionSummaryDto = (value: TraderDecisionSummary) => ({ decision_id: value.id, analysis_id: value.marketAnalysisId, trading_account_id: value.tradingAccountId, strategy_id: value.strategyId, strategy_version_id: value.strategyVersionId, action: value.action, side: value.side, confidence: value.confidence, summary: value.summary, status: value.status, stale_reason: value.staleReason, created_at: value.createdAt, revision: String(value.revision) })
const decisionDetailDto = (value: TraderDecisionDetail) => ({ summary: decisionSummaryDto(value.summary), actions: value.result.actions.map(action => ({ action_id: action.actionId, kind: action.kind, parameters: action.parameters, expected_state: action.expectedState })), reasoning: value.result.reasoning, input_snapshot_hash: value.summary.inputSnapshotHash })

function problem(error: unknown, request: { id: string; url: string }, reply: { code(status: number): { send(body: unknown): unknown } }) {
  const known = error instanceof InferenceError || error instanceof StrategyAccessError ? error : new InferenceError('inference_unavailable', 503)
  const retryAfter = known instanceof InferenceError ? known.retryAfterMs : undefined
  return reply.code(known.status).send({
    type: `urn:aurum:problem:${known.code}`, title: 'Inference request failed', status: known.status,
    code: known.code, detail: known.code, instance: request.url, correlation_id: request.id,
    retryable: known.status >= 500 || known.status === 429,
    ...(retryAfter === undefined ? {} : { retry_after_ms: retryAfter }),
  })
}

export const inferenceRoutes: FastifyPluginAsync<InferenceRoutesOptions> = async (fastify, options) => {
  fastify.get<{ Querystring: { kind?: StrategyKind } }>('/strategies', async (request, reply) => {
    try {
      const { userId } = await options.auth.authenticate(request)
      if (request.query.kind !== undefined) assertStrategyKind(request.query.kind)
      return response(request.id, { items: (await options.strategies.list(userId, request.query.kind)).map(strategyDto) })
    }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.post<{ Body: { strategy_id: string; symbol: string; mode: 'manual' } }>('/analysis-jobs', async (request, reply) => {
    try {
      const { userId } = await options.auth.assertWrite(request)
      if (request.body.mode !== 'manual' || Object.hasOwn(request.body as object, 'auto_execute')) throw new InferenceError('analysis_request_invalid', 422)
      const idempotencyKey = String(request.headers['idempotency-key'] ?? '')
      const run = await options.service.requestManualAnalysis(userId, request.body.strategy_id, request.body.symbol, idempotencyKey)
      return reply.code(202).send(response(request.id, analysisJobDto(run)))
    } catch (error) { return problem(error, request, reply) }
  })
  fastify.get<{ Querystring: { page_size?: string } }>('/market-analyses', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); return response(request.id, { items: (await options.service.analyses(userId, Number(request.query.page_size ?? 50))).map(analysisSummaryDto) }) }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.get<{ Params: { analysis_id: string } }>('/market-analyses/:analysis_id', async (request, reply) => {
    try {
      const { userId } = await options.auth.authenticate(request); const item = await options.service.analysis(userId, request.params.analysis_id)
      if (!item) throw new InferenceError('analysis_not_found', 404)
      return response(request.id, analysisDetailDto(item))
    } catch (error) { return problem(error, request, reply) }
  })
  fastify.post<{ Params: { analysis_id: string }; Body: { trading_account_id: string; subscription_id: string; subscription_revision: string; trader_strategy_id: string; trader_strategy_version_id: string } }>('/market-analyses/:analysis_id/trader-evaluations', async (request, reply) => {
    try {
      const { userId } = await options.auth.assertWrite(request)
      const item = await options.service.requestAccountEvaluation(userId, {
        marketAnalysisId: request.params.analysis_id, tradingAccountId: request.body.trading_account_id,
        subscriptionId: request.body.subscription_id, subscriptionRevision: Number(request.body.subscription_revision),
        strategyId: request.body.trader_strategy_id, strategyVersionId: request.body.trader_strategy_version_id,
      }, String(request.headers['idempotency-key'] ?? ''))
      return reply.code(202).send(response(request.id, traderRunDto(item)))
    } catch (error) { return problem(error, request, reply) }
  })
  fastify.get<{ Querystring: { account_id: string; page_size?: string } }>('/trade-decisions', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); return response(request.id, { items: (await options.service.decisions(userId, request.query.account_id, Number(request.query.page_size ?? 50))).map(decisionSummaryDto) }) }
    catch (error) { return problem(error, request, reply) }
  })
  fastify.get<{ Params: { decision_id: string } }>('/trade-decisions/:decision_id', async (request, reply) => {
    try {
      const { userId } = await options.auth.authenticate(request); const item = await options.service.decision(userId, request.params.decision_id)
      if (!item) throw new InferenceError('trade_decision_not_found', 404)
      return response(request.id, decisionDetailDto(item))
    } catch (error) { return problem(error, request, reply) }
  })
}
