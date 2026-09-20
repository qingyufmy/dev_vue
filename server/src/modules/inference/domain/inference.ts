import { InferenceError } from './inference-error.js'
import { resolveEntryEventClaims } from './entry-event-claims.js'
import { createHash } from 'node:crypto'
import { positivePercent } from '../../../shared/positive-percent.js'
import type { SubscriptionExecutionPreferences } from '../../strategies/index.js'
import { parseStrategyEntryMethods, entryMethodForAction, type StrategyEntryMethod } from '../../strategies/index.js'

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
  bullishScore?: number | null
  bearishScore?: number | null
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
  chart?: ReturnType<typeof import('./analysis-chart.js').analysisChart>
  summary: MarketAnalysisSummary
  result: MarketAnalysisResult
}

export interface TraderAction {
  actionId: string
  kind: TraderExecutableActionKind
  parameters: JsonObject
  expectedState: JsonObject
}

export interface TraderExpectedState {
  analysisRevision: number
  subscriptionRevision: number
  accountRevision: number
  positionsRevision: number
  pendingOrdersRevision: number
  quoteRevision: number
  contractRevision: number
  riskRevision: number
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
  /** Historical absence is not a request to read today's memory. */
  strategyMemory?: JsonObject
  strategy: { id: string; versionId: string; promptHash: string; promptText: string }
  market: JsonObject
  macro: JsonObject | null
  capturedAt: string
}

export interface TraderInputSnapshot {
  entryEventUsage?: JsonObject
  entryEventPolicy?: { version: 1; mode: 'required'; timeframe: string }
  /** Objective event identities from the original analysis snapshot, not model-authored keys. */
  marketEntryEvents?: JsonObject
  /** Exact current-account creation evidence; absent in historical snapshots. */
  accountPositionEntryEvidence?: JsonObject
  /** Strategy reference observations are never the executable account inventory. */
  strategyReferencePortfolio?: JsonObject
  /** Current immutable memory evidence captured before model invocation. */
  strategyMemory?: JsonObject
  entryMethods?: StrategyEntryMethod[]
  /** Explicitly frozen preferences only; historical absence is not a default. */
  executionPreferences?: SubscriptionExecutionPreferences
  /** Missing only in historical snapshots, never inferred from today's settings. */
  subscriptionWindowHash?: string
  /** Frozen current configuration; historical absence must not be filled from today's version. */
  strategyConfigHash?: string
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
  analysisRevision: number
  subscriptionRevision: number
  accountRevision: number
  positionsRevision: number
  pendingOrdersRevision: number
  quoteRevision: number
  contractRevision: number
  riskRevision: number
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
  analysisRevision: number
  accountRevision: number | null
  quoteRevision: number | null
  contractRevision: number | null
  riskRevision: number | null
  positionsRevision: number
  pendingOrdersRevision: number
  status: InferenceRunStatus
  inputSnapshotId: string | null
  modelTaskId: string | null
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
  staleReason: string | null
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

export interface TraderWorkClaim {
  run: TraderRun
  taskId: string
  attemptId: string
  attemptNumber: number
  fencingToken: number
}

export { InferenceError } from './inference-error.js'

export function normalizeSymbol(value: string) {
  const symbol = value.trim().toUpperCase()
  if (!/^[A-Z0-9._-]{1,64}$/.test(symbol)) throw new InferenceError('symbol_invalid', 422)
  return symbol
}

export function assertConfidence(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new InferenceError('confidence_invalid', 422)
}

export function assertMarketAnalysisResult(value: MarketAnalysisResult) {
  const scores = [value.bullishScore, value.bearishScore]
  if (!scores.every(score => score == null) && (!scores.every(score => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100) || Number(value.bullishScore) + Number(value.bearishScore) <= 0)) throw new InferenceError('analysis_direction_scores_invalid', 422)
  if (!['bullish', 'bearish', 'neutral', 'uncertain'].includes(value.marketBias)) throw new InferenceError('market_bias_invalid', 422)
  if (!['none', 'long_setup', 'short_setup'].includes(value.opportunity)) throw new InferenceError('market_opportunity_invalid', 422)
  if (![value.summary, value.marketRegime, value.analysisBody].every(item => typeof item === 'string')) throw new InferenceError('analysis_text_invalid', 422)
  if (![value.supportingEvidence, value.counterEvidence, value.dataGaps].every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))) throw new InferenceError('analysis_evidence_invalid', 422)
  if (!isJsonObject(value.keyLevels) || !isJsonObject(value.invalidation)) throw new InferenceError('analysis_structure_invalid', 422)
}

