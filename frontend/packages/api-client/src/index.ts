import {
  analysisJobResponseSchema, apiProblemSchema, authLoginResponseSchema, connectionCapacityResponseSchema,
  marketAnalysisDetailResponseSchema, marketAnalysisListResponseSchema, marketCandlesResponseSchema,
  marketQuoteResponseSchema, observerChannelsResponseSchema, realtimeTicketResponseSchema, sessionResponseSchema,
  strategiesResponseSchema, terminalProfilesResponseSchema, tradingAccountsResponseSchema, tradingContextResponseSchema,
  traderDecisionDetailResponseSchema, traderDecisionListResponseSchema, tradingWorkspaceResponseSchema,
} from '@aurum/contracts'
import type { AnalysisJobCreate, ApiProblem, AuthLoginRequest, StrategyKind } from '@aurum/contracts'
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
    listStrategies: (kind?: StrategyKind) => send(strategiesResponseSchema, `/api/v4/strategies${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`),
    listMarketAnalyses: (pageSize = 50) => send(marketAnalysisListResponseSchema, `/api/v4/market-analyses?page_size=${Math.min(Math.max(Math.trunc(pageSize), 1), 100)}`),
    getMarketAnalysis: (analysisId: string) => send(marketAnalysisDetailResponseSchema, `/api/v4/market-analyses/${encodeURIComponent(analysisId)}`),
    listTradeDecisions: (accountId: string, pageSize = 50) => send(traderDecisionListResponseSchema, `/api/v4/trade-decisions?account_id=${encodeURIComponent(accountId)}&page_size=${Math.min(Math.max(Math.trunc(pageSize), 1), 100)}`),
    getTradeDecision: (decisionId: string) => send(traderDecisionDetailResponseSchema, `/api/v4/trade-decisions/${encodeURIComponent(decisionId)}`),
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
