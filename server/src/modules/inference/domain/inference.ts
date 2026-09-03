import { createHash } from 'node:crypto'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type AnalysisTrigger = 'manual' | 'scheduled' | 'event'
export type InferenceRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
export type MarketBias = 'bullish' | 'bearish' | 'neutral' | 'uncertain'
export type MarketRecommendation = 'observe' | 'long_candidate' | 'short_candidate' | 'manage_existing'
export type TraderActionKind = 'hold' | 'market_order' | 'pending_order' | 'modify_position' | 'close_position' | 'modify_order' | 'cancel_order'
export type TraderExecutableActionKind = Exclude<TraderActionKind, 'hold'>
export type TraderDecisionStatus = 'proposed' | 'stale' | 'risk_rejected' | 'accepted'

export interface AnalysisRun {
  id: string
  userId: number
  strategyId: string
  strategyVersionId: string
  symbol: string
  trigger: AnalysisTrigger
  status: InferenceRunStatus
  inputSnapshotId: string | null
  marketAnalysisId: string | null
  createdAt: string
  updatedAt: string
  revision: number
}

export interface MarketAnalysisSummary {
  id: string
  userId: number
  strategyId: string
  strategyVersionId: string
  symbol: string
  marketBias: MarketBias
  recommendation: MarketRecommendation
  confidence: number
  summary: string
  analyzedAt: string
  validUntil: string
  inputSnapshotHash: string
  revision: number
}

export interface MarketAnalysisResult {
  marketBias: MarketBias
  recommendation: MarketRecommendation
  confidence: number
  summary: string
  marketRegime: string
  supportingEvidence: string[]
  counterEvidence: string[]
  keyLevels: JsonObject
  invalidation: JsonObject
  dataGaps: string[]
  analysisBody: string
  analyzedAt: string
  validUntil: string
}

export interface MarketAnalysisDetail {
  summary: MarketAnalysisSummary
  result: MarketAnalysisResult
}

export interface TraderAction {
  actionId: string
  kind: TraderExecutableActionKind
  parameters: JsonObject
  expectedState: JsonObject
}

export interface TraderDecisionResult {
  action: TraderActionKind
  side: 'buy' | 'sell' | null
  confidence: number
  summary: string
  actions: TraderAction[]
  reasoning: string
}

export interface AnalysisInputSnapshot {
  kind: 'analysis'
  strategy: { id: string; versionId: string; promptHash: string; promptText: string }
  market: JsonObject
  macro: JsonObject | null
  capturedAt: string
}

export interface TraderInputSnapshot {
  kind: 'trader'
  strategy: { id: string; versionId: string; promptHash: string; promptText: string }
  analysis: { id: string; contentHash: string; result: JsonObject }
  account: JsonObject
  positions: JsonObject[]
  pendingOrders: JsonObject[]
  quote: JsonObject
  contract: JsonObject
  risk: JsonObject
  subscriptionRevision: number
  capturedAt: string
}

export type InferenceInputSnapshot = AnalysisInputSnapshot | TraderInputSnapshot

export interface TraderRun {
  id: string
  userId: number
  tradingAccountId: string
  subscriptionId: string
  subscriptionRevision: number
  marketAnalysisId: string
  strategyId: string
  strategyVersionId: string
  status: InferenceRunStatus
  inputSnapshotId: string | null
  decisionId: string | null
  createdAt: string
  updatedAt: string
  revision: number
}

export interface TraderDecisionSummary {
  id: string
  userId: number
  tradingAccountId: string
  marketAnalysisId: string
  strategyId: string
  strategyVersionId: string
  action: TraderActionKind
  side: 'buy' | 'sell' | null
  confidence: number
  summary: string
  status: TraderDecisionStatus
  inputSnapshotHash: string
  createdAt: string
  revision: number
}

export interface TraderDecisionDetail {
  summary: TraderDecisionSummary
  result: TraderDecisionResult
}

export class InferenceError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly retryAfterMs?: number) {
    super(code)
  }
}

export function normalizeSymbol(value: string) {
  const symbol = value.trim().toUpperCase()
  if (!/^[A-Z0-9._-]{1,64}$/.test(symbol)) throw new InferenceError('symbol_invalid', 422)
  return symbol
}

export function assertConfidence(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new InferenceError('confidence_invalid', 422)
}

const forbiddenContextKeys = new Set(['conversation_id', 'previous_response_id', 'thread_id', 'chat_history', 'messages'])

export function assertExplicitSnapshot(value: InferenceInputSnapshot) {
  const visit = (node: JsonValue | InferenceInputSnapshot | object): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return }
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      if (forbiddenContextKeys.has(key)) throw new InferenceError('implicit_model_context_forbidden', 422)
      visit(child as JsonValue)
    }
  }
  visit(value)
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

export function contentHash(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function snapshotHash(value: InferenceInputSnapshot) {
  assertExplicitSnapshot(value)
  return contentHash(value)
}
