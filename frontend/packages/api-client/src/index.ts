import {
  analysisJobResponseSchema, apiProblemSchema, authLoginResponseSchema, connectionCapacityResponseSchema,
  marketAnalysisDetailResponseSchema, marketAnalysisListResponseSchema, marketCandlesResponseSchema,
  marketQuoteResponseSchema, observerChannelsResponseSchema, operationResponseSchema, realtimeTicketResponseSchema, sessionResponseSchema,
  executionCommandContextResponseSchema, executionDistributionDetailResponseSchema, executionDistributionPreviewResponseSchema,
  strategyCompileBodySchema, strategyCompileResponseSchema, strategyCreateBodySchema, strategyDetailResponseSchema,
  strategyMetadataPatchBodySchema, strategySubscriptionCreateBodySchema, strategySubscriptionPatchBodySchema,
  strategySubscriptionResponseSchema, strategySubscriptionsResponseSchema, strategyVersionCreateBodySchema,
  strategiesResponseSchema, terminalProfilesResponseSchema, tradingAccountsResponseSchema, tradingContextResponseSchema,
  traderDecisionDetailResponseSchema, traderDecisionListResponseSchema, tradingWorkspaceResponseSchema,
  manualRiskReleaseCreatedResponseSchema, manualRiskReleaseResponseSchema, riskDecisionDetailResponseSchema,
  riskDecisionListResponseSchema, riskManualReleaseBodySchema, riskPolicyPatchBodySchema, riskPolicyResponseSchema,
  riskSummaryResponseSchema,
  manualReviewCandidatesResponseSchema, manualReviewCaseCreateBodySchema,
  reviewCaseDetailResponseSchema, reviewCasesResponseSchema, reviewConfirmBodySchema, reviewGenerationBodySchema,
  reviewReturnBodySchema, reviewVersionCreateBodySchema, strategyMemoriesResponseSchema, strategyMemoryDecisionBodySchema,
  strategyMemoryDetailResponseSchema, strategyMemoryUpdateResponseSchema, strategyMemoryUpdatesResponseSchema,
  tradeHistoryPageResponseSchema, tradeRecordDetailResponseSchema,
} from '@aurum/contracts'
import type {
  AnalysisJobCreate, ApiProblem, AuthLoginRequest, DistributionCloseCommand, ExecutionCommand, ExecutionDistribution,
  ManualReviewCaseCreateBody, ReviewContent, ReviewKind,
  RiskManualReleaseBody, RiskPolicyPatchBody, StrategyCompileBody, StrategyCreateBody, StrategyKind, StrategyMetadataPatchBody,
  StrategySubscriptionCreateBody, StrategySubscriptionPatchBody, StrategyVersionCreateBody,
} from '@aurum/contracts'
import { z, type ZodType } from 'zod'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export class ApiClientError extends Error {
  readonly status: number
  readonly problem: ApiProblem | null

  constructor(status: number, problem: ApiProblem | null) {
    super(problem?.detail ?? `请求失败（HTTP ${status}）`)
    this.name = 'ApiClientError'
    this.status = status
    this.problem = problem
  }
}

export interface ApiClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export interface RequestOptions extends Omit<RequestInit, 'headers'> {
  csrfToken?: string
  headers?: HeadersInit
}

