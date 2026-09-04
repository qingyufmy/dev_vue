export type ReviewKind = 'daily' | 'monthly' | 'manual'
export type ReviewCaseStatus = 'awaiting_evidence' | 'queued' | 'running' | 'awaiting_confirmation' | 'needs_changes' | 'confirmed' | 'failed'
export type ReviewEvidenceStatus = 'pending' | 'incomplete' | 'complete' | 'stale'
export type ReviewConclusion = 'effective' | 'mixed' | 'ineffective' | 'insufficient_evidence' | 'manual_trade_reviewed'
export type ReviewAssessment = 'effective' | 'mixed' | 'problem' | 'insufficient_evidence' | 'not_applicable'
export type ReviewCandidateKind = 'missed_opportunity' | 'false_positive'

export interface ReviewCaseSummary {
  id: string
  kind: ReviewKind
  userId: number
  tradingAccountId: string
  accountLabel: string
  standardSymbol: string | null
  subscriptionId: string | null
  subscriptionRevision: number | null
  analysisStrategyId: string | null
  analysisStrategyName: string | null
  traderStrategyId: string | null
  traderStrategyName: string | null
  terminalPeriodStart: string
  terminalPeriodEnd: string
  terminalTimezoneOffsetMinutes: number
  status: ReviewCaseStatus
  evidenceStatus: ReviewEvidenceStatus
  evidenceRevision: number
  evidenceHash: string | null
  currentVersionId: string | null
  confirmedVersionId: string | null
  updatedAt: string
  revision: number
}

export interface ReviewRoleResult {
  assessment: ReviewAssessment
  summary: string
  evidenceRefs: string[]
}

export interface ReviewCounterexampleCandidate {
  kind: ReviewCandidateKind
  title: string
  summary: string
  evidenceRefs: string[]
  status: 'candidate' | 'supported' | 'rejected'
}

export interface ReviewMemoryCandidate {
  strategyId: string
  memoryKey: string
  updateKind: 'short_term' | 'long_term_candidate' | 'monthly_summary' | 'platform_candidate'
  title: string
  content: string
  evidenceRefs: string[]
}

export interface ReviewTradeEpisode {
  sourceId: string
  symbol: string
  side: 'buy' | 'sell' | 'none'
  openedAt: string | null
  closedAt: string | null
  netProfit: string | null
  outcome: 'win' | 'loss' | 'breakeven' | 'not_executed' | 'unknown'
  summary: string
}

export interface ReviewContent {
  schemaVersion: 'review.v4.1'
  conclusion: ReviewConclusion
  headline: string
  summary: string
  metrics: {
    netProfit: string | null
    tradeCount: number
    winRatePercent: string | null
    profitFactor: string | null
  }
  tradeEpisodes: ReviewTradeEpisode[]
  roles: {
    analyst: ReviewRoleResult
    trader: ReviewRoleResult
    risk: ReviewRoleResult
    execution: ReviewRoleResult
  }
  counterexamples: ReviewCounterexampleCandidate[]
  memoryCandidates: ReviewMemoryCandidate[]
  evidenceRefs: string[]
  fullAnalysisText: string
}

export interface ReviewVersion {
  id: string
  caseId: string
  versionNumber: number
  authorKind: 'ai' | 'user'
  conclusion: ReviewConclusion
  content: ReviewContent
  createdAt: string
}

export interface ReviewSource {
  kind: 'market_analysis' | 'trade_decision' | 'risk_decision' | 'execution_outcome' | 'terminal_trade' | 'period_review'
  sourceId: string
  relation: 'direct' | 'counterexample' | 'missed_opportunity' | 'false_positive'
  evidenceHash: string
}

export interface ReviewJobSummary {
  id: string
  generation: number
  mode: 'initial' | 'retry' | 'refresh_evidence'
  status: 'queued' | 'preparing_evidence' | 'waiting_model' | 'validating' | 'succeeded' | 'retry_wait' | 'failed' | 'cancelled' | 'completed_stale'
  progressPercent: number
  currentStage: string
  lastErrorCode: string | null
  updatedAt: string
}

export interface ReviewCaseDetail {
  summary: ReviewCaseSummary
  currentVersion: ReviewVersion | null
  sources: ReviewSource[]
  currentJob: ReviewJobSummary | null
  returnReason: string | null
}

