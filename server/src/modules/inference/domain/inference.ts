import { createHash } from 'node:crypto'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type AnalysisTrigger = 'manual' | 'scheduled' | 'event'
export type InferenceRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
export type MarketBias = 'bullish' | 'bearish' | 'neutral' | 'uncertain'
export type MarketOpportunity = 'none' | 'long_setup' | 'short_setup'
export type TraderActionKind = 'hold' | 'market_order' | 'pending_order' | 'modify_position' | 'close_position' | 'modify_order' | 'cancel_order'
export type TraderExecutableActionKind = Exclude<TraderActionKind, 'hold'>
export type TraderDecisionStatus = 'proposed' | 'stale' | 'risk_rejected' | 'accepted'
export type TraderTaskMode = 'entry' | 'manage' | 'both'

export interface AnalysisRun {
  id: string
  userId: number
  strategyId: string
  strategyVersionId: string
  symbol: string
  marketSourceAccountId: string | null
  trigger: AnalysisTrigger
  scheduleSlot: string | null
  status: InferenceRunStatus
  inputSnapshotId: string | null
  modelTaskId: string | null
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
  opportunity: MarketOpportunity
  confidence: number
  summary: string
  analyzedAt: string
  validUntil: string
  inputSnapshotHash: string
  revision: number
}

export interface MarketAnalysisResult {
  marketBias: MarketBias
  opportunity: MarketOpportunity
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
  taskMode: TraderTaskMode
  strategy: { id: string; versionId: string; promptHash: string; promptText: string }
  analysis: { id: string; contentHash: string; result: JsonObject }
  account: JsonObject
  positions: JsonObject[]
  pendingOrders: JsonObject[]
  quote: JsonObject
  contract: JsonObject
  risk: JsonObject
  subscriptionRevision: number
  positionsRevision: number
  pendingOrdersRevision: number
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
  taskMode: TraderTaskMode
  positionsRevision: number
  pendingOrdersRevision: number
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

export interface AnalysisWorkClaim {
  run: AnalysisRun
  taskId: string
  attemptId: string
  attemptNumber: number
  fencingToken: number
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

export function assertMarketAnalysisResult(value: MarketAnalysisResult) {
  if (!['bullish', 'bearish', 'neutral', 'uncertain'].includes(value.marketBias)) throw new InferenceError('market_bias_invalid', 422)
  if (!['none', 'long_setup', 'short_setup'].includes(value.opportunity)) throw new InferenceError('market_opportunity_invalid', 422)
  if (![value.summary, value.marketRegime, value.analysisBody].every(item => typeof item === 'string')) throw new InferenceError('analysis_text_invalid', 422)
  if (![value.supportingEvidence, value.counterEvidence, value.dataGaps].every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))) throw new InferenceError('analysis_evidence_invalid', 422)
  if (!isJsonObject(value.keyLevels) || !isJsonObject(value.invalidation)) throw new InferenceError('analysis_structure_invalid', 422)
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function traderTaskMode(opportunity: MarketOpportunity, hasPositions: boolean, hasPendingOrders: boolean): TraderTaskMode | null {
  const hasExposure = hasPositions || hasPendingOrders
  if (opportunity === 'none') return hasExposure ? 'manage' : null
  return hasExposure ? 'both' : 'entry'
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