export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = options.baseUrl ?? ''
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  async function send<T>(schema: ZodType<T>, path: string, init: RequestOptions = {}, csrfRequired = true): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    const { csrfToken, ...requestInit } = init

    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    if (csrfRequired && !SAFE_METHODS.has(method)) {
      if (!csrfToken) throw new Error('写操作必须提供当前应用会话的 CSRF Token')
      headers.set('X-CSRF-Token', csrfToken)
    }

    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...requestInit,
      method,
      headers,
      credentials: 'same-origin',
    })
    const payload: unknown = await response.json().catch(() => null)

    if (!response.ok) {
      const problem = apiProblemSchema.safeParse(payload)
      throw new ApiClientError(response.status, problem.success ? problem.data : null)
    }

    return schema.parse(payload)
  }

  return {
    getSession: () => send(sessionResponseSchema, '/api/v4/session'),
    login: (body: AuthLoginRequest) => send(
      authLoginResponseSchema,
      '/api/v4/auth/login',
      { method: 'POST', body: JSON.stringify(body) },
      false,
    ),
    logoutCurrent: (csrfToken: string) => send(
      z.null(),
      '/api/v4/session/logout',
      { method: 'POST', csrfToken },
    ),
    createRealtimeTicket: (csrfToken: string) => send(
      realtimeTicketResponseSchema,
      '/api/v4/realtime/tickets',
      { method: 'POST', csrfToken },
    ),
    getTradingContext: () => send(tradingContextResponseSchema, '/api/v4/trading-context'),
    listTradingAccounts: () => send(tradingAccountsResponseSchema, '/api/v4/trading-accounts'),
    getConnectionCapacity: () => send(connectionCapacityResponseSchema, '/api/v4/bridge/connection-capacity'),
    listTerminalProfiles: () => send(terminalProfilesResponseSchema, '/api/v4/bridge/terminal-profiles'),
    listObserverChannels: () => send(observerChannelsResponseSchema, '/api/v4/observer-channels'),
    getTradingWorkspace: (accountId: string, observerChannelId?: string | null) => send(tradingWorkspaceResponseSchema, `/api/v4/trading-accounts/${encodeURIComponent(accountId)}/snapshot${observerQuery(observerChannelId)}`),
    getMarketQuote: (accountId: string, symbol: string, observerChannelId?: string | null) => send(marketQuoteResponseSchema, `/api/v4/market/quotes/${encodeURIComponent(symbol)}?account_id=${encodeURIComponent(accountId)}${observerQuery(observerChannelId, '&')}`),
    getMarketCandles: (accountId: string, symbol: string, timeframe: string, limit = 200, observerChannelId?: string | null) => send(marketCandlesResponseSchema, `/api/v4/market/candles?account_id=${encodeURIComponent(accountId)}&symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&page_size=${limit}${observerQuery(observerChannelId, '&')}`),
    listTradeHistory: (filter: { accountId: string; symbol?: string; side?: string; source?: string; outcome?: string; fromDate?: string; toDate?: string; query?: string; pageSize?: number; cursor?: string | null }) => {
      const query = new URLSearchParams({ account_id: filter.accountId, page_size: String(Math.min(Math.max(Math.trunc(filter.pageSize ?? 50), 1), 100)) })
      if (filter.symbol) query.set('symbol', filter.symbol)
      if (filter.side) query.set('side', filter.side)
      if (filter.source) query.set('source', filter.source)
      if (filter.outcome) query.set('outcome', filter.outcome)
      if (filter.fromDate) query.set('from_date', filter.fromDate)
      if (filter.toDate) query.set('to_date', filter.toDate)
      if (filter.query) query.set('q', filter.query)
      if (filter.cursor) query.set('cursor', filter.cursor)
      return send(tradeHistoryPageResponseSchema, `/api/v4/trade-history?${query.toString()}`)
    },
    getTradeRecord: (recordId: string) => send(tradeRecordDetailResponseSchema, `/api/v4/trade-history/${encodeURIComponent(recordId)}`),
    listStrategies: (kind?: StrategyKind) => send(strategiesResponseSchema, `/api/v4/strategies${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`),
    getStrategy: (strategyId: string) => send(strategyDetailResponseSchema, `/api/v4/strategies/${encodeURIComponent(strategyId)}`),
    compileStrategy: (csrfToken: string, body: StrategyCompileBody) => {
      const payload = strategyCompileBodySchema.parse(body)
      return send(strategyCompileResponseSchema, '/api/v4/strategies/compile', {
        method: 'POST', csrfToken, body: JSON.stringify(payload),
      })
    },
    createStrategy: (csrfToken: string, body: StrategyCreateBody) => {
      const payload = strategyCreateBodySchema.parse(body)
      return send(strategyDetailResponseSchema, '/api/v4/strategies', {
        method: 'POST', csrfToken, body: JSON.stringify(payload),
      })
    },
    updateStrategyMetadata: (csrfToken: string, strategyId: string, body: StrategyMetadataPatchBody, expectedRevision: number) => {
      const payload = strategyMetadataPatchBodySchema.parse(body)
      return send(strategyDetailResponseSchema, `/api/v4/strategies/${encodeURIComponent(strategyId)}`, {
        method: 'PATCH', csrfToken, headers: { 'If-Match': `"${expectedRevision}"` }, body: JSON.stringify(payload),
      })
    },
    createStrategyVersion: (csrfToken: string, strategyId: string, body: StrategyVersionCreateBody, expectedRevision: number) => {
      const payload = strategyVersionCreateBodySchema.parse(body)
      return send(strategyDetailResponseSchema, `/api/v4/strategies/${encodeURIComponent(strategyId)}/versions`, {
        method: 'POST', csrfToken, headers: { 'If-Match': `"${expectedRevision}"` }, body: JSON.stringify(payload),
      })
    },
    publishStrategyVersion: (csrfToken: string, strategyId: string, versionId: string, expectedRevision: number) => send(
      strategyDetailResponseSchema,
      `/api/v4/strategies/${encodeURIComponent(strategyId)}/versions/${encodeURIComponent(versionId)}/publish`,
      { method: 'POST', csrfToken, headers: { 'If-Match': `"${expectedRevision}"` } },
    ),
    retireStrategy: (csrfToken: string, strategyId: string, expectedRevision: number) => send(
      strategyDetailResponseSchema,
      `/api/v4/strategies/${encodeURIComponent(strategyId)}/retire`,
      { method: 'POST', csrfToken, headers: { 'If-Match': `"${expectedRevision}"` } },
    ),
    listStrategySubscriptions: (tradingAccountId?: string | null) => send(
      strategySubscriptionsResponseSchema,
      tradingAccountId ? `/api/v4/strategy-subscriptions?account_id=${encodeURIComponent(tradingAccountId)}` : '/api/v4/strategy-subscriptions',
    ),
    createStrategySubscription: (csrfToken: string, body: StrategySubscriptionCreateBody) => {
      const payload = strategySubscriptionCreateBodySchema.parse(body)
      return send(strategySubscriptionResponseSchema, '/api/v4/strategy-subscriptions', {
        method: 'POST', csrfToken, body: JSON.stringify(payload),
      })
    },
    updateStrategySubscription: (csrfToken: string, subscriptionId: string, body: StrategySubscriptionPatchBody, expectedRevision: number) => {
      const payload = strategySubscriptionPatchBodySchema.parse(body)
      return send(strategySubscriptionResponseSchema, `/api/v4/strategy-subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: 'PATCH', csrfToken, headers: { 'If-Match': `"${expectedRevision}"` }, body: JSON.stringify(payload),
      })
    },
    listMarketAnalyses: (pageSize = 50) => send(marketAnalysisListResponseSchema, `/api/v4/market-analyses?page_size=${Math.min(Math.max(Math.trunc(pageSize), 1), 100)}`),
    getMarketAnalysis: (analysisId: string) => send(marketAnalysisDetailResponseSchema, `/api/v4/market-analyses/${encodeURIComponent(analysisId)}`),
    getRiskPolicy: (accountId: string) => send(riskPolicyResponseSchema, `/api/v4/risk-accounts/${encodeURIComponent(accountId)}/policy`),
    replaceRiskPolicy: (csrfToken: string, accountId: string, body: RiskPolicyPatchBody, expectedRevision: number) => {
      const payload = riskPolicyPatchBodySchema.parse(body)
      return send(riskPolicyResponseSchema, `/api/v4/risk-accounts/${encodeURIComponent(accountId)}/policy`, {
        method: 'PUT', csrfToken, headers: { 'If-Match': `"${expectedRevision}"` }, body: JSON.stringify(payload),
      })
    },
    getRiskSummary: (accountId: string) => send(riskSummaryResponseSchema, `/api/v4/risk-accounts/${encodeURIComponent(accountId)}/summary`),
    getManualRiskRelease: (accountId: string) => send(manualRiskReleaseResponseSchema, `/api/v4/risk-accounts/${encodeURIComponent(accountId)}/manual-release`),
    createManualRiskRelease: (csrfToken: string, accountId: string, body: RiskManualReleaseBody, expectedSummaryRevision: number, idempotencyKey: string) => {
      const payload = riskManualReleaseBodySchema.parse(body)
      return send(manualRiskReleaseCreatedResponseSchema, `/api/v4/risk-accounts/${encodeURIComponent(accountId)}/manual-release`, {
        method: 'POST', csrfToken, headers: { 'If-Match': `"${expectedSummaryRevision}"`, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(payload),
      })
    },
    listRiskDecisions: (accountId: string, pageSize = 50) => send(riskDecisionListResponseSchema, `/api/v4/risk-decisions?account_id=${encodeURIComponent(accountId)}&page_size=${Math.min(Math.max(Math.trunc(pageSize), 1), 100)}`),
    getRiskDecision: (decisionId: string) => send(riskDecisionDetailResponseSchema, `/api/v4/risk-decisions/${encodeURIComponent(decisionId)}`),
    listTradeDecisions: (accountId: string, pageSize = 50) => send(traderDecisionListResponseSchema, `/api/v4/trade-decisions?account_id=${encodeURIComponent(accountId)}&page_size=${Math.min(Math.max(Math.trunc(pageSize), 1), 100)}`),
    getTradeDecision: (decisionId: string) => send(traderDecisionDetailResponseSchema, `/api/v4/trade-decisions/${encodeURIComponent(decisionId)}`),
    listReviewCases: (filter: { kind?: ReviewKind; accountId?: string; pageSize?: number } = {}) => {
      const query = new URLSearchParams()
      if (filter.kind) query.set('kind', filter.kind)
      if (filter.accountId) query.set('account_id', filter.accountId)
      query.set('page_size', String(Math.min(Math.max(Math.trunc(filter.pageSize ?? 50), 1), 100)))
      return send(reviewCasesResponseSchema, `/api/v4/review-cases?${query.toString()}`)
    },
    getReviewCase: (caseId: string) => send(reviewCaseDetailResponseSchema, `/api/v4/review-cases/${encodeURIComponent(caseId)}`),
    listManualReviewCandidates: (accountId?: string, pageSize = 50) => {
      const query = new URLSearchParams({ page_size: String(Math.min(Math.max(Math.trunc(pageSize), 1), 100)) })
      if (accountId) query.set('account_id', accountId)
      return send(manualReviewCandidatesResponseSchema, `/api/v4/manual-review-candidates?${query.toString()}`)
    },
    createManualReviewCase: (csrfToken: string, body: ManualReviewCaseCreateBody, idempotencyKey: string) => {
      const payload = manualReviewCaseCreateBodySchema.parse(body)
      return send(reviewCaseDetailResponseSchema, '/api/v4/manual-review-cases', { method: 'POST', csrfToken, headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(payload) })
    },
    requestReviewGeneration: (csrfToken: string, caseId: string, mode: 'retry' | 'refresh_evidence', expectedRevision: number) => {
      const payload = reviewGenerationBodySchema.parse({ mode })
      return send(reviewCaseDetailResponseSchema, `/api/v4/review-cases/${encodeURIComponent(caseId)}/generations`, { method: 'POST', csrfToken, headers: { 'If-Match': `"${expectedRevision}"` }, body: JSON.stringify(payload) })
    },
    createReviewVersion: (csrfToken: string, caseId: string, content: ReviewContent, expectedRevision: number) => {
      const payload = reviewVersionCreateBodySchema.parse({ content: reviewContentWire(content) })
      return send(reviewCaseDetailResponseSchema, `/api/v4/review-cases/${encodeURIComponent(caseId)}/versions`, { method: 'POST', csrfToken, headers: { 'If-Match': `"${expectedRevision}"` }, body: JSON.stringify(payload) })
    },
    confirmReviewVersion: (csrfToken: string, caseId: string, versionId: string, expectedRevision: number) => {
      const payload = reviewConfirmBodySchema.parse({ version_id: versionId })
      return send(reviewCaseDetailResponseSchema, `/api/v4/review-cases/${encodeURIComponent(caseId)}/confirm`, { method: 'POST', csrfToken, headers: { 'If-Match': `"${expectedRevision}"` }, body: JSON.stringify(payload) })
    },
    returnReviewCase: (csrfToken: string, caseId: string, reason: string, expectedRevision: number) => {
      const payload = reviewReturnBodySchema.parse({ reason })
      return send(reviewCaseDetailResponseSchema, `/api/v4/review-cases/${encodeURIComponent(caseId)}/return`, { method: 'POST', csrfToken, headers: { 'If-Match': `"${expectedRevision}"` }, body: JSON.stringify(payload) })
    },
    listStrategyMemories: () => send(strategyMemoriesResponseSchema, '/api/v4/strategy-memories'),
    getStrategyMemory: (memoryId: string) => send(strategyMemoryDetailResponseSchema, `/api/v4/strategy-memories/${encodeURIComponent(memoryId)}`),
    listMemoryUpdates: (memoryId: string) => send(strategyMemoryUpdatesResponseSchema, `/api/v4/strategy-memories/${encodeURIComponent(memoryId)}/updates`),
    decideMemoryUpdate: (csrfToken: string, updateId: string, decision: 'accept' | 'reject' | 'revoke', expectedRevision: number) => {
      const payload = strategyMemoryDecisionBodySchema.parse({ decision })
      return send(strategyMemoryUpdateResponseSchema, `/api/v4/strategy-memory-updates/${encodeURIComponent(updateId)}/decision`, { method: 'POST', csrfToken, headers: { 'If-Match': `"${expectedRevision}"` }, body: JSON.stringify(payload) })
    },
    getExecutionCommandContext: (accountId: string, symbol?: string | null, ticket?: string | null) => {
      const query = new URLSearchParams()
      if (symbol) query.set('symbol', symbol)
      if (ticket) query.set('ticket', ticket)
      return send(executionCommandContextResponseSchema, `/api/v4/trading-accounts/${encodeURIComponent(accountId)}/execution-context?${query.toString()}`)
    },
    getOperation: (operationId: string) => send(operationResponseSchema, `/api/v4/operations/${encodeURIComponent(operationId)}`),
    previewExecutionDistribution: (strategyId: string, symbol: string) => send(executionDistributionPreviewResponseSchema, `/api/v4/execution-distributions/preview?strategy_id=${encodeURIComponent(strategyId)}&symbol=${encodeURIComponent(symbol)}`),
    getExecutionDistribution: (distributionId: string) => send(executionDistributionDetailResponseSchema, `/api/v4/execution-distributions/${encodeURIComponent(distributionId)}`),
    createExecutionCommand: (csrfToken: string, accountId: string, body: ExecutionCommand, idempotencyKey: string) => send(
      operationResponseSchema,
      `/api/v4/trading-accounts/${encodeURIComponent(accountId)}/execution-commands`,
      { method: 'POST', csrfToken, headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) },
    ),
    createExecutionDistribution: (csrfToken: string, body: ExecutionDistribution, idempotencyKey: string) => send(
      operationResponseSchema,
      '/api/v4/execution-distributions',
      { method: 'POST', csrfToken, headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) },
    ),
    createDistributionCloseCommand: (csrfToken: string, distributionId: string, body: DistributionCloseCommand, idempotencyKey: string) => send(
      operationResponseSchema,
      `/api/v4/execution-distributions/${encodeURIComponent(distributionId)}/close-commands`,
      { method: 'POST', csrfToken, headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) },
    ),
    createManualAnalysis: (csrfToken: string, body: AnalysisJobCreate, idempotencyKey: string) => send(
      analysisJobResponseSchema,
      '/api/v4/analysis-jobs',
      { method: 'POST', csrfToken, headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) },
    ),
    selectTradingAccount: (csrfToken: string, accountId: string, expectedRevision: number) => send(tradingContextResponseSchema, '/api/v4/trading-context', { method: 'PUT', csrfToken, body: JSON.stringify({ mode: 'full', account_id: accountId, expected_revision: String(expectedRevision) }) }),
    enterObserverMode: (csrfToken: string, observerChannelId: string, expectedRevision: number) => send(tradingContextResponseSchema, '/api/v4/trading-context', { method: 'PUT', csrfToken, body: JSON.stringify({ mode: 'observer', observer_channel_id: observerChannelId, expected_revision: String(expectedRevision) }) }),
    leaveObserverMode: (csrfToken: string, expectedRevision: number) => send(tradingContextResponseSchema, `/api/v4/trading-context/observer?expected_revision=${expectedRevision}`, { method: 'DELETE', csrfToken }),
    request: <T>(schema: ZodType<T>, path: string, init: RequestOptions = {}) => send(schema, path, init, true),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

function observerQuery(observerChannelId?: string | null, prefix = '?') {
  return observerChannelId ? `${prefix}observer_channel_id=${encodeURIComponent(observerChannelId)}` : ''
}

function reviewContentWire(value: ReviewContent) {
  const role = (item: ReviewContent['roles']['analyst']) => ({ assessment: item.assessment, summary: item.summary, evidence_refs: item.evidenceRefs })
  return {
    schema_version: value.schemaVersion, conclusion: value.conclusion, headline: value.headline, summary: value.summary,
    metrics: { net_profit: value.metrics.netProfit, trade_count: value.metrics.tradeCount, win_rate_percent: value.metrics.winRatePercent, profit_factor: value.metrics.profitFactor },
    trade_episodes: value.tradeEpisodes.map(item => ({ source_id: item.sourceId, symbol: item.symbol, side: item.side, opened_at: item.openedAt, closed_at: item.closedAt, net_profit: item.netProfit, outcome: item.outcome, summary: item.summary })),
    roles: { analyst: role(value.roles.analyst), trader: role(value.roles.trader), risk: role(value.roles.risk), execution: role(value.roles.execution) },
    counterexamples: value.counterexamples.map(item => ({ kind: item.kind, title: item.title, summary: item.summary, evidence_refs: item.evidenceRefs, status: item.status })),
    memory_candidates: value.memoryCandidates.map(item => ({ strategy_id: item.strategyId, memory_key: item.memoryKey, update_kind: item.updateKind, title: item.title, content: item.content, evidence_refs: item.evidenceRefs })),
    evidence_refs: value.evidenceRefs, full_analysis_text: value.fullAnalysisText,
  }
}
