import { formatLaboratoryTime } from '~/lib/laboratory-display-time'
import type {
  ManualReviewCandidate as ContractManualReviewCandidate,
  ReviewCaseDetail as ContractReviewCaseDetail,
  ReviewCaseSummary as ContractReviewCaseSummary,
  ReviewContent as ContractReviewContent,
  StrategyMemoryDetail as ContractStrategyMemoryDetail,
  StrategyMemorySummary as ContractStrategyMemorySummary,
  StrategyMemoryUpdate as ContractStrategyMemoryUpdate,
} from '@aurum/contracts'

export type ReviewerSection = 'period' | 'manual' | 'memory'
export type ReviewCaseKind = ContractReviewCaseSummary['kind']
export type ReviewCaseStatus = ContractReviewCaseSummary['status']
export type ReviewAssessment = ContractReviewContent['roles']['analyst']['assessment']
export type ReviewMemoryUpdateKind = ContractReviewContent['memoryCandidates'][number]['updateKind']
export type ReviewMemoryUpdateStatus = ContractStrategyMemoryUpdate['status']
export type ReviewMemoryProposal = ContractStrategyMemoryUpdate['proposal']
export type ReviewMemoryConflict = ContractStrategyMemoryUpdate['conflicts'][number]

export interface ReviewCaseSummary {
  id: string
  kind: ReviewCaseKind
  title: string
  accountId: string
  accountLabel: string
  subscriptionId: string | null
  subscriptionRevision: number | null
  analysisStrategyId: string | null
  traderStrategyId: string | null
  terminalTimezoneOffsetMinutes: number
  terminalPeriod: string
  symbol: string
  strategyLabel: string
  status: ReviewCaseStatus
  currentVersionId: string | null
  revision: number
  itemCount: number | null
  confidence: number | null
  conclusion: string
  updatedAt: string
}

export interface ReviewMetric {
  label: string
  value: string
  hint?: string
}

export interface ReviewLayer {
  key: keyof ContractReviewContent['roles']
  label: string
  assessment: ReviewAssessment
  status: string
  score: number | null
  summary: string
  details: string[]
}

export interface ReviewTradeEpisode {
  id: string
  symbol: string
  direction: string
  source: string
  entryAt: string | null
  exitAt: string | null
  outcome: string
  profit: string
  signalId: string | null
  orderId: string | null
}

export interface ReviewCandidate {
  id: string
  kind: string
  title: string
  summary: string
  evidence: string[]
  confidence: number | null
  strategyId?: string
  memoryKey?: string
  updateKind?: ReviewMemoryUpdateKind
}

export interface ReviewEvidence {
  id: string
  kind: string
  label: string
  sourceId: string
  occurredAt: string | null
  summary: string
  complete: boolean
}

export interface ReviewVersionSummary {
  id: string
  version: number
  status: string
  createdAt: string | null
  changeNote: string
}

export interface ReviewCaseDetail extends ReviewCaseSummary {
  /** The exact structured content returned by the V4 detail endpoint. */
  content: ContractReviewContent | null
  conclusion: string
  keyFindings: string[]
  metrics: ReviewMetric[]
  layers: ReviewLayer[]
  episodes: ReviewTradeEpisode[]
  falsePositiveCandidates: ReviewCandidate[]
  missedOpportunityCandidates: ReviewCandidate[]
  memoryCandidates: ReviewCandidate[]
  evidence: ReviewEvidence[]
  versions: ReviewVersionSummary[]
  fullText: string
  evidenceRevision: number
  evidenceHash: string | null
}

export interface ManualReviewCandidate {
  id: string
  accountId: string
  accountLabel: string
  symbol: string
  direction: string
  positionId: string | null
  entryAt: string
  exitAt: string
  volume: string
  netProfit: string
  terminalTimezoneOffsetMinutes: number
  sourceStatus: string
  selectionToken: string
  ticket: string
  canReview: boolean
}

export interface StrategyMemorySummary {
  id: string
  strategyId: string
  strategyLabel: string
  version: number
  status: string
  summary: string
  updatedAt: string
  pendingCount: number
}

export interface MemoryUpdate {
  id: string
  strategyMemoryId: string
  kind: string
  title: string
  summary: string
  evidence: string[]
  conflict: string | null
  proposal: ReviewMemoryProposal
  conflicts: ReviewMemoryConflict[]
  sourceReviewCaseId: string
  sourceReviewVersionId: string
  status: ReviewMemoryUpdateStatus
  createdAt: string
  revision: number
  expectedLibraryRevision: number
}