export interface ManualReviewCandidate {
  id: string
  tradingAccountId: string
  accountLabel: string
  ticket: string
  positionId: string | null
  symbol: string
  side: 'buy' | 'sell'
  volume: string
  openedAt: string
  closedAt: string
  netProfit: string
  terminalTimezoneOffsetMinutes: number
  sourceClassification: 'manual' | 'system' | 'other_ea' | 'unknown'
  eligibilityStatus: 'eligible' | 'incomplete' | 'already_reviewed'
  selectionToken: string
  selectionExpiresAt: string
  revision: number
}

export interface StrategyMemorySummary {
  id: string
  strategyId: string
  strategyName: string
  strategyKind: 'analysis' | 'trader'
  ownerUserId: number | null
  mode: 'off' | 'shadow' | 'active'
  status: 'active' | 'revalidating' | 'retired'
  currentVersionNumber: number
  pendingCount: number
  updatedAt: string
  revision: number
}

export interface StrategyMemoryDetail extends StrategyMemorySummary {
  currentRevisionId: string | null
  contentText: string
  contentHash: string | null
  maxContextTokens: number
}

export interface StrategyMemoryProposal {
  memoryKey: string
  title: string
  content: string
  evidenceRefs: string[]
}

export interface StrategyMemoryConflict {
  type: 'same_key_content_changed'
  priorUpdateId: string
  memoryKey: string
}

export interface StrategyMemoryUpdate {
  id: string
  libraryId: string
  sourceReviewCaseId: string
  sourceReviewVersionId: string
  updateKind: ReviewMemoryCandidate['updateKind']
  status: 'collecting_evidence' | 'awaiting_confirmation' | 'accepted' | 'rejected' | 'merged' | 'superseded'
  expectedLibraryRevision: number
  proposal: StrategyMemoryProposal
  diffPreviewText: string
  conflicts: StrategyMemoryConflict[]
  createdAt: string
  revision: number
}

export class ReviewError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code) }
}

export function assertReviewContent(value: unknown): asserts value is ReviewContent {
  if (!value || typeof value !== 'object') throw new ReviewError('review_content_schema_invalid', 422)
  const content = value as Partial<ReviewContent>
  if (content.schemaVersion !== 'review.v4.1') throw new ReviewError('review_content_schema_invalid', 422)
  if (!content.conclusion || !['effective', 'mixed', 'ineffective', 'insufficient_evidence', 'manual_trade_reviewed'].includes(content.conclusion)) throw new ReviewError('review_conclusion_invalid', 422)
  if (typeof content.headline !== 'string' || !content.headline.trim() || content.headline.length > 300 || typeof content.summary !== 'string' || !content.summary.trim() || content.summary.length > 5000 || typeof content.fullAnalysisText !== 'string' || content.fullAnalysisText.length > 500_000) throw new ReviewError('review_content_text_invalid', 422)
  if (!content.metrics || !Number.isSafeInteger(content.metrics.tradeCount) || content.metrics.tradeCount < 0) throw new ReviewError('review_metrics_invalid', 422)
  if (!Array.isArray(content.tradeEpisodes) || !Array.isArray(content.counterexamples) || !Array.isArray(content.memoryCandidates) || !Array.isArray(content.evidenceRefs) || content.tradeEpisodes.length > 500 || content.counterexamples.length > 100 || content.memoryCandidates.length > 100 || content.evidenceRefs.length > 2000) throw new ReviewError('review_content_limit_exceeded', 422)
  if (!nullableDecimal(content.metrics.netProfit) || !nullableDecimal(content.metrics.winRatePercent) || !nullableDecimal(content.metrics.profitFactor)) throw new ReviewError('review_metrics_invalid', 422)
  if (!content.evidenceRefs.every(evidenceRef)) throw new ReviewError('review_evidence_reference_invalid', 422)
  if (!content.tradeEpisodes.every(episode => episode && typeof episode.sourceId === 'string' && episode.sourceId.length > 0
    && typeof episode.symbol === 'string' && episode.symbol.length > 0 && ['buy', 'sell', 'none'].includes(episode.side)
    && nullableIsoDate(episode.openedAt) && nullableIsoDate(episode.closedAt) && nullableDecimal(episode.netProfit)
    && ['win', 'loss', 'breakeven', 'not_executed', 'unknown'].includes(episode.outcome)
    && typeof episode.summary === 'string' && episode.summary.length <= 5000)) throw new ReviewError('review_trade_episode_invalid', 422)
  if (!content.roles || !['analyst', 'trader', 'risk', 'execution'].every(role => {
    const result = content.roles?.[role as keyof ReviewContent['roles']]
    return result && ['effective', 'mixed', 'problem', 'insufficient_evidence', 'not_applicable'].includes(result.assessment)
      && typeof result.summary === 'string' && result.summary.length <= 5000 && hasEvidenceRefs(result)
  })) throw new ReviewError('review_roles_invalid', 422)
  if (!content.counterexamples.every(candidate => hasEvidenceRefs(candidate)
    && ['missed_opportunity', 'false_positive'].includes(candidate.kind)
    && typeof candidate.title === 'string' && candidate.title.trim().length > 0 && candidate.title.length <= 300
    && typeof candidate.summary === 'string' && candidate.summary.length <= 5000
    && ['candidate', 'supported', 'rejected'].includes(candidate.status))
    || !content.memoryCandidates.every(candidate => hasEvidenceRefs(candidate)
    && typeof candidate.strategyId === 'string' && candidate.strategyId.length > 0
    && typeof candidate.memoryKey === 'string' && /^[a-z0-9][a-z0-9._:-]{2,190}$/.test(candidate.memoryKey)
    && typeof candidate.title === 'string' && candidate.title.trim().length > 0 && candidate.title.length <= 300
    && typeof candidate.content === 'string' && candidate.content.trim().length > 0 && candidate.content.length <= 20_000
    && ['short_term', 'long_term_candidate', 'monthly_summary', 'platform_candidate'].includes(candidate.updateKind))) throw new ReviewError('review_memory_candidate_invalid', 422)
  const evidence = new Set(content.evidenceRefs)
  const referenced = [
    ...Object.values(content.roles).flatMap(role => role.evidenceRefs),
    ...content.counterexamples.flatMap(item => item.evidenceRefs),
    ...content.memoryCandidates.flatMap(item => item.evidenceRefs),
  ]
  if (referenced.some(item => !evidence.has(item))) throw new ReviewError('review_evidence_reference_invalid', 422)
}