const traderActionKinds = new Set<TraderActionKind>(['hold', 'market_order', 'pending_order', 'modify_position', 'close_position', 'modify_order', 'cancel_order'])
const traderExecutableActionKinds = new Set<TraderExecutableActionKind>(['market_order', 'pending_order', 'modify_position', 'close_position', 'modify_order', 'cancel_order'])
const expectedStateKeys: Array<keyof TraderExpectedState> = ['analysisRevision', 'subscriptionRevision', 'accountRevision', 'positionsRevision', 'pendingOrdersRevision', 'quoteRevision', 'contractRevision', 'riskRevision']

export function assertTraderDecisionResult(value: TraderDecisionResult, snapshot: TraderInputSnapshot) {
  if (!traderActionKinds.has(value.action)) throw new InferenceError('trader_action_invalid', 422)
  if (value.side !== null && value.side !== 'buy' && value.side !== 'sell') throw new InferenceError('trader_side_invalid', 422)
  if (![value.summary, value.reasoning].every(item => typeof item === 'string' && item.trim().length > 0)) throw new InferenceError('trader_text_invalid', 422)
  if (!Array.isArray(value.actions) || value.actions.length > 16) throw new InferenceError('trader_actions_invalid', 422)
  if (value.action === 'hold' && (value.side !== null || value.actions.length > 0)) throw new InferenceError('hold_actions_forbidden', 422)
  if (value.action !== 'hold' && value.actions.length === 0) throw new InferenceError('trader_actions_required', 422)
  if (value.action !== 'hold' && !value.actions.some(action => action.kind === value.action)) throw new InferenceError('trader_action_summary_mismatch', 422)
  let entryMethods: StrategyEntryMethod[] | undefined
  if (snapshot.entryMethods !== undefined) {
    try { entryMethods = parseStrategyEntryMethods(snapshot.entryMethods) }
    catch { throw new InferenceError('strategy_entry_methods_invalid', 422) }
  }
  const actionIds = new Set<string>()
  const expected: TraderExpectedState = {
    analysisRevision: snapshot.analysisRevision, subscriptionRevision: snapshot.subscriptionRevision,
    accountRevision: snapshot.accountRevision, positionsRevision: snapshot.positionsRevision,
    pendingOrdersRevision: snapshot.pendingOrdersRevision, quoteRevision: snapshot.quoteRevision,
    contractRevision: snapshot.contractRevision, riskRevision: snapshot.riskRevision,
  }
  for (const action of value.actions) {
    if (!action.actionId || actionIds.has(action.actionId)) throw new InferenceError('trader_action_id_duplicate', 422)
    actionIds.add(action.actionId)
    if (!traderExecutableActionKinds.has(action.kind) || !isJsonObject(action.parameters) || !isJsonObject(action.expectedState)) throw new InferenceError('trader_action_structure_invalid', 422)
    assertTraderActionParameters(action.kind, action.parameters)
    if (Object.hasOwn(action.parameters, 'after_close_protection') && value.actions.filter(other =>
      ['close_position', 'modify_position'].includes(other.kind) && other.parameters.ticket === action.parameters.ticket).length !== 1) {
      throw new InferenceError('trader_after_close_target_conflict', 422)
    }
    if (entryMethods !== undefined) {
      const method = entryMethodForAction(action.kind, action.parameters.type)
      if (method && !entryMethods.includes(method)) throw new InferenceError('trader_entry_method_forbidden', 422)
    }
    for (const key of expectedStateKeys) {
      if (action.expectedState[key] !== expected[key]) throw new InferenceError('trader_expected_state_mismatch', 422)
    }
  }
  resolveEntryEventClaims(value, snapshot)
}