export interface StrategyMemoryDetail extends StrategyMemorySummary {
  content: string
  revisions: Array<{ id: string; version: number; status: string; createdAt: string | null }>
  updates: MemoryUpdate[]
}

const REVIEW_ROLE_KEYS = ['analyst', 'trader', 'risk', 'execution'] as const

function terminalPeriodLabel(value: string, kind: ReviewCaseKind, offset: number): string {
  const date = formatLaboratoryTime(value, offset).slice(0, 10)
  return kind === 'monthly' ? date.slice(0, 7) : date
}

function strategyLabel(value: ContractReviewCaseSummary): string {
  return value.analysisStrategyName ?? value.traderStrategyName ?? '未标记策略'
}

export function mapReviewCaseSummary(value: ContractReviewCaseSummary): ReviewCaseSummary {
  return {
    id: value.id,
    kind: value.kind,
    title: caseKindLabel(value.kind),
    accountId: value.tradingAccountId,
    accountLabel: value.accountLabel,
    subscriptionId: value.subscriptionId,
    subscriptionRevision: value.subscriptionRevision,
    analysisStrategyId: value.analysisStrategyId,
    traderStrategyId: value.traderStrategyId,
    terminalTimezoneOffsetMinutes: value.terminalTimezoneOffsetMinutes,
    terminalPeriod: terminalPeriodLabel(value.terminalPeriodStart, value.kind, value.terminalTimezoneOffsetMinutes),
    symbol: value.symbol ?? '多品种',
    strategyLabel: strategyLabel(value),
    status: value.status,
    currentVersionId: value.currentVersionId,
    revision: value.revision,
    itemCount: null,
    confidence: null,
    conclusion: '',
    updatedAt: value.updatedAt,
  }
}

function metric(label: string, value: string | number | null, hint?: string): ReviewMetric {
  return { label, value: value === null ? '--' : String(value), ...(hint ? { hint } : {}) }
}

function reviewMetrics(summary: ContractReviewCaseSummary, content: ContractReviewContent | null): ReviewMetric[] {
  if (!content) return []
  return [
    metric('净盈亏', content.metrics.netProfit),
    metric('交易笔数', content.metrics.tradeCount),
    metric('胜率', content.metrics.winRatePercent === null ? null : `${content.metrics.winRatePercent}%`),
    metric('盈亏比', content.metrics.profitFactor),
    metric('证据状态', reviewEvidenceStatusLabel(summary.evidenceStatus)),
  ]
}

type ContractReviewEpisode = ContractReviewContent['tradeEpisodes'][number]
type ContractReviewCounterexample = ContractReviewContent['counterexamples'][number]
type ContractReviewMemoryCandidate = ContractReviewContent['memoryCandidates'][number]
type ContractReviewSource = ContractReviewCaseDetail['sources'][number]

function mapLayer(value: ContractReviewContent['roles'][typeof REVIEW_ROLE_KEYS[number]], key: typeof REVIEW_ROLE_KEYS[number]): ReviewLayer {
  return {
    key,
    label: reviewLayerLabel(key),
    assessment: value.assessment,
    status: reviewAssessmentLabel(value.assessment),
    score: null,
    summary: value.summary,
    details: value.evidenceRefs,
  }
}

function mapEpisode(value: ContractReviewEpisode): ReviewTradeEpisode {
  return {
    id: value.sourceId,
    symbol: value.symbol,
    direction: reviewDirectionLabel(value.side),
    source: '交易事实',
    entryAt: value.openedAt,
    exitAt: value.closedAt,
    outcome: reviewOutcomeLabel(value.outcome),
    profit: value.netProfit ?? '--',
    signalId: null,
    orderId: null,
  }
}

function mapCounterexample(value: ContractReviewCounterexample, index: number): ReviewCandidate {
  return {
    id: `${value.kind}-${index + 1}`,
    kind: value.kind,
    title: value.title,
    summary: value.summary,
    evidence: value.evidenceRefs,
    confidence: null,
  }
}

function mapMemoryCandidate(value: ContractReviewMemoryCandidate, index: number): ReviewCandidate {
  return {
    id: `${value.memoryKey}-${index + 1}`,
    kind: value.updateKind,
    title: value.title,
    summary: value.content,
    evidence: value.evidenceRefs,
    confidence: null,
    strategyId: value.strategyId,
    memoryKey: value.memoryKey,
    updateKind: value.updateKind,
  }
}