function hasEvidenceRefs(value: unknown): value is { evidenceRefs: string[] } {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { evidenceRefs?: unknown }).evidenceRefs) && (value as { evidenceRefs: unknown[] }).evidenceRefs.length <= 2000 && (value as { evidenceRefs: unknown[] }).evidenceRefs.every(evidenceRef))
}

function evidenceRef(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 }
function nullableDecimal(value: unknown) { return value === null || typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) }
function nullableIsoDate(value: unknown) { return value === null || typeof value === 'string' && !Number.isNaN(Date.parse(value)) }

export function assertGenerationMode(value: string): asserts value is 'retry' | 'refresh_evidence' {
  if (value !== 'retry' && value !== 'refresh_evidence') throw new ReviewError('review_generation_mode_invalid', 422)
}

export function reviewContentFromWire(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const input = value as Record<string, unknown>
  const metrics = record(input.metrics); const roles = record(input.roles)
  const role = (value: unknown) => { const item = record(value); return { assessment: item.assessment, summary: item.summary, evidenceRefs: item.evidence_refs } }
  return {
    schemaVersion: input.schema_version, conclusion: input.conclusion, headline: input.headline, summary: input.summary,
    metrics: { netProfit: metrics.net_profit, tradeCount: metrics.trade_count, winRatePercent: metrics.win_rate_percent, profitFactor: metrics.profit_factor },
    tradeEpisodes: list(input.trade_episodes).map(value => { const item = record(value); return { sourceId: item.source_id, symbol: item.symbol, side: item.side, openedAt: item.opened_at, closedAt: item.closed_at, netProfit: item.net_profit, outcome: item.outcome, summary: item.summary } }),
    roles: { analyst: role(roles.analyst), trader: role(roles.trader), risk: role(roles.risk), execution: role(roles.execution) },
    counterexamples: list(input.counterexamples).map(value => { const item = record(value); return { kind: item.kind, title: item.title, summary: item.summary, evidenceRefs: item.evidence_refs, status: item.status } }),
    memoryCandidates: list(input.memory_candidates).map(value => { const item = record(value); return { strategyId: item.strategy_id, memoryKey: item.memory_key, updateKind: item.update_kind, title: item.title, content: item.content, evidenceRefs: item.evidence_refs } }),
    evidenceRefs: input.evidence_refs, fullAnalysisText: input.full_analysis_text,
  }
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
