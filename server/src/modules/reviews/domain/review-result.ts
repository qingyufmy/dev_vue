import { assertReviewContent, type ReviewCaseDetail, type StrategyMemoryUpdate } from './review.js'
import { assertLegacyReviewContent } from './legacy-review-content.js'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const nullableText = (value: unknown) => value === null || text(value)
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0
const date = (value: unknown) => text(value) && /^\d{4}-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value))
const oneOf = (value: unknown, values: string[]) => text(value) && values.includes(value)

export function isReviewCaseDetail(value: unknown): value is ReviewCaseDetail {
  if (!object(value) || !object(value.summary) || !Array.isArray(value.sources) || !nullableText(value.returnReason)) return false
  const s = value.summary
  if (!text(s.id) || !positive(s.userId) || !text(s.tradingAccountId) || !text(s.accountLabel)
    || !oneOf(s.kind, ['daily', 'monthly', 'manual', 'trade'])
    || !oneOf(s.status, ['awaiting_evidence', 'queued', 'running', 'awaiting_confirmation', 'needs_changes', 'confirmed', 'failed', 'archived'])
    || !oneOf(s.evidenceStatus, ['pending', 'incomplete', 'complete', 'stale'])
    || !positive(s.revision) || !positive(s.evidenceRevision)
    || !Number.isInteger(s.terminalTimezoneOffsetMinutes) || Math.abs(Number(s.terminalTimezoneOffsetMinutes)) > 840
    || !date(s.terminalPeriodStart) || !date(s.terminalPeriodEnd) || !date(s.updatedAt)
    || !(s.subscriptionRevision === null || positive(s.subscriptionRevision))
    || !['standardSymbol', 'subscriptionId', 'analysisStrategyId', 'analysisStrategyName', 'traderStrategyId', 'traderStrategyName', 'evidenceHash', 'currentVersionId', 'confirmedVersionId'].every(key => nullableText(s[key]))) return false
  if (!value.sources.every(source => object(source) && text(source.sourceId) && text(source.evidenceHash)
    && oneOf(source.kind, ['market_analysis', 'trade_decision', 'risk_decision', 'execution_outcome', 'terminal_trade', 'period_review'])
    && oneOf(source.relation, ['direct', 'counterexample', 'missed_opportunity', 'false_positive']))) return false
  const v = value.currentVersion
  if (v !== null) {
    if (!object(v) || !text(v.id) || v.caseId !== s.id || v.id !== s.currentVersionId || !positive(v.versionNumber)
      || !oneOf(v.authorKind, ['ai', 'user']) || !date(v.createdAt)) return false
    if (object(v.content) && v.content.schemaVersion === 'review.legacy.v1') {
      try { assertLegacyReviewContent(v.content) } catch { return false }
      if (v.conclusion !== null) return false
    } else {
      try { assertReviewContent(v.content) } catch { return false }
      if (v.conclusion !== v.content.conclusion) return false
    }
  } else if (s.currentVersionId !== null) return false
  const j = value.currentJob
  if (j !== null && (!object(j) || !text(j.id) || !positive(j.generation) || !date(j.updatedAt)
    || !oneOf(j.mode, ['initial', 'retry', 'refresh_evidence'])
    || !oneOf(j.status, ['queued', 'preparing_evidence', 'waiting_model', 'validating', 'succeeded', 'retry_wait', 'failed', 'cancelled', 'completed_stale'])
    || !Number.isInteger(j.progressPercent) || Number(j.progressPercent) < 0 || Number(j.progressPercent) > 100
    || !text(j.currentStage) || !nullableText(j.lastErrorCode))) return false
  return true
}

export function isStrategyMemoryUpdate(value: unknown): value is StrategyMemoryUpdate {
  if (!object(value) || !['id', 'libraryId', 'sourceReviewCaseId', 'sourceReviewVersionId', 'diffPreviewText'].every(key => text(value[key]))
    || !positive(value.revision) || !positive(value.expectedLibraryRevision) || !date(value.createdAt)
    || !oneOf(value.updateKind, ['short_term', 'long_term_candidate', 'monthly_summary', 'platform_candidate'])
    || !oneOf(value.status, ['collecting_evidence', 'awaiting_confirmation', 'accepted', 'rejected', 'merged', 'superseded'])
    || !object(value.proposal) || !Array.isArray(value.conflicts)) return false
  const p = value.proposal
  return text(p.memoryKey) && text(p.title) && text(p.content) && Array.isArray(p.evidenceRefs) && p.evidenceRefs.every(text)
    && value.conflicts.every(c => object(c) && c.type === 'same_key_content_changed' && text(c.priorUpdateId) && text(c.memoryKey))
}