function mapEvidence(value: ContractReviewSource, index: number): ReviewEvidence {
  return {
    id: `${value.kind}-${value.sourceId}-${index + 1}`,
    kind: value.kind,
    label: reviewSourceKindLabel(value.kind),
    sourceId: value.sourceId,
    occurredAt: null,
    summary: reviewEvidenceRelationLabel(value.relation),
    complete: Boolean(value.evidenceHash),
  }
}

function mapVersion(value: NonNullable<ContractReviewCaseDetail['currentVersion']>): ReviewVersionSummary {
  return {
    id: value.id,
    version: value.versionNumber,
    status: value.authorKind === 'ai' ? 'AI 生成' : '人工修订',
    createdAt: value.createdAt,
    changeNote: '',
  }
}

export function mapReviewCaseDetail(value: ContractReviewCaseDetail): ReviewCaseDetail {
  const summary = mapReviewCaseSummary(value.summary)
  const content = value.currentVersion?.content ?? null
  const counterexamples = content?.counterexamples ?? []
  return {
    ...summary,
    title: content?.headline || summary.title,
    content,
    conclusion: content?.summary ?? '',
    keyFindings: [],
    metrics: reviewMetrics(value.summary, content),
    layers: content ? REVIEW_ROLE_KEYS.map((key) => mapLayer(content.roles[key], key)) : [],
    episodes: content?.tradeEpisodes.map(mapEpisode) ?? [],
    falsePositiveCandidates: counterexamples.filter((item) => item.kind === 'false_positive').map(mapCounterexample),
    missedOpportunityCandidates: counterexamples.filter((item) => item.kind === 'missed_opportunity').map(mapCounterexample),
    memoryCandidates: content?.memoryCandidates.map(mapMemoryCandidate) ?? [],
    evidence: value.sources.map(mapEvidence),
    versions: value.currentVersion ? [mapVersion(value.currentVersion)] : [],
    fullText: content?.fullAnalysisText ?? '',
    evidenceRevision: value.summary.evidenceRevision,
    evidenceHash: value.summary.evidenceHash,
  }
}

export function mapManualReviewCandidate(value: ContractManualReviewCandidate): ManualReviewCandidate {
  return {
    id: value.id,
    accountId: value.tradingAccountId,
    accountLabel: value.accountLabel,
    symbol: value.symbol,
    direction: reviewDirectionLabel(value.side),
    positionId: value.positionId,
    entryAt: value.openedAt,
    exitAt: value.closedAt,
    volume: value.volume,
    netProfit: value.netProfit,
    terminalTimezoneOffsetMinutes: value.terminalTimezoneOffsetMinutes,
    sourceStatus: `${reviewSourceLabel(value.sourceClassification)} · ${reviewEligibilityLabel(value.eligibilityStatus)}`,
    selectionToken: value.selectionToken,
    ticket: value.ticket,
    canReview: value.sourceClassification === 'manual' && value.eligibilityStatus === 'eligible',
  }
}

export function mapMemoryUpdate(value: ContractStrategyMemoryUpdate): MemoryUpdate {
  const firstConflict = value.conflicts[0]
  return {
    id: value.id,
    strategyMemoryId: value.libraryId,
    kind: memoryUpdateKindLabel(value.updateKind),
    title: value.proposal.title,
    summary: value.proposal.content || value.diffPreviewText || '暂无差异说明。',
    evidence: value.proposal.evidenceRefs,
    conflict: firstConflict ? `与更新 ${firstConflict.priorUpdateId} 的记忆键 ${firstConflict.memoryKey} 内容冲突。` : null,
    proposal: value.proposal,
    conflicts: value.conflicts,
    sourceReviewCaseId: value.sourceReviewCaseId,
    sourceReviewVersionId: value.sourceReviewVersionId,
    status: value.status,
    createdAt: value.createdAt,
    revision: value.revision,
    expectedLibraryRevision: value.expectedLibraryRevision,
  }
}

export function mapStrategyMemorySummary(value: ContractStrategyMemorySummary): StrategyMemorySummary {
  return {
    id: value.id,
    strategyId: value.strategyId,
    strategyLabel: value.strategyName,
    version: value.currentVersionNumber,
    status: memoryStatusLabel(value.status),
    summary: value.strategyKind === 'trader' ? '交易执行策略的统一经验库。' : '行情分析策略的统一经验库。',
    updatedAt: value.updatedAt,
    pendingCount: value.pendingCount,
  }
}

export function mapStrategyMemoryDetail(value: ContractStrategyMemoryDetail): StrategyMemoryDetail {
  return {
    ...mapStrategyMemorySummary(value),
    content: value.contentText,
    revisions: [],
    updates: [],
  }
}