function assertTraderActionParameters(kind: TraderExecutableActionKind, parameters: JsonObject) {
  const required = (keys: string[]) => {
    if (keys.some(key => typeof parameters[key] !== 'string' || String(parameters[key]).trim().length === 0)) throw new InferenceError('trader_action_parameters_invalid', 422)
  }
  if (Object.hasOwn(parameters, 'after_close_target')) throw new InferenceError('trader_after_close_target_reserved', 422)
  if (Object.hasOwn(parameters, 'after_close_protection')) {
    const protection = parameters.after_close_protection
    const positiveDecimal = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,28})(\.[0-9]{1,18})?$/.test(value) && /[1-9]/.test(value)
    if (kind !== 'close_position' || (!Object.hasOwn(parameters, 'close_percent') && !Object.hasOwn(parameters, 'volume'))
      || (Object.hasOwn(parameters, 'volume') && !positiveDecimal(parameters.volume))
      || !isJsonObject(protection) || Object.keys(protection).length === 0 || Object.keys(protection).length > 2
      || Object.keys(protection).some(key => !['stop_loss', 'take_profit'].includes(key))
      || Object.values(protection).some(value => !positiveDecimal(value))) {
      throw new InferenceError('trader_after_close_protection_invalid', 422)
    }
  }
  const hasTier = Object.hasOwn(parameters, 'position_size_tier')
  if (Object.hasOwn(parameters, 'risk_ceiling_percent')) {
    if (kind !== 'market_order' && kind !== 'pending_order') throw new InferenceError('trader_action_risk_ceiling_kind_invalid', 422)
    try { positivePercent(parameters.risk_ceiling_percent) }
    catch { throw new InferenceError('trader_action_risk_ceiling_invalid', 422) }
  }
  if (Object.hasOwn(parameters, 'close_percent')) {
    if (kind !== 'close_position' || Object.hasOwn(parameters, 'volume')) throw new InferenceError('trader_partial_close_mode_conflict', 422)
    const percent = parameters.close_percent
    if (typeof percent !== 'string' || !/^(?:0|[1-9]\d?)(?:\.\d{1,18})?$/.test(percent) || Number(percent) <= 0) {
      throw new InferenceError('trader_partial_close_percent_invalid', 422)
    }
  }
  if (hasTier) {
    if (kind !== 'market_order' && kind !== 'pending_order') throw new InferenceError('trader_position_tier_action_invalid', 422)
    if (Object.hasOwn(parameters, 'volume') || Object.hasOwn(parameters, 'position_size_factor')) throw new InferenceError('trader_position_size_mode_conflict', 422)
    if (typeof parameters.position_size_tier !== 'string' || !['probe', 'light', 'standard'].includes(parameters.position_size_tier)) throw new InferenceError('trader_position_size_tier_invalid', 422)
    const stop = parameters.stop_loss ?? parameters.sl
    if (typeof stop !== 'string' || !/^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/.test(stop) || Number(stop) <= 0) throw new InferenceError('trader_position_size_stop_required', 422)
  }
  switch (kind) {
    case 'market_order':
      required(['symbol', 'side', ...(hasTier ? [] : ['volume'])])
      if (parameters.side !== 'buy' && parameters.side !== 'sell') throw new InferenceError('trader_action_side_invalid', 422)
      break
    case 'pending_order':
      required(['symbol', 'type', ...(hasTier ? [] : ['volume']), 'price'])
      if (!['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'].includes(String(parameters.type))) throw new InferenceError('trader_pending_type_invalid', 422)
      break
    case 'modify_position': required(['ticket']); break
    case 'close_position': required(['ticket']); break
    case 'modify_order': required(['ticket']); break
    case 'cancel_order': required(['ticket']); break
  }
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
