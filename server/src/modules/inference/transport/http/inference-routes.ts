import { randomUUID } from 'node:crypto'
import { AuthError } from '../../../auth/index.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import type { MarketAnalysisListService } from '../../application/market-analysis-list.js'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { StrategyAccessError } from '../../../strategies/index.js'
import type { InferenceService } from '../../application/inference-service.js'
import type { AnalysisRun, MarketAnalysisDetail, MarketAnalysisSummary, TraderDecisionDetail, TraderDecisionSummary, TraderRun } from '../../domain/inference.js'
import { InferenceError } from '../../domain/inference.js'

export interface InferenceRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
}

export interface InferenceRoutesOptions {
  analysisList: Pick<MarketAnalysisListService, 'list'>
  service: InferenceService
  auth: InferenceRequestAuthenticator
}

const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })
const analysisJobDto = (value: AnalysisRun) => ({ analysis_id: value.id, strategy_id: value.strategyId, strategy_version_id: value.strategyVersionId, symbol: value.symbol, trigger: value.trigger, status: value.status, created_at: value.createdAt, updated_at: value.updatedAt, revision: String(value.revision) })
const analysisSummaryDto = (value: MarketAnalysisSummary) => ({ analysis_id: value.id, strategy_id: value.strategyId, strategy_version_id: value.strategyVersionId, symbol: value.symbol, market_bias: value.marketBias, opportunity: value.opportunity, confidence: value.confidence, summary: value.summary, analyzed_at: value.analyzedAt, valid_until: value.validUntil, revision: String(value.revision) })
const analysisDetailDto = (value: MarketAnalysisDetail) => ({ summary: analysisSummaryDto(value.summary), chart: value.chart ?? [], market_regime: value.result.marketRegime, bullish_score: value.result.bullishScore ?? null, bearish_score: value.result.bearishScore ?? null, supporting_evidence: value.result.supportingEvidence, counter_evidence: value.result.counterEvidence, key_levels: value.result.keyLevels, invalidation: value.result.invalidation, data_gaps: value.result.dataGaps, analysis_body: value.result.analysisBody, input_snapshot_hash: value.summary.inputSnapshotHash })
const traderRunDto = (value: TraderRun) => ({ trader_run_id: value.id, analysis_id: value.marketAnalysisId, trading_account_id: value.tradingAccountId, strategy_id: value.strategyId, strategy_version_id: value.strategyVersionId, task_mode: value.taskMode, status: value.status, created_at: value.createdAt, updated_at: value.updatedAt, revision: String(value.revision) })
const decisionSummaryDto = (value: TraderDecisionSummary) => ({ decision_id: value.id, analysis_id: value.marketAnalysisId, trading_account_id: value.tradingAccountId, strategy_id: value.strategyId, strategy_version_id: value.strategyVersionId, action: value.action, side: value.side, confidence: value.confidence, summary: value.summary, status: value.status, stale_reason: value.staleReason, created_at: value.createdAt, revision: String(value.revision) })
const decisionDetailDto = (value: TraderDecisionDetail) => ({ summary: decisionSummaryDto(value.summary), actions: value.result.actions.map(action => ({ action_id: action.actionId, kind: action.kind, parameters: action.parameters, expected_state: action.expectedState })), reasoning: value.result.reasoning, input_snapshot_hash: value.summary.inputSnapshotHash })