/** Preserve the exact V4 structured review and only replace the editable body. */
export function reviewContentForVersion(detail: ReviewCaseDetail, fullText: string): ContractReviewContent {
  if (!detail.content) throw new Error('当前复核没有可编辑的结构化版本')
  return { ...detail.content, fullAnalysisText: fullText }
}

export function reviewDirectionLabel(value: ContractReviewEpisode['side']): string {
  return ({ buy: '买入', sell: '卖出', none: '观望' })[value]
}

export function reviewOutcomeLabel(value: ContractReviewEpisode['outcome']): string {
  return ({ win: '盈利', loss: '亏损', breakeven: '持平', not_executed: '未执行', unknown: '未知' })[value]
}

export function reviewSourceLabel(value: ContractManualReviewCandidate['sourceClassification']): string {
  return ({ manual: '人工交易', system: '系统交易', other_ea: '其他 EA', unknown: '来源不明' })[value]
}

export function reviewAssessmentLabel(value: ReviewAssessment): string {
  return ({ effective: '有效', mixed: '部分有效', problem: '存在问题', insufficient_evidence: '证据不足', not_applicable: '不适用' })[value]
}

export function memoryUpdateKindLabel(value: ReviewMemoryUpdateKind): string {
  return ({ short_term: '短期经验', long_term_candidate: '长期经验候选', monthly_summary: '月度总结', platform_candidate: '平台经验候选' })[value]
}

export function memoryUpdateStatusLabel(value: ReviewMemoryUpdateStatus): string {
  return ({ collecting_evidence: '累计证据中', awaiting_confirmation: '待确认', accepted: '已接受', rejected: '已驳回', merged: '已合并', superseded: '已被替代' })[value]
}

export function memoryStatusLabel(value: ContractStrategyMemorySummary['status']): string {
  return ({ active: '生效中', revalidating: '复核中', retired: '已停用' })[value]
}

function reviewLayerLabel(value: keyof ContractReviewContent['roles']): string {
  return ({ analyst: 'AI 分析师', trader: 'AI 交易员', risk: '硬风控', execution: '终端执行' })[value]
}

function reviewSourceKindLabel(value: ContractReviewSource['kind']): string {
  return ({ market_analysis: '行情分析', trade_decision: '交易判断', risk_decision: '风控判断', execution_outcome: '执行结果', terminal_trade: '终端交易', period_review: '周期复盘' })[value]
}

function reviewEvidenceRelationLabel(value: ContractReviewSource['relation']): string {
  return ({ direct: '直接来源', counterexample: '反例来源', missed_opportunity: '漏判候选来源', false_positive: '误判候选来源' })[value]
}

function reviewEvidenceStatusLabel(value: ContractReviewCaseSummary['evidenceStatus']): string {
  return ({ pending: '等待证据', incomplete: '证据不完整', complete: '证据完整', stale: '证据已过期' })[value]
}

function reviewEligibilityLabel(value: ContractManualReviewCandidate['eligibilityStatus']): string {
  return ({ eligible: '可复盘', incomplete: '证据不完整', already_reviewed: '已复盘' })[value]
}

export function statusLabel(status: ReviewCaseStatus | string): string {
  return ({
    awaiting_evidence: '等待证据', queued: '待生成', running: '生成中', awaiting_confirmation: '待确认',
    needs_changes: '需要修改', confirmed: '已确认', failed: '生成失败',
    active: '生效中', revalidating: '复核中', retired: '已停用',
  } as Record<string, string>)[status] ?? status
}

export function caseKindLabel(kind: ReviewCaseKind): string {
  return ({ daily: '日复盘', monthly: '月复盘', manual: '手动复盘' })[kind]
}

export function formatReviewTime(value: string | null, offset?: number | null): string {
  return formatLaboratoryTime(value, offset)
}

export function formatTerminalTimezoneOffset(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '--'
  const total = Math.trunc(minutes)
  const sign = total >= 0 ? '+' : '-'
  const absolute = Math.abs(total)
  const hours = Math.floor(absolute / 60)
  const remainder = absolute % 60
  return `UTC${sign}${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

export function metricTone(value: string): 'positive' | 'negative' | 'neutral' {
  const normalized = value.toLowerCase()
  if (normalized.includes('符合') || normalized.includes('良好') || normalized.includes('完整') || normalized.includes('盈利') || normalized.includes('有效') || normalized.includes('生效')) return 'positive'
  if (normalized.includes('冲突') || normalized.includes('不足') || normalized.includes('亏损') || normalized.includes('失败') || normalized.includes('问题')) return 'negative'
  return 'neutral'
}