export const inferenceRoutes: FastifyPluginAsync<InferenceRoutesOptions> = async (fastify, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['listMarketAnalyses', 'getMarketAnalysis', 'listTradeDecisions', 'getTradeDecision', 'createAnalysisJob', 'createTraderEvaluation'])
  fastify.post<{ Body: { strategy_id: string; symbol: string; mode: 'manual' } }>('/analysis-jobs', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.assertWrite(request)
      if (!request.body || request.body.mode !== 'manual' || Object.hasOwn(request.body as object, 'auto_execute')) throw new InferenceError('analysis_request_invalid', 422)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('createAnalysisJob', request)
      const idempotencyKey = String(request.headers['idempotency-key'] ?? '')
      const run = await options.service.requestManualAnalysis(userId, request.body.strategy_id, request.body.symbol, idempotencyKey)
      try { return reply.code(202).send(contract.response('createAnalysisJob', response(request.id, analysisJobDto(run)), 202)) }
      catch { throw new InferenceError('inference_commit_unknown', 503) }
    } catch (error) { return writeProblem(error, request.id, reply, contract, 'createAnalysisJob') }
  })
  fastify.get<{ Querystring: { page_size?: string; cursor?: string; symbol?: string; strategy_id?: string } }>('/market-analyses', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      if (Object.keys(request.query).some(key => !['page_size', 'cursor', 'symbol', 'strategy_id'].includes(key))) throw new HttpContractError('api_request_invalid', 400)
      contract.request('listMarketAnalyses', request)
      const result = await options.analysisList.list(userId, { pageSize: request.query.page_size, cursor: request.query.cursor,
        symbol: request.query.symbol, strategyId: request.query.strategy_id })
      return contract.response('listMarketAnalyses', response(request.id, { items: result.items.map(analysisSummaryDto), next_cursor: result.nextCursor }))
    } catch (error) { return readProblem(error, request.id, reply, contract, 'listMarketAnalyses') }
  })
  fastify.get<{ Params: { analysis_id: string } }>('/market-analyses/:analysis_id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('getMarketAnalysis', request)
      const item = await options.service.analysis(userId, request.params.analysis_id)
      if (!item) throw new InferenceError('analysis_not_found', 404)
      return contract.response('getMarketAnalysis', response(request.id, analysisDetailDto(item)))
    } catch (error) { return readProblem(error, request.id, reply, contract, 'getMarketAnalysis') }
  })
  fastify.post<{ Params: { analysis_id: string }; Body: { trading_account_id: string; subscription_id: string; subscription_revision: string; trader_strategy_id: string; trader_strategy_version_id: string } }>('/market-analyses/:analysis_id/trader-evaluations', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.assertWrite(request)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('createTraderEvaluation', request)
      const item = await options.service.requestAccountEvaluation(userId, {
        marketAnalysisId: request.params.analysis_id, tradingAccountId: request.body.trading_account_id,
        subscriptionId: request.body.subscription_id, subscriptionRevision: Number(request.body.subscription_revision),
        strategyId: request.body.trader_strategy_id, strategyVersionId: request.body.trader_strategy_version_id,
      }, String(request.headers['idempotency-key'] ?? ''))
      try { return reply.code(202).send(contract.response('createTraderEvaluation', response(request.id, traderRunDto(item)), 202)) }
      catch { throw new InferenceError('inference_commit_unknown', 503) }
    } catch (error) { return writeProblem(error, request.id, reply, contract, 'createTraderEvaluation') }
  })
  fastify.get<{ Querystring: { account_id: string; page_size?: string } }>('/trade-decisions', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      if (Object.keys(request.query).some(key => key !== 'account_id' && key !== 'page_size')) throw new HttpContractError('api_request_invalid', 400)
      contract.request('listTradeDecisions', request)
      const items = await options.service.decisions(userId, request.query.account_id, Number(request.query.page_size ?? 50))
      return contract.response('listTradeDecisions', response(request.id, { items: items.map(decisionSummaryDto) }))
    } catch (error) { return readProblem(error, request.id, reply, contract, 'listTradeDecisions') }
  })
  fastify.get<{ Params: { decision_id: string } }>('/trade-decisions/:decision_id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('getTradeDecision', request)
      const item = await options.service.decision(userId, request.params.decision_id)
      if (!item) throw new InferenceError('trade_decision_not_found', 404)
      return contract.response('getTradeDecision', response(request.id, decisionDetailDto(item)))
    } catch (error) { return readProblem(error, request.id, reply, contract, 'getTradeDecision') }
  })
}

function readProblem(error: unknown, id: string, reply: FastifyReply, contract: ReturnType<typeof createHttpContractValidator>, operation: string) {
  const known = error instanceof InferenceError || error instanceof AuthError || error instanceof HttpContractError ? error : new InferenceError('inference_unavailable', 503)
  const body = { type: `urn:aurum:problem:${known.code}`, title: 'Inference read failed', status: known.status, code: known.code,
    detail: known.code, instance: '/api/v4/market-analyses', correlation_id: id, retryable: known.status >= 500 }
  try { return reply.type('application/problem+json').code(known.status).send(contract.response(operation, body, known.status, 'application/problem+json')) }
  catch {
    const fallback = { ...body, type: 'urn:aurum:problem:api_response_invalid', code: 'api_response_invalid', detail: 'api_response_invalid', status: 503, correlation_id: randomUUID(), retryable: true }
    return reply.type('application/problem+json').code(503).send(contract.response(operation, fallback, 503, 'application/problem+json'))
  }
}

function writeProblem(error: unknown, id: string, reply: FastifyReply, contract: ReturnType<typeof createHttpContractValidator>, operation: string) {
  const known = error instanceof InferenceError || error instanceof StrategyAccessError || error instanceof AuthError || error instanceof HttpContractError
    ? error : new InferenceError('inference_unavailable', 503)
  const body = { type: `urn:aurum:problem:${known.code}`, title: 'Inference submission failed', status: known.status, code: known.code,
    detail: known.status >= 500 ? '暂时无法确认结果，请保留原请求编号和内容。' : known.code,
    instance: '/api/v4', correlation_id: id, retryable: known.status >= 500 || known.status === 429,
    ...(known instanceof InferenceError && known.retryAfterMs !== undefined ? { retry_after_ms: known.retryAfterMs } : {}) }
  try { return reply.type('application/problem+json').code(known.status).send(contract.response(operation, body, known.status, 'application/problem+json')) }
  catch {
    const fallback = { type: 'urn:aurum:problem:inference_commit_unknown', title: 'Inference submission result unknown', status: 503,
      code: 'inference_commit_unknown', detail: '暂时无法确认结果，请保留原请求编号和内容。', instance: '/api/v4', correlation_id: randomUUID(), retryable: true }
    return reply.type('application/problem+json').code(503).send(contract.response(operation, fallback, 503, 'application/problem+json'))
  }
}
