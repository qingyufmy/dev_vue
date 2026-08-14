import crypto from 'crypto'
import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { sha256, resolveFrozenChanRequirement } from './inference-snapshots.js'
import { ensureReviewCaseForOutcome } from './review-workflow.js'
import { resolveAiTaskModel } from './model-profiles.js'
import { requestJsonObject } from './llm.js'
import { MODEL_PROVIDER_DEFAULTS, modelProviderProtocol } from './model-providers.js'
import { buildDailyPeriodMarketEvidence, monthlyPeriodMarketDigest } from './period-market-evidence.js'
import { isAiFeatureEnabled } from './rollout-governance.js'
import {
  getStrategyMemoryLibraryForRuntime,
  sanitizeStrategyMemoryPrompt,
  createStrategyMemoryInjectionLog,
  enqueueApprovedStrategyMemoryUpdate,
  recordStrategyMemoryConflictEvidence,
} from './strategy-memory-library.js'
import { queueStrategyMemoryConsistencyCheck, requestStrategyMemoryConsistencyCycle } from './strategy-memory-consistency.js'
import { canManagePlatformAiContent, platformAiContentManagerSql } from './platform-content-access.js'
import { applyDefaultObserverClockBootstrap } from './terminal-clock.js'
import { getDefaultObserverSourceClock } from './observer-channels.js'
import { createModelTaskTracker } from './model-task-tracker.js'
import { MODEL_TASK_TERMINAL_STATES, recoverAbandonedBusinessModelTasks } from './model-task-runtime.js'
import { estimateModelInputTokens, modelTaskDeadlines, selectModelTaskBudget, summarizeModelOutputHistory } from './model-task-budget.js'
import { getModelProviderCapabilities } from './model-provider-capabilities.js'
import {
  MONTHLY_REVIEW_CHECKPOINT_STATUSES,
  assertMonthlyReviewCheckpointCoverage,
  buildMonthlyReviewChunks,
  claimMonthlyReviewCheckpoint,
  ensureMonthlyReviewCheckpoints,
  linkMonthlyReviewCheckpointModelTask,
  loadSucceededMonthlyReviewCheckpoints,
  releaseMonthlyReviewCheckpoint,
  renewMonthlyReviewCheckpointLease,
  validateMonthlyReviewCheckpointContent,
} from './period-review-monthly-checkpoints.js'

const DAY_MS = 86400000
const DAILY_GRACE_MINUTES = 30
const MONTHLY_GRACE_MINUTES = 120
// A period's grace boundary is also the beginning of its first-creation
// window.  Existing cases are maintained independently of these bounds; the
// scheduler only uses them when it would create a case for the first time.
const DAILY_CREATION_WINDOW_END_MINUTES = 120
const MONTHLY_CREATION_WINDOW_END_MINUTES = 360
const DAILY_COMPLETE_RECHECK_MS = 15 * 60 * 1000
const DAILY_INCOMPLETE_RECHECK_MS = 60 * 60 * 1000
const DAILY_SETTLE_MS = 24 * 60 * 60 * 1000
// Evidence is produced by several asynchronous collectors.  Do not rebuild a
// user-visible review while one of those collectors is still changing the
// snapshot; a single quiet window is enough to debounce the settled-period
// scheduler without adding another state machine or database column.
const PERIOD_REVIEW_EVIDENCE_STABILITY_MS = 15 * 60 * 1000
const MONTHLY_REVIEW_GROUP_LIMIT_MAX = 200
const MONTHLY_REVIEW_GROUP_LIMIT_DEFAULT = 100
const MONTHLY_REVIEW_GROUP_SCAN_MAX = 800
const TERMINAL_TRADE_EVIDENCE_REASONS = new Set(['inference_snapshot_incomplete', 'historical_prompt_missing'])
let periodReviewTimer = null
let periodReviewCycleRunning = false
let periodReviewWakeRequested = false
const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value) } catch { return fallback } }
const safeError = error => String(error?.message || error || 'period_review_failed').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 128)

function requestTimeoutForAttempt(_model, attemptSafetyDeadlineUtcMs, nowUtcMs = Date.now()) {
  const remaining = Math.max(1, Math.trunc(Number(attemptSafetyDeadlineUtcMs) - Number(nowUtcMs)))
  // request_timeout_ms is deliberately not used as the business deadline.
  // Passing the remaining task-attempt window keeps injected providers and the
  // real HTTP client bounded by the same safety deadline.
  return remaining
}

async function preparePeriodReviewModelCall(taskKind, resolved, messages, schemaNeedTokens, {
  nowUtcMs = Date.now(), businessDeadlineUtcMs = null,
} = {}) {
  let capabilities = {}
  try {
    capabilities = await getModelProviderCapabilities(resolved?.model_profile_id) || {}
  } catch (error) {
    console.warn(`[PeriodReview] provider capability lookup unavailable for ${taskKind}:`, safeError(error))
  }
  const estimatedInputTokens = estimateModelInputTokens(messages)
  let outputHistory = summarizeModelOutputHistory([])
  if (Number(resolved?.model_profile_id) > 0) {
    try {
      const lowerInputBound = Math.max(1, Math.floor(estimatedInputTokens * 0.5))
      const upperInputBound = Math.max(lowerInputBound, Math.ceil(estimatedInputTokens * 2))
      const historyRows = await queryAll(`SELECT output_tokens, request_status, error_code,
          finish_reason, accounting_status
          FROM ai_model_usage_logs
          WHERE model_profile_id = ? AND \`usage\` = 'review' AND input_tokens BETWEEN ? AND ?
            AND output_tokens > 0
            AND (request_phase = 'request' OR request_phase IS NULL)
          ORDER BY id DESC LIMIT 100`, [
        resolved.model_profile_id, lowerInputBound, upperInputBound,
      ])
      outputHistory = summarizeModelOutputHistory(historyRows)
    } catch (error) {
      // Budget selection must remain available if observability data is being
      // rotated or the usage table is temporarily unavailable.
      console.warn(`[PeriodReview] model output history unavailable for ${taskKind}:`, safeError(error))
    }
  }
  const budget = selectModelTaskBudget({
    taskKind,
    providerOutputCap:capabilities.max_output_tokens,
    contextWindowTokens:capabilities.context_window_tokens,
    maxInputTokens:capabilities.max_input_tokens ?? capabilities.provider_max_input_tokens,
    contextLimitSemantics:capabilities.context_limit_semantics,
    capabilities,
    profile:resolved?.model,
    estimatedInputTokens,
    schemaNeedTokens,
    historicalOutputP95:outputHistory.historicalOutputP95,
    truncatedOutputHighWatermark:outputHistory.truncatedOutputHighWatermark,
  })
  // Physical provider/context limits are the only request boundary. Fail
  // explicitly when they cannot satisfy the output contract; never restore a
  // fixed legacy size or send a request that is known to be undersized.
  if (budget.reason === 'model_token_limits_unconfirmed' || budget.reason === 'model_token_limits_stale') {
    const error = new Error(budget.reason)
    error.code = error.message
    throw error
  }
  if (budget.reason === 'model_input_limit_exceeded' || budget.inputLimitExceeded) {
    const error = new Error('model_input_limit_exceeded')
    error.code = error.message
    throw error
  }
  if (!budget.sufficient || budget.selectedMaxOutputTokens <= 0) {
    const error = new Error('output_budget_insufficient')
    error.code = error.message
    throw error
  }
  const rawDeadlines = modelTaskDeadlines(taskKind, { nowUtcMs, businessDeadlineUtcMs })
  const deadlines = {
    ...rawDeadlines,
    attemptSafetyDeadlineUtcMs:Math.min(rawDeadlines.attemptSafetyDeadlineUtcMs, rawDeadlines.taskDeadlineUtcMs),
  }
  return {
    budget,
    ...deadlines,
    requestTimeoutMs:requestTimeoutForAttempt(resolved?.model, deadlines.attemptSafetyDeadlineUtcMs, nowUtcMs),
  }
}

export function startPeriodReviewLeaseHeartbeat(job, {
  intervalMs = 30_000,
  renew = async currentJob => queryRun(`UPDATE period_review_jobs
    SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'leased' AND lease_token = ?`,
  [afterSeconds(120), beijingNow(), currentJob.id, currentJob.lease_token]),
} = {}) {
  const controller = new AbortController()
  let stopped = false
  let lost = false
  let pending = null
  const markLost = error => {
    if (lost || stopped) return
    lost = true
    const reason = error instanceof Error ? error : new Error('period_review_job_lease_lost')
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const renewOnce = async () => {
    if (stopped || lost || pending) return
    pending = Promise.resolve(renew(job)).then(result => {
      const affected = Number(result?.affectedRows ?? result?.changes ?? 0)
      if (affected !== 1) markLost(new Error('period_review_job_lease_lost'))
    }).catch(error => markLost(error)).finally(() => { pending = null })
    await pending
  }
  const timer = setInterval(renewOnce, Math.max(1, Number(intervalMs) || 30_000))
  timer.unref?.()
  return {
    signal:controller.signal,
    get lost() { return lost },
    assertOwned() {
      if (lost) throw controller.signal.reason || new Error('period_review_job_lease_lost')
    },
    renewNow:renewOnce,
    async stop() {
      stopped = true
      clearInterval(timer)
      if (pending) await pending
    },
  }
}

export function periodReviewAccessScope(actor, alias = 'cases') {
  const userId = Number(actor?.id || 0)
  if (!userId) throw new Error('invalid_user')
  if (canManagePlatformAiContent(actor)) {
    return { userId, sql:`${alias}.strategy_scope = 'platform'`, params:[] }
  }
  return { userId, sql:`${alias}.user_id = ?`, params:[userId] }
}

export function isTerminalTradeEvidenceReason(value) {
  const reasons = [...new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean))]
  return reasons.length > 0 && reasons.every(reason => TERMINAL_TRADE_EVIDENCE_REASONS.has(reason))
}

export function samePeriodOutcomeSet(outcomes = [], sources = []) {
  const outcomeIds = [...new Set(outcomes.map(item => Number(item?.id)).filter(Number.isFinite))].sort((a, b) => a - b)
  const sourceIds = [...new Set(sources.map(item => Number(item?.outcome_id)).filter(Number.isFinite))].sort((a, b) => a - b)
  return outcomeIds.length === sourceIds.length && outcomeIds.every((id, index) => id === sourceIds[index])
}

function beijingDateTimeMs(value) {
  const parsed = Date.parse(`${String(value || '').replace(' ', 'T')}+08:00`)
  return Number.isFinite(parsed) ? parsed : 0
}

function reviewTimestampUtcMs(value) {
  const text = String(value || '').trim()
  if (!text) return 0
  const parsed = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
    ? Date.parse(text)
    : beijingDateTimeMs(text)
  return Number.isFinite(parsed) ? parsed : 0
}

export function isPeriodReviewEvidenceStable(rows = [], asOfUtcMs = Date.now()) {
  const timestamps = (rows || []).map(row => reviewTimestampUtcMs(
    row?.current_evidence_updated_at || row?.updated_at || row?.generated_at || row,
  )).filter(value => value > 0)
  // Missing timestamps are not trustworthy evidence of a quiet window.  The
  // caller will retry on the next scheduler cycle after the source exposes one.
  if (!timestamps.length) return false
  const newest = Math.max(...timestamps)
  return Number(asOfUtcMs) - newest >= PERIOD_REVIEW_EVIDENCE_STABILITY_MS
}

export function deriveStrategyMemoryApplicationStatus(row) {
  if (!row || row.approved_version_id == null) return null
  const derivation = String(row.derivation_status || '')
  const pending = Number(row.memory_pending_update_count_for_review ?? row.memory_pending_update_count ?? 0)
  const sourceUpdates = Number(row.memory_source_update_count ?? 0)
  const sourceMatchPresent = row.memory_source_revision_matches !== undefined
    && row.memory_source_revision_matches !== null
  const sourceRevisionMatches = sourceMatchPresent
    && (row.memory_source_revision_matches === true || Number(row.memory_source_revision_matches) === 1)
  const compression = String(row.memory_compression_job_status || '')
  if (derivation === 'queued' || derivation === 'retry_wait' || derivation === 'paused') return 'queued'
  if (derivation === 'leased' || derivation === 'applying') return 'applying'
  if (derivation === 'failed') return 'failed'
  if (pending > 0) return derivation === 'succeeded' ? 'applying' : 'queued'
  if (compression === 'leased' || compression === 'running') {
    return sourceRevisionMatches ? 'compression_running' : 'applying'
  }
  if (compression === 'queued' || compression === 'retry_wait') {
    return sourceRevisionMatches ? 'compression_queued' : 'applying'
  }
  if (compression === 'failed' || compression === 'status_unknown' || compression === 'stale') {
    return sourceRevisionMatches ? 'compression_failed_memory_preserved' : 'failed'
  }
  if (sourceRevisionMatches && ['succeeded', 'succeeded_noop'].includes(compression)) return 'completed'
  if (sourceRevisionMatches) return 'applied'
  // A confirmed review that produced no memory update is complete without a
  // synthetic revision; an expected update that has no real source revision is
  // a failed durable application, never a false success.
  if (derivation === 'succeeded' && sourceUpdates === 0) return 'completed'
  return 'failed'
}

function strategyMemoryStateSelectSql(caseAlias = 'cases', libraryAlias = 'memory_library') {
  return `
      ${libraryAlias}.version_no AS memory_current_version_no,
      ${libraryAlias}.content_hash AS memory_current_content_hash,
      ${libraryAlias}.pending_update_count AS memory_pending_update_count,
      (SELECT COUNT(*) FROM strategy_memory_pending_updates pending_for_review
        WHERE pending_for_review.strategy_id = ${caseAlias}.strategy_id
          AND pending_for_review.source_period_review_version_id = ${caseAlias}.approved_version_id
          AND pending_for_review.status = 'pending') AS memory_pending_update_count_for_review,
      (SELECT COUNT(*) FROM strategy_memory_pending_updates source_updates
        WHERE source_updates.strategy_id = ${caseAlias}.strategy_id
          AND source_updates.source_period_review_version_id = ${caseAlias}.approved_version_id
          AND source_updates.status IN ('pending','merged')) AS memory_source_update_count,
      (SELECT MAX(source_updates.merged_revision_id) FROM strategy_memory_pending_updates source_updates
        WHERE source_updates.strategy_id = ${caseAlias}.strategy_id
          AND source_updates.source_period_review_version_id = ${caseAlias}.approved_version_id
          AND source_updates.status = 'merged'
          AND source_updates.merged_revision_id IS NOT NULL) AS memory_merged_revision_id,
      (SELECT MAX(merged_revisions.version_no)
         FROM strategy_memory_pending_updates source_updates
         JOIN strategy_memory_library_revisions merged_revisions
           ON merged_revisions.id = source_updates.merged_revision_id
        WHERE source_updates.strategy_id = ${caseAlias}.strategy_id
          AND source_updates.source_period_review_version_id = ${caseAlias}.approved_version_id
          AND source_updates.status = 'merged') AS memory_merged_revision_version_no,
      EXISTS (SELECT 1
        FROM strategy_memory_pending_updates source_updates
        JOIN strategy_memory_library_revisions merged_revisions
          ON merged_revisions.id = source_updates.merged_revision_id
        WHERE source_updates.strategy_id = ${caseAlias}.strategy_id
          AND source_updates.source_period_review_version_id = ${caseAlias}.approved_version_id
          AND source_updates.status = 'merged'
          AND merged_revisions.strategy_id = ${caseAlias}.strategy_id
          AND merged_revisions.version_no <= ${libraryAlias}.version_no
          AND merged_revisions.content_hash <> COALESCE((
            SELECT parent_revision.content_hash
              FROM strategy_memory_library_revisions parent_revision
             WHERE parent_revision.strategy_id = merged_revisions.strategy_id
               AND parent_revision.version_no = merged_revisions.version_no - 1
             LIMIT 1
          ), '')
          AND (merged_revisions.source_id = ${caseAlias}.approved_version_id
            OR JSON_CONTAINS(IF(JSON_VALID(merged_revisions.source_metadata_json),
              merged_revisions.source_metadata_json, '{}'),
              CAST(source_updates.id AS JSON), '$.pending_update_ids'))
      ) AS memory_source_revision_matches,
      (SELECT compression.status FROM strategy_memory_compression_jobs compression
        WHERE compression.strategy_id = ${caseAlias}.strategy_id
          AND (compression.result_revision_id = (SELECT MAX(source_updates.merged_revision_id)
             FROM strategy_memory_pending_updates source_updates
            WHERE source_updates.strategy_id = ${caseAlias}.strategy_id
              AND source_updates.source_period_review_version_id = ${caseAlias}.approved_version_id
              AND source_updates.status = 'merged')
            OR compression.source_version_no = (SELECT MAX(merged_revisions.version_no)
             FROM strategy_memory_pending_updates source_updates
             JOIN strategy_memory_library_revisions merged_revisions
               ON merged_revisions.id = source_updates.merged_revision_id
            WHERE source_updates.strategy_id = ${caseAlias}.strategy_id
              AND source_updates.source_period_review_version_id = ${caseAlias}.approved_version_id
              AND source_updates.status = 'merged'))
        ORDER BY compression.id DESC LIMIT 1) AS memory_compression_job_status,
      (SELECT compression.last_error_code FROM strategy_memory_compression_jobs compression
        WHERE compression.strategy_id = ${caseAlias}.strategy_id
          AND (compression.result_revision_id = (SELECT MAX(source_updates.merged_revision_id)
             FROM strategy_memory_pending_updates source_updates
            WHERE source_updates.strategy_id = ${caseAlias}.strategy_id
              AND source_updates.source_period_review_version_id = ${caseAlias}.approved_version_id
              AND source_updates.status = 'merged')
            OR compression.source_version_no = (SELECT MAX(merged_revisions.version_no)
             FROM strategy_memory_pending_updates source_updates
             JOIN strategy_memory_library_revisions merged_revisions
               ON merged_revisions.id = source_updates.merged_revision_id
            WHERE source_updates.strategy_id = ${caseAlias}.strategy_id
              AND source_updates.source_period_review_version_id = ${caseAlias}.approved_version_id
              AND source_updates.status = 'merged'))
        ORDER BY compression.id DESC LIMIT 1) AS memory_compression_error_code,
      NULL AS memory_latest_compression_job_status`
}

export function normalizePeriodReviewState(row) {
  if (!row || Number(row.current_version_id || 0) <= 0) return row
  const normalized = { ...row }
  if (['evidence_pending', 'incomplete', 'ready', 'generating', 'failed'].includes(String(normalized.status || ''))) {
    normalized.status = 'draft'
  }
  // A durable version is the authoritative result.  If a worker died between
  // persisting that version and updating its business job, expose the result
  // as completed instead of leaving the UI in an endless generating state.
  if (Object.prototype.hasOwnProperty.call(normalized, 'job_status')) {
    normalized.job_status = 'succeeded'
    if (Object.prototype.hasOwnProperty.call(normalized, 'progress_stage')) normalized.progress_stage = 'succeeded'
    if (Object.prototype.hasOwnProperty.call(normalized, 'next_attempt_at')) normalized.next_attempt_at = null
    if (Object.prototype.hasOwnProperty.call(normalized, 'last_error_code')) normalized.last_error_code = null
  }
  const memoryStatus = deriveStrategyMemoryApplicationStatus(normalized)
  if (memoryStatus) normalized.memory_application_status = memoryStatus
  normalized.memory_applied = ['applied', 'completed', 'compression_queued', 'compression_running',
    'compression_failed_memory_preserved'].includes(memoryStatus)
  return normalized
}

async function reconcilePersistedPeriodReviewState(reviewCase, existingJob) {
  if (!reviewCase?.current_version_id) return
  const now = beijingNow()
  if (existingJob?.id && existingJob.status !== 'succeeded') {
    await queryRun(`UPDATE period_review_jobs SET status = 'succeeded', progress_stage = 'succeeded',
        stage_updated_at = ?, last_error_code = NULL, next_attempt_at = NULL,
        completed_at = COALESCE(completed_at, ?), lease_token = NULL, lease_expires_at = NULL,
        updated_at = ? WHERE id = ? AND status <> 'succeeded'`,
    [now, now, now, existingJob.id])
  }
  if (['evidence_pending','incomplete','ready','generating','failed'].includes(String(reviewCase.status || ''))) {
    await queryRun(`UPDATE period_review_cases SET status = 'draft', updated_at = ?
      WHERE id = ? AND current_version_id IS NOT NULL`, [now, reviewCase.id])
  }
}

async function markPeriodReviewModelAttemptStarted(job) {
  if (job._businessAttemptStarted) return
  const result = await queryRun(`UPDATE period_review_jobs SET attempt_count = attempt_count + 1, updated_at = ?
    WHERE id = ? AND status = 'leased' AND lease_token = ? AND attempt_count < max_attempts`,
  [beijingNow(), job.id, job.lease_token])
  const affected = Number(result?.affectedRows ?? result?.changes ?? 0)
  if (affected !== 1) throw new Error('period_review_job_attempt_exhausted')
  job.attempt_count = Number(job.attempt_count || 0) + 1
  job._businessAttemptStarted = true
}

export function periodReviewProviderRequestCallback(job, tracker) {
  return async event => {
    await tracker.onProviderRequest(event)
    // llm.js invokes this callback immediately before fetch().  Counting here
    // means retry_wait/queued task claims never consume a business attempt.
    await markPeriodReviewModelAttemptStarted(job)
  }
}

export function shouldRefreshDailyReviewCase(reviewCase, group, sources = [], asOfUtcMs = Date.now()) {
  if (!reviewCase) return { refresh:true, reason:'new_case' }
  if (!samePeriodOutcomeSet(group?.outcomes || [], sources)) return { refresh:true, reason:'outcome_set_changed' }
  // User approval freezes the evidence snapshot that produced the published
  // experience. Holding-path candles and Chan structures may continue to be
  // backfilled after the trade closes; those enrichments must not silently
  // clear an explicit approval or revoke its experience. A genuinely late
  // outcome is still detected above and creates a new review cycle.
  if (reviewCase.status === 'approved' && reviewCase.current_version_id && reviewCase.approved_version_id) {
    return { refresh:false, reason:'approved_snapshot_frozen' }
  }
  const elapsed = Math.max(0, Number(asOfUtcMs) - beijingDateTimeMs(reviewCase.updated_at))
  const stillSettling = Number(asOfUtcMs) <= Number(group?.endUtcMs || 0) + DAILY_SETTLE_MS
  const changedSources = sources.filter(source => source.current_evidence_hash
    && source.current_evidence_hash !== source.source_hash)
  if (changedSources.length) {
    if (reviewCase.current_version_id && stillSettling && !isPeriodReviewEvidenceStable(changedSources, asOfUtcMs)) {
      return { refresh:false, reason:'evidence_stability_wait' }
    }
    return { refresh:true, reason:'trade_evidence_changed' }
  }
  if (reviewCase.evidence_status !== 'complete') {
    if (isTerminalTradeEvidenceReason(reviewCase.evidence_reason)) return { refresh:false, reason:'terminal_evidence_incomplete' }
    return { refresh:elapsed >= DAILY_INCOMPLETE_RECHECK_MS, reason:elapsed >= DAILY_INCOMPLETE_RECHECK_MS ? 'incomplete_recheck_due' : 'incomplete_recheck_wait' }
  }
  if (!reviewCase.current_version_id) return { refresh:true, reason:'draft_missing' }
  if (stillSettling && elapsed >= DAILY_COMPLETE_RECHECK_MS) return { refresh:true, reason:'settlement_recheck_due' }
  return { refresh:false, reason:stillSettling ? 'settlement_recheck_wait' : 'finalized_unchanged' }
}

export function dailyEvidenceSemanticHash(evidence) {
  const value = parse(JSON.stringify(evidence || {}), {}) || {}
  if (value.period_market) {
    delete value.period_market.generated_at
    delete value.period_market.hash
  }
  return sha256(JSON.stringify(value))
}

export function shouldUpgradePeriodMarketEvidence(reviewCase, evidence, asOfUtcMs = Date.now()) {
  // Once a review version exists, its evidence and every derived memory must
  // remain immutable. Infrastructure/schema upgrades only repair cases that
  // have never produced a user-visible review version.
  if (reviewCase?.current_version_id) return false
  const marketGeneratedAt = Date.parse(evidence?.period_market?.generated_at || '')
  return Number(evidence?.schema_version || 0) < 2
    || Number(evidence?.period_market?.schema_version || 0) < 2
    || Number(evidence?.period_market?.coverage_policy_version || 0) < 2
    || !evidence?.period_market?.generated_at
    || (evidence?.period_market?.status !== 'complete'
      && (!Number.isFinite(marketGeneratedAt) || Number(asOfUtcMs) - marketGeneratedAt >= 3600000))
}

export function monthlyReviewSourceHash(rows = []) {
  const sources = rows.map(row => ({
    period_case_id:Number(row.id ?? row.period_case_id),
    review_status:String((row.status ?? row.review_status) || ''),
    evidence_hash:row.evidence_hash || null,
    content_hash:row.current_content_hash ?? row.content_hash ?? null,
  })).sort((a, b) => a.period_case_id - b.period_case_id)
  return sha256(JSON.stringify(sources))
}

/**
 * Rotate the business job key whenever a period review is rebuilt from a new
 * evidence snapshot. The model-task id is detached alongside case
 * invalidation; evidence JSON is persisted immediately afterwards, so this is
 * a sequencing/fencing guard rather than one database transaction covering
 * both writes.
 */
export async function refreshPeriodReviewJobForEvidence(run, {
  periodType, periodCaseId, evidenceHash, now = beijingNow(),
} = {}) {
  if (typeof run !== 'function') throw new Error('period_review_job_transaction_required')
  const normalizedType = String(periodType || '').toLowerCase()
  const jobType = normalizedType === 'daily' ? 'daily_review'
    : normalizedType === 'monthly' ? 'monthly_review' : null
  const caseId = Number(periodCaseId)
  const hash = String(evidenceHash || '').trim()
  if (!jobType || !Number.isSafeInteger(caseId) || caseId <= 0 || !hash) {
    throw new Error('period_review_job_evidence_identity_invalid')
  }
  const idempotencyKey = `${normalizedType}:${caseId}:${hash}`
  const result = await run(`UPDATE period_review_jobs SET idempotency_key = ?, model_task_id = NULL,
      status = 'queued', progress_stage = 'queued', stage_updated_at = ?, attempt_count = 0,
      last_error_code = NULL, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
      completed_at = NULL, updated_at = ?
      WHERE period_case_id = ? AND job_type = ? AND job_slot = 0`,
  [idempotencyKey, now, now, caseId, jobType])
  const resultHeader = Array.isArray(result) ? result[0] : result
  const affectedRows = Number(resultHeader?.affectedRows ?? resultHeader?.changes ?? 0)
  if (affectedRows !== 1) throw new Error('period_review_job_refresh_conflict')
  return { idempotencyKey, jobType, periodCaseId:caseId,
    affectedRows }
}

export function monthlyReviewJobRefreshStages(existingCase, sourceChanged, existingJob = null) {
  const rotateInTransaction = Boolean(existingCase?.current_version_id && sourceChanged)
  const rotateAfterEvidence = Boolean(existingCase && !rotateInTransaction
    && !existingCase.current_version_id && sourceChanged && existingJob)
  return { rotateInTransaction, rotateAfterEvidence }
}

function afterSeconds(seconds) {
  const date = new Date(Date.now() + (8 * 3600 + seconds) * 1000)
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

async function setPeriodReviewJobStage(job, stage, eventStatus = 'info', messageCode = null, metadata = null) {
  if (!job?.id || !job?.period_case_id) return
  const now = beijingNow()
  try {
    await queryRun(`UPDATE period_review_jobs SET progress_stage = ?, stage_updated_at = ?, updated_at = ? WHERE id = ?`,
      [stage, now, now, job.id])
    await queryRun(`INSERT INTO period_review_job_events
      (job_id, period_case_id, attempt_no, stage, event_status, message_code, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [job.id, job.period_case_id, Number(job.attempt_count || 0), stage,
      eventStatus, messageCode ? safeError(messageCode) : null, metadata ? JSON.stringify(metadata) : null, now])
  } catch (error) {
    console.error(`[PeriodReview case=${job.period_case_id}] progress persistence failed:`, safeError(error))
  }
  console.log(`[PeriodReview case=${job.period_case_id} attempt=${Number(job.attempt_count || 0)}] ${stage}${messageCode ? `: ${safeError(messageCode)}` : ''}`)
}

async function runRequestedPeriodReviewCycle() {
  if (periodReviewCycleRunning) return
  periodReviewCycleRunning = true
  try {
    do {
      periodReviewWakeRequested = false
      const result = await runPeriodReviewCycle()
      if (result.dailyWorker?.claimed || result.monthlyWorker?.claimed || result.derivationWorker?.claimed) periodReviewWakeRequested = true
    } while (periodReviewWakeRequested)
  } catch (error) {
    console.error('[PeriodReview] cycle failed:', safeError(error))
  } finally {
    periodReviewCycleRunning = false
    if (periodReviewWakeRequested) queueMicrotask(() => void runRequestedPeriodReviewCycle())
  }
}

export function requestPeriodReviewCycle() {
  periodReviewWakeRequested = true
  queueMicrotask(() => void runRequestedPeriodReviewCycle())
}

function validTerminalOffset(value) {
  if (value === null || value === undefined || value === '') throw new Error('terminal_clock_unverified')
  const offset = Number(value)
  if (!Number.isInteger(offset) || offset < -720 || offset > 840) throw new Error('terminal_clock_unverified')
  return offset
}

export function reviewPeriodBounds(periodType, periodKey, offsetMinutes) {
  offsetMinutes = validTerminalOffset(offsetMinutes)
  const offsetMs = Number(offsetMinutes) * 60000
  if (periodType === 'daily') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(periodKey))) throw new Error('invalid_daily_period_key')
    const start = Date.parse(`${periodKey}T00:00:00Z`) - offsetMs
    if (!Number.isFinite(start)) throw new Error('invalid_daily_period_key')
    return { startUtcMs: start, endUtcMs: start + DAY_MS, offsetMinutes: Number(offsetMinutes) }
  }
  if (periodType === 'monthly') {
    if (!/^\d{4}-\d{2}$/.test(String(periodKey))) throw new Error('invalid_monthly_period_key')
    const [year, month] = String(periodKey).split('-').map(Number)
    const start = Date.UTC(year, month - 1, 1) - offsetMs
    const end = Date.UTC(year, month, 1) - offsetMs
    return { startUtcMs: start, endUtcMs: end, offsetMinutes: Number(offsetMinutes) }
  }
  throw new Error('invalid_review_period_type')
}

export function reviewPeriodKey(utcMs, periodType, offsetMinutes) {
  offsetMinutes = validTerminalOffset(offsetMinutes)
  const shifted = new Date(Number(utcMs) + Number(offsetMinutes) * 60000)
  if (!Number.isFinite(shifted.getTime())) throw new Error('invalid_review_period_time')
  const day = shifted.toISOString().slice(0, 10)
  if (periodType === 'daily') return day
  if (periodType === 'monthly') return day.slice(0, 7)
  throw new Error('invalid_review_period_type')
}

export function outcomeCloseUtcMs(row, offsetMinutes) {
  const raw = parse(row?.last_deal_raw_json, {})
  const direct = Number(raw?.time_utc_msc)
  if (Number.isFinite(direct) && direct > 0) return direct
  const broker = Number(raw?.time_msc)
  if (Number.isFinite(broker) && broker > 0) return broker - Number(offsetMinutes) * 60000
  return null
}

export function periodReviewEligibility(row) {
  const scope = String(row?.strategy_scope || '').toLowerCase()
  const platformManager = canManagePlatformAiContent(row)
  if (scope === 'private' && !platformManager) return { eligible: true }
  if (scope === 'platform' && platformManager) return { eligible: true }
  return { eligible: false, reason: scope === 'platform' ? 'platform_strategy_user_review_disabled' : platformManager ? 'platform_manager_private_strategy_review_disabled' : 'review_strategy_scope_missing' }
}

export function groupDailyReviewOutcomes(rows, { offsetMinutes = null, asOfUtcMs = Date.now() } = {}) {
  const groups = new Map()
  for (const row of rows || []) {
    if (!periodReviewEligibility(row).eligible) continue
    let rowOffset
    try { rowOffset = validTerminalOffset(row.timezone_offset_minutes ?? offsetMinutes) } catch { continue }
    const closeUtcMs = outcomeCloseUtcMs(row, rowOffset)
    if (!Number.isFinite(closeUtcMs)) continue
    const periodKey = reviewPeriodKey(closeUtcMs, 'daily', rowOffset)
    const bounds = reviewPeriodBounds('daily', periodKey, rowOffset)
    if (Number(asOfUtcMs) < bounds.endUtcMs + DAILY_GRACE_MINUTES * 60000) continue
    const key = [row.user_id, row.trading_account_id, row.strategy_id, periodKey].join(':')
    if (!groups.has(key)) groups.set(key, { periodType: 'daily', periodKey, ...bounds, userId: Number(row.user_id), tradingAccountId: Number(row.trading_account_id), strategyId: Number(row.strategy_id), strategyVersion: Number(row.strategy_version || 1), strategyVersions:[], strategyScope: row.strategy_scope, clockStatus:String(row.clock_status || 'account_terminal'), outcomes: [] })
    const group = groups.get(key)
    const version = Number(row.strategy_version || 1)
    if (!group.strategyVersions.includes(version)) group.strategyVersions.push(version)
    group.strategyVersion = Math.max(group.strategyVersion, version)
    group.outcomes.push({ ...row, close_utc_msc: closeUtcMs })
  }
  return [...groups.values()].sort((a, b) => a.periodKey.localeCompare(b.periodKey) || a.strategyId - b.strategyId)
}

export function dailyReviewStatistics(outcomes) {
  const values = outcomes || []
  const netProfit = values.reduce((sum, row) => sum + Number(row.net_profit || 0), 0)
  const wins = values.filter(row => Number(row.net_profit || 0) > 0).length
  const losses = values.filter(row => Number(row.net_profit || 0) < 0).length
  const grossWin = values.reduce((sum, row) => sum + Math.max(0, Number(row.net_profit || 0)), 0)
  const grossLoss = Math.abs(values.reduce((sum, row) => sum + Math.min(0, Number(row.net_profit || 0)), 0))
  return {
    trade_count: values.length,
    wins,
    losses,
    breakeven: values.length - wins - losses,
    win_rate: values.length ? wins / values.length : 0,
    net_profit: netProfit,
    gross_profit: grossWin,
    gross_loss: grossLoss,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : null,
    external_intervention_count: values.filter(row => Boolean(row.external_intervention)).length,
  }
}

export function groupMonthlyReviewCases(rows, { offsetMinutes = null, asOfUtcMs = Date.now() } = {}) {
  const groups = new Map()
  for (const row of rows || []) {
    if (String(row?.period_type) !== 'daily' || !row?.current_version_id) continue
    const periodKey = String(row.period_key || '').slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(periodKey)) continue
    let rowOffset
    try { rowOffset = validTerminalOffset(row.timezone_offset_minutes ?? offsetMinutes) } catch { continue }
    const bounds = reviewPeriodBounds('monthly', periodKey, rowOffset)
    if (Number(asOfUtcMs) < bounds.endUtcMs + MONTHLY_GRACE_MINUTES * 60000) continue
    const key = [row.user_id, row.trading_account_id, row.strategy_id, periodKey].join(':')
    if (!groups.has(key)) groups.set(key, { periodType: 'monthly', periodKey, ...bounds,
      userId: Number(row.user_id), tradingAccountId: Number(row.trading_account_id), strategyId: Number(row.strategy_id),
      strategyVersion: Number(row.strategy_version || 1), strategyVersions:[], strategyScope: row.strategy_scope, dailyCases: [] })
    const group = groups.get(key)
    const versions = parse(row.strategy_versions_json, [Number(row.strategy_version || 1)]) || []
    for (const version of versions.map(Number).filter(Number.isFinite)) if (!group.strategyVersions.includes(version)) group.strategyVersions.push(version)
    group.strategyVersion = Math.max(group.strategyVersion, ...group.strategyVersions)
    const duplicateIndex = group.dailyCases.findIndex(item => String(item.period_key) === String(row.period_key)
      && Number(item.trading_account_id || 0) === Number(row.trading_account_id || 0))
    if (duplicateIndex < 0) group.dailyCases.push(row)
    else {
      const current = group.dailyCases[duplicateIndex]
      const preferRow = (row.status === 'approved' && current.status !== 'approved')
        || (row.status === current.status && Number(row.id) > Number(current.id))
      if (preferRow) group.dailyCases[duplicateIndex] = row
    }
  }
  return [...groups.values()].map(group => ({ ...group,
    dailyCases: group.dailyCases.sort((a, b) => String(a.period_key).localeCompare(String(b.period_key)) || Number(a.id) - Number(b.id)) }))
    .sort((a, b) => a.periodKey.localeCompare(b.periodKey) || a.strategyId - b.strategyId)
}

export function monthlyReviewStatistics(dailyCases) {
  const statistics = (dailyCases || []).map(row => parse(row?.evidence_json, {})?.statistics || {})
  const sum = key => statistics.reduce((total, item) => total + Number(item[key] || 0), 0)
  const tradeCount = sum('trade_count')
  const grossLoss = sum('gross_loss')
  const netByDay = statistics.map(item => Number(item.net_profit || 0))
  return {
    trading_days: statistics.length,
    trade_count: tradeCount,
    wins: sum('wins'),
    losses: sum('losses'),
    breakeven: sum('breakeven'),
    win_rate: tradeCount ? sum('wins') / tradeCount : 0,
    net_profit: sum('net_profit'),
    gross_profit: sum('gross_profit'),
    gross_loss: grossLoss,
    profit_factor: grossLoss > 0 ? sum('gross_profit') / grossLoss : null,
    profitable_days: netByDay.filter(value => value > 0).length,
    losing_days: netByDay.filter(value => value < 0).length,
    external_intervention_count: sum('external_intervention_count'),
  }
}

/**
 * Return the first-creation window state for a completed period.  The window
 * is [period end + grace, period end + end), with the right edge exclusive.
 * `periodEndUtcMs` is already derived from the account's terminal offset by
 * reviewPeriodBounds(), so this helper never assumes a platform timezone.
 */
export function periodReviewCreationWindowState(periodType, periodEndUtcMs, asOfUtcMs = Date.now()) {
  const end = Number(periodEndUtcMs)
  const now = Number(asOfUtcMs)
  if (!Number.isFinite(end) || !Number.isFinite(now)) throw new Error('invalid_review_period_time')
  const graceMinutes = periodType === 'daily' ? DAILY_GRACE_MINUTES
    : periodType === 'monthly' ? MONTHLY_GRACE_MINUTES : null
  const endMinutes = periodType === 'daily' ? DAILY_CREATION_WINDOW_END_MINUTES
    : periodType === 'monthly' ? MONTHLY_CREATION_WINDOW_END_MINUTES : null
  if (graceMinutes == null || endMinutes == null) throw new Error('invalid_review_period_type')
  const windowStartUtcMs = end + graceMinutes * 60000
  const windowEndUtcMs = end + endMinutes * 60000
  const state = now < windowStartUtcMs ? 'before' : now < windowEndUtcMs ? 'within' : 'after'
  return { state, windowStartUtcMs, windowEndUtcMs }
}

const DAILY_DECISIONS = new Set(['good', 'mixed', 'poor', 'insufficient_evidence'])
const CHAN_SOURCES = new Set(['data', 'calculation', 'confirmation_lag', 'ai_interpretation', 'strategy_rule', 'none', 'unknown'])
const MEMORY_CATEGORIES = new Set(['general', 'market_regime', 'entry_setup', 'chan_structure', 'risk_execution'])

function normalizeReviewChanContext(context) {
  // Direct validator callers from older code did not pass evidence context.
  // Preserve that compatibility while every runtime model call passes an
  // explicit frozen Chan context and therefore fails closed.
  if (context === undefined) return { mode:'legacy', status:'enabled', evidenceStatus:'complete' }
  const value = context && typeof context === 'object' ? context : {}
  const requirement = value.chan_requirement || value.chanRequirement || value.requirement || value
  const status = String(value.chan_status || value.chanStatus || requirement.status || 'unknown').toLowerCase()
  const evidenceStatus = String(value.chan_evidence_status || value.chanEvidenceStatus
    || value.evidence_status || value.evidenceStatus || '').toLowerCase()
  if (status === 'disabled') return { mode:'disabled', status, evidenceStatus:'not_applicable' }
  if (status === 'enabled' && evidenceStatus === 'complete') return { mode:'enabled_complete', status, evidenceStatus }
  return { mode:'restricted', status, evidenceStatus:evidenceStatus || 'unknown' }
}

function frozenDailyChanContext(evidence) {
  const periodMarket = evidence?.period_market && typeof evidence.period_market === 'object'
    ? evidence.period_market : {}
  const embedded = periodMarket.chan_requirement
  if (embedded && typeof embedded === 'object' && embedded.status) {
    return normalizeReviewChanContext({ chan_requirement:embedded,
      chan_evidence_status:periodMarket.chan_evidence_status })
  }
  const statuses = []
  for (const source of Array.isArray(evidence?.sources) ? evidence.sources : []) {
    const sourceEvidence = source?.evidence || source
    const requirement = resolveFrozenChanRequirement(
      sourceEvidence?.inference_time?.snapshot || sourceEvidence?.snapshot || sourceEvidence,
      sourceEvidence,
    )
    statuses.push(requirement.status)
  }
  const status = statuses.length && statuses.every(value => value === 'disabled') ? 'disabled'
    : statuses.length && statuses.every(value => value === 'enabled') ? 'enabled' : 'unknown'
  return normalizeReviewChanContext({ chan_requirement:{ status },
    chan_evidence_status:periodMarket.chan_evidence_status || 'unknown' })
}

function monthlyChanContext(evidence) {
  // Monthly evidence is a frozen collection of approved daily snapshots.
  // Read the nested frozen evidence/period-market digest, not a provider or
  // model supplied status copied onto the source row. Missing or malformed
  // nested evidence is deliberately unknown so the Chan contract fails closed.
  const sources = Array.isArray(evidence?.sources) ? evidence.sources : []
  if (!sources.length) return normalizeReviewChanContext({ chan_requirement:{ status:'unknown' }, chan_evidence_status:'unknown' })
  const contexts = sources.map(source => {
    const frozen = source?.chan_frozen_evidence || source?.frozen_evidence || source?.evidence
      || parse(source?.evidence_json, null) || null
    const parsed = typeof frozen === 'string' ? parse(frozen, null) : frozen
    const root = parsed && typeof parsed === 'object' ? parsed : {}
    const market = root.period_market && typeof root.period_market === 'object'
      ? root.period_market
      : root.period_market_digest && typeof root.period_market_digest === 'object'
        ? root.period_market_digest : {}
    const requirement = market.chan_requirement || root.chan_requirement
    const status = String(requirement?.status || '').toLowerCase()
    const evidenceStatus = String(market.chan_evidence_status || root.chan_evidence_status || '').toLowerCase()
    return { status:status || 'unknown', evidenceStatus:evidenceStatus || 'unknown' }
  })
  const statuses = [...new Set(contexts.map(item => item.status))]
  const evidenceStatuses = [...new Set(contexts.map(item => item.evidenceStatus))]
  const status = statuses.length === 1 ? statuses[0]
    : statuses.includes('enabled') && statuses.includes('disabled') ? 'mixed' : 'unknown'
  const evidenceStatus = evidenceStatuses.length === 1 ? evidenceStatuses[0] : 'partial'
  return normalizeReviewChanContext({ chan_requirement:{ status }, chan_evidence_status:evidenceStatus })
}

function hasNonEmptyValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function normalizeStrategyMemoryUpdates(input, {
  allowedSourceRefs = null, requireSourceRefs = false, chanMemoryAllowed = true,
} = {}) {
  const updates = input?.memory_updates == null ? [] : input.memory_updates
  if (!Array.isArray(updates)) throw new Error('invalid_strategy_memory_updates')
  return updates.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid_strategy_memory_update')
    const text = String(item.text || item.lesson || '').trim()
    if (!text) throw new Error('strategy_memory_update_text_missing')
    const category = MEMORY_CATEGORIES.has(item.category || item.memory_category) ? (item.category || item.memory_category) : 'general'
    if (category === 'chan_structure' && !chanMemoryAllowed) throw new Error('strategy_memory_chan_evidence_invalid')
    const suppliedRefs = item.source_refs ?? item.evidence_refs
    if (suppliedRefs !== undefined && !Array.isArray(suppliedRefs)) throw new Error('strategy_memory_source_ref_invalid')
    const refs = Array.isArray(suppliedRefs)
      ? [...new Set(suppliedRefs.map(ref => String(ref ?? '').trim()))]
      : []
    if (refs.some(ref => !ref) || (suppliedRefs !== undefined && !refs.length)) throw new Error('strategy_memory_source_ref_invalid')
    if (requireSourceRefs && !refs.length) throw new Error('strategy_memory_source_ref_invalid')
    if (allowedSourceRefs && refs.some(ref => !allowedSourceRefs.has(ref))) throw new Error('strategy_memory_source_ref_invalid')
    return { text, category, source_refs:refs }
  })
}

function normalizeStrategyConflicts(input, {
  allowedSourceRefs = null, requireSourceRefs = false, strategyText = null,
  memoryText = null, proposedExperiences = [],
} = {}) {
  const conflicts = input?.strategy_conflicts == null ? [] : input.strategy_conflicts
  if (!Array.isArray(conflicts)) throw new Error('invalid_strategy_conflicts')
  return conflicts.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid_strategy_conflict')
    const description = String(item.description || item.summary || '').trim()
    if (!description) throw new Error('strategy_conflict_description_missing')
    const suppliedRefs = item.source_refs ?? item.evidence_refs
    if (suppliedRefs !== undefined && !Array.isArray(suppliedRefs)) throw new Error('strategy_memory_source_ref_invalid')
    const sourceRefs = Array.isArray(suppliedRefs)
      ? [...new Set(suppliedRefs.map(ref => String(ref ?? '').trim()))].slice(0, 50)
      : []
    if (sourceRefs.some(ref => !ref) || (suppliedRefs !== undefined && !sourceRefs.length)) {
      throw new Error('strategy_memory_source_ref_invalid')
    }
    if (requireSourceRefs && !sourceRefs.length) throw new Error('strategy_memory_source_ref_invalid')
    if (allowedSourceRefs && sourceRefs.some(ref => !allowedSourceRefs.has(ref))) {
      throw new Error('strategy_memory_source_ref_invalid')
    }
    const conflictTarget = String(item.conflict_target || '').trim()
    if (!['existing_memory', 'proposed_experience'].includes(conflictTarget)) {
      throw new Error('strategy_memory_conflict_target_invalid')
    }
    const strategyExcerpt = String(item.strategy_excerpt || '').trim()
    const memoryExcerpt = String(item.memory_excerpt || '').trim()
    if (!strategyExcerpt || !memoryExcerpt) throw new Error('strategy_memory_conflict_excerpt_missing')
    if (strategyText != null && !String(strategyText).includes(strategyExcerpt)) {
      throw new Error('strategy_memory_conflict_strategy_excerpt_invalid')
    }
    const sourceText = conflictTarget === 'existing_memory' ? String(memoryText || '') : null
    if (sourceText != null && !sourceText.includes(memoryExcerpt)) {
      throw new Error('strategy_memory_conflict_memory_excerpt_invalid')
    }
    if (conflictTarget === 'proposed_experience'
      && !proposedExperiences.some(value => String(value || '').includes(memoryExcerpt))) {
      throw new Error('strategy_memory_conflict_proposed_excerpt_invalid')
    }
    const category = String(item.category || 'general').trim().toLowerCase()
    if (!MEMORY_CATEGORIES.has(category)) throw new Error('strategy_memory_conflict_category_invalid')
    return {
      conflict_target:conflictTarget,
      category,
      description,
      strategy_excerpt:strategyExcerpt,
      memory_excerpt:memoryExcerpt,
      suggested_action:String(item.suggested_action || item.suggested_change || '').trim(),
      source_refs:sourceRefs,
    }
  })
}

function normalizeMonthlyConflictGroups(input, known) {
  if (input == null) return []
  if (!Array.isArray(input)) throw new Error('invalid_monthly_review_conflict_groups')
  return input.map(group => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error('invalid_monthly_review_conflict_group')
    const supporting = [...new Set((Array.isArray(group.supporting_period_case_ids)
      ? group.supporting_period_case_ids : []).map(Number))]
    if (!supporting.length || supporting.some(id => !known.has(id))) throw new Error('invalid_monthly_review_conflict_group')
    const candidates = Array.isArray(group.candidates) ? group.candidates.map(candidate => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('invalid_monthly_review_conflict_candidate')
      const text = firstReviewText(candidate, ['text', 'candidate', 'lesson', 'summary'])
      const marketRegime = String(candidate.market_regime || '').trim()
      const candidateSupporting = [...new Set((Array.isArray(candidate.supporting_period_case_ids)
        ? candidate.supporting_period_case_ids : supporting).map(Number))]
      if (!text || !marketRegime || !candidateSupporting.length || candidateSupporting.some(id => !known.has(id))) {
        throw new Error('invalid_monthly_review_conflict_candidate')
      }
      return { text, market_regime:marketRegime, supporting_period_case_ids:candidateSupporting.sort((left, right) => left - right) }
    }) : []
    if (candidates.length < 2) throw new Error('invalid_monthly_review_conflict_group')
    return { conflict_key:String(group.conflict_key || group.group_id || group.id || '').trim() || `monthly-conflict-${supporting.join('-')}`,
      supporting_period_case_ids:supporting.sort((left, right) => left - right), candidates }
  })
}

function periodCompatibilityHash(group) {
  return sha256([group.periodType, group.periodKey, group.userId, Number(group.tradingAccountId || 0), group.strategyId].join(':'))
}

function unwrapReviewContent(input, wrapperKeys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  for (const key of wrapperKeys) {
    if (input[key] && typeof input[key] === 'object' && !Array.isArray(input[key])) return input[key]
  }
  return input
}

function firstReviewText(input, keys) {
  for (const key of keys) {
    const value = String(input?.[key] || '').trim()
    if (value) return value
  }
  return ''
}

export function validateDailyReviewContent(input, outcomeIds = [], chanContext, conflictContext = {}) {
  input = unwrapReviewContent(input, ['daily_review', 'review'])
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_daily_review_content')
  // Models sometimes add harmless explanatory keys. Normalize to the strict
  // server-owned shape below instead of failing an otherwise valid review.
  const periodSummary = firstReviewText(input, ['period_summary', 'daily_summary', 'review_summary', 'summary'])
  if (!periodSummary) throw new Error('daily_review_summary_missing')
  if (!DAILY_DECISIONS.has(input.decision_quality)) throw new Error('invalid_daily_review_decision')
  const normalizedChanContext = normalizeReviewChanContext(chanContext)
  const chanAllowed = normalizedChanContext.mode === 'legacy' || normalizedChanContext.mode === 'enabled_complete'
  for (const key of ['trade_assessments', 'repeated_issues', 'strengths', 'daily_lessons', 'risk_observations']) if (!Array.isArray(input[key])) throw new Error(`invalid_daily_review_${key}`)
  if (chanAllowed && !Array.isArray(input.chan_diagnoses)) throw new Error('invalid_daily_review_chan_diagnoses')
  if (!chanAllowed && hasNonEmptyValue(input.chan_diagnoses)) throw new Error('strategy_memory_chan_evidence_invalid')
  if (!chanAllowed && hasNonEmptyValue(input.period_chan_assessment)) throw new Error('strategy_memory_chan_evidence_invalid')
  if (!Number.isFinite(Number(input.confidence)) || Number(input.confidence) < 0 || Number(input.confidence) > 1) throw new Error('invalid_daily_review_confidence')
  const known = new Set(outcomeIds.map(Number))
  const assessments = input.trade_assessments.map(item => {
    const outcomeId = Number(item?.outcome_id)
    if (!known.has(outcomeId) || !DAILY_DECISIONS.has(item?.decision_quality) || !String(item?.summary || '').trim()) throw new Error('invalid_daily_trade_assessment')
    return { outcome_id: outcomeId, decision_quality: item.decision_quality, summary: String(item.summary).trim(), issue_codes: Array.isArray(item.issue_codes) ? item.issue_codes.map(String) : [] }
  })
  if (assessments.length !== known.size || new Set(assessments.map(item => item.outcome_id)).size !== known.size) {
    throw new Error('daily_review_trade_coverage_incomplete')
  }
  const chanDiagnoses = chanAllowed ? (Array.isArray(input.chan_diagnoses) ? input.chan_diagnoses : []).map(item => {
    const outcomeId = Number(item?.outcome_id)
    if (!known.has(outcomeId) || !CHAN_SOURCES.has(item?.issue_source)) throw new Error('invalid_daily_chan_diagnosis')
    return { outcome_id: outcomeId, status: String(item.status || 'insufficient_evidence'), issue_source: item.issue_source,
      impact_on_decision: String(item.impact_on_decision || 'unknown'), explanation: String(item.explanation || '').trim(), confidence: Math.min(1, Math.max(0, Number(item.confidence || 0))) }
  }) : []
  if (chanAllowed && (chanDiagnoses.length !== known.size || new Set(chanDiagnoses.map(item => item.outcome_id)).size !== known.size)) {
    throw new Error('daily_review_chan_coverage_incomplete')
  }
  const periodChan = chanAllowed && input.period_chan_assessment && typeof input.period_chan_assessment === 'object'
    ? input.period_chan_assessment : { status:'insufficient_evidence', issue_source:'unknown', explanation:'', affected_outcome_ids:[], confidence:0 }
  const affectedOutcomeIds = [...new Set((Array.isArray(periodChan.affected_outcome_ids) ? periodChan.affected_outcome_ids : []).map(Number))]
  if (chanAllowed && (!CHAN_SOURCES.has(periodChan.issue_source) || affectedOutcomeIds.some(id => !known.has(id)))) throw new Error('invalid_daily_period_chan_assessment')
  const allowedMemoryRefs = new Set([...known].map(id => `outcome:${id}`))
  const memoryUpdates = normalizeStrategyMemoryUpdates(input, {
    allowedSourceRefs:allowedMemoryRefs, chanMemoryAllowed:chanAllowed,
    requireSourceRefs:normalizedChanContext.mode !== 'legacy',
  })
  const strategyConflicts = normalizeStrategyConflicts(input, {
    allowedSourceRefs:allowedMemoryRefs, requireSourceRefs:normalizedChanContext.mode !== 'legacy',
    strategyText:conflictContext.strategyText, memoryText:conflictContext.memoryText,
    proposedExperiences:memoryUpdates.map(item => item.text),
  })
  const result = {
    period_summary: periodSummary, decision_quality: input.decision_quality, trade_assessments: assessments,
    repeated_issues: input.repeated_issues.map(String), strengths: input.strengths.map(String), daily_lessons: input.daily_lessons.map(String),
    risk_observations: input.risk_observations.map(String), confidence: Number(input.confidence),
    memory_updates:memoryUpdates, strategy_conflicts:strategyConflicts,
  }
  if (chanAllowed) {
    result.chan_diagnoses = chanDiagnoses
    result.period_chan_assessment = { status:String(periodChan.status || 'insufficient_evidence'), issue_source:periodChan.issue_source,
      explanation:String(periodChan.explanation || '').trim(), affected_outcome_ids:affectedOutcomeIds,
      confidence:Math.min(1, Math.max(0, Number(periodChan.confidence || 0))) }
  }
  return result
}

export function validateMonthlyReviewContent(input, dailyCaseIds = [], approvedDailyCaseIds = dailyCaseIds, chanContext,
  conflictContext = {}) {
  input = unwrapReviewContent(input, ['monthly_review', 'review'])
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_monthly_review_content')
  const periodSummary = firstReviewText(input, ['period_summary', 'monthly_summary', 'review_summary', 'summary'])
  if (!periodSummary) throw new Error('monthly_review_summary_missing')
  if (!DAILY_DECISIONS.has(input.decision_quality)) throw new Error('invalid_monthly_review_decision')
  const normalizedChanContext = normalizeReviewChanContext(chanContext)
  const chanAllowed = normalizedChanContext.mode === 'legacy' || normalizedChanContext.mode === 'enabled_complete'
  for (const key of ['daily_assessments', 'recurring_patterns', 'strengths', 'risk_observations', 'next_month_actions', 'memory_candidates']) {
    if (!Array.isArray(input[key])) throw new Error(`invalid_monthly_review_${key}`)
  }
  if (chanAllowed && !Array.isArray(input.chan_issue_summary)) throw new Error('invalid_monthly_review_chan_issue_summary')
  if (!chanAllowed && hasNonEmptyValue(input.chan_issue_summary)) {
    throw new Error('strategy_memory_chan_evidence_invalid')
  }
  if (!Number.isFinite(Number(input.confidence)) || Number(input.confidence) < 0 || Number(input.confidence) > 1) throw new Error('invalid_monthly_review_confidence')
  const known = new Set(dailyCaseIds.map(Number))
  const approved = new Set(approvedDailyCaseIds.map(Number))
  const assessments = input.daily_assessments.map(item => {
    const periodCaseId = Number(item?.period_case_id)
    if (!known.has(periodCaseId) || !DAILY_DECISIONS.has(item?.decision_quality) || !String(item?.summary || '').trim()) throw new Error('invalid_monthly_daily_assessment')
    return { period_case_id: periodCaseId, decision_quality: item.decision_quality, summary: String(item.summary).trim(), issue_codes: Array.isArray(item.issue_codes) ? item.issue_codes.map(String) : [] }
  })
  if (assessments.length !== known.size || new Set(assessments.map(item => item.period_case_id)).size !== known.size) {
    throw new Error('monthly_review_daily_coverage_incomplete')
  }
  const chanMemoryAllowed = chanAllowed
  const memoryCandidates = input.memory_candidates.map(item => {
    const support = Array.isArray(item?.supporting_period_case_ids) ? [...new Set(item.supporting_period_case_ids.map(Number))] : []
    if (!String(item?.lesson || '').trim() || support.length < 2 || support.some(id => !known.has(id) || !approved.has(id))) throw new Error('invalid_monthly_memory_candidate')
    const memoryCategory = MEMORY_CATEGORIES.has(item.memory_category) ? item.memory_category : 'general'
    if (memoryCategory === 'chan_structure' && !chanMemoryAllowed) throw new Error('strategy_memory_chan_evidence_invalid')
    return { lesson: String(item.lesson).trim(), anti_pattern: String(item.anti_pattern || '').trim(), memory_category:memoryCategory,
      supporting_period_case_ids: support, confidence: Math.min(1, Math.max(0, Number(item.confidence || 0))) }
  })
  const conflictGroups = normalizeMonthlyConflictGroups(input.conflict_groups, known)
  const hasHistoricalMemoryUpdates = Object.prototype.hasOwnProperty.call(input, 'memory_updates')
  const memoryUpdates = hasHistoricalMemoryUpdates ? normalizeStrategyMemoryUpdates(input, { chanMemoryAllowed }) : null
  const allowedMemoryRefs = new Set([...known].map(id => `period_review_case:${id}`))
  const strategyConflicts = normalizeStrategyConflicts(input, {
    allowedSourceRefs:allowedMemoryRefs, requireSourceRefs:normalizedChanContext.mode !== 'legacy',
    strategyText:conflictContext.strategyText, memoryText:conflictContext.memoryText,
    proposedExperiences:memoryCandidates.flatMap(item => [item.lesson, item.anti_pattern]).filter(Boolean),
  })
  const result = {
    period_summary: periodSummary, decision_quality: input.decision_quality, daily_assessments: assessments,
    recurring_patterns: input.recurring_patterns.map(String), strengths: input.strengths.map(String),
    risk_observations: input.risk_observations.map(String),
    next_month_actions: input.next_month_actions.map(String), memory_candidates: memoryCandidates,
    conflict_groups: conflictGroups, confidence: Number(input.confidence), strategy_conflicts:strategyConflicts,
  }
  if (chanAllowed) result.chan_issue_summary = input.chan_issue_summary.map(String)
  if (hasHistoricalMemoryUpdates) result.memory_updates = memoryUpdates
  return result
}

export function validateMonthlyReviewMergeContent(input, dailyCaseIds = [], approvedDailyCaseIds = dailyCaseIds,
  verifiedConflictGroups = [], chanContext, verifiedStrategyConflicts = [], conflictContext = {}) {
  // Chunk conclusions are already source-validated. Keep those conflicts
  // server-owned so the merge model cannot silently omit or collapse
  // contradictory market-regime evidence.
  return validateMonthlyReviewContent({ ...(input || {}), conflict_groups:verifiedConflictGroups,
    strategy_conflicts:verifiedStrategyConflicts }, dailyCaseIds, approvedDailyCaseIds, chanContext, conflictContext)
}

async function eligibleOutcomeRows(limit) {
  const batchLimit = Math.min(2000, Math.max(2, Number(limit || 500)))
  const backlogLimit = Math.max(1, Math.ceil(batchLimit * 0.7))
  // Keep a full recent lane after removing historical unassociated rows from
  // the maintenance lane. This lets a busy period converge even when more
  // than 30% of a batch belongs to newly eligible outcomes; both queries stay
  // explicitly bounded and the merged result remains de-duplicated below.
  const recentLimit = batchLimit
  const select = `SELECT so.*, snap.strategy_id, snap.strategy_version, snap.strategy_scope,
      u.role AS user_role, u.plan_source AS user_plan_source,
      ta.broker_server, mds.timezone_offset_minutes, mds.clock_status,
      (SELECT sod.raw_json FROM signal_outcome_deals sod WHERE sod.outcome_id = so.id ORDER BY sod.deal_time DESC, sod.id DESC LIMIT 1) AS last_deal_raw_json
    FROM signal_outcomes so
    JOIN users u ON u.id = so.user_id
    JOIN trading_accounts ta ON ta.id = so.trading_account_id AND ta.user_id = so.user_id
    LEFT JOIN market_data_sources mds ON mds.bridge_user_id = so.user_id
      AND UPPER(COALESCE(mds.broker_server, '')) = UPPER(ta.broker_server)
      AND CAST(COALESCE(mds.account_login, 0) AS CHAR) = CAST(ta.login_account AS CHAR)
    JOIN inference_snapshots snap ON snap.id = (SELECT MAX(s2.id) FROM inference_snapshots s2 WHERE s2.signal_id = so.signal_id)`
  const platformManagerSql = platformAiContentManagerSql('u')
  const eligible = `so.status = 'closed' AND so.review_eligible_at IS NOT NULL
    AND ((snap.strategy_scope = 'private' AND NOT ${platformManagerSql})
      OR (snap.strategy_scope = 'platform' AND ${platformManagerSql}))`
  const [backlog, recent] = await Promise.all([
    // Only associated, incomplete evidence belongs to the maintenance lane.
    // Unassociated historical outcomes are intentionally excluded here: the
    // recent lane below gives new source rows a bounded, deterministic path to
    // first creation without allowing an old backlog to occupy every batch.
    queryAll(`${select} WHERE ${eligible} AND EXISTS (SELECT 1 FROM period_review_sources prs
        JOIN period_review_cases cases ON cases.id = prs.period_case_id
        WHERE prs.outcome_id = so.id AND cases.period_type = 'daily' AND cases.evidence_status <> 'complete'
          AND cases.updated_at <= DATE_SUB(NOW(), INTERVAL 1 HOUR)
          AND COALESCE(cases.evidence_reason, '') NOT IN ('inference_snapshot_incomplete','historical_prompt_missing'))
      ORDER BY so.review_eligible_at ASC, so.id ASC LIMIT ?`, [backlogLimit]),
    queryAll(`${select} WHERE ${eligible} ORDER BY so.review_eligible_at DESC, so.id DESC LIMIT ?`, [recentLimit]),
  ])
  const merged = new Map()
  for (const row of [...backlog, ...recent]) merged.set(Number(row.id), row)
  const observerClock = await getDefaultObserverSourceClock().catch(() => null)
  return [...merged.values()].map(row => {
    const clock = applyDefaultObserverClockBootstrap({
      broker_server:row.broker_server,
      timezone_offset_minutes:row.timezone_offset_minutes,
      clock_status:row.clock_status,
    }, observerClock)
    return { ...row, timezone_offset_minutes:clock.timezone_offset_minutes ?? null,
      clock_status:clock.clock_status || 'unknown' }
  })
}

async function prepareTradeEvidence(outcome) {
  const reviewCase = await ensureReviewCaseForOutcome(outcome.id, { queueGeneration:false })
  if (reviewCase?.skipped) return { status: 'ineligible', reason: reviewCase.reason, reviewCase: null, evidence: null }
  const loaded = await queryOne('SELECT * FROM trade_review_cases WHERE id = ?', [reviewCase.id])
  return { status: loaded?.evidence_status || 'incomplete', reason: loaded?.evidence_reason || null, reviewCase: loaded, evidence: parse(loaded?.evidence_json, null) }
}

export function compactPeriodTradeEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  const inference = evidence.inference_time || {}
  const snapshot = inference.snapshot || {}
  const frozenSourceIdentities = [...new Map(Object.values(snapshot?.market_snapshot?.strategy_context?.timeframes || {})
    .map(frame => frame?.summary?.market_data_quality?.continuity?.source_identity
      || frame?.summary?.market_data_quality?.source_identity
      || frame?.summary?.market_data_quality)
    .filter(identity => identity && (identity.source_id || identity.source_key))
    .map(identity => [identity.source_key || `id:${identity.source_id}`, {
      source_id:Number(identity.source_id) || null,
      source_key:identity.source_key || null,
      platform:identity.platform || null,
      broker_server:identity.broker_server || null,
      account_login:identity.account_login == null ? null : String(identity.account_login),
    }])).values()]
  const postTrade = evidence.post_trade || {}
  return {
    schema_version:evidence.schema_version,
    inference_time:{
      signal:inference.signal || null,
      snapshot_ref:snapshot ? { id:snapshot.id, strategy_id:snapshot.strategy_id, strategy_version:snapshot.strategy_version,
        strategy_scope:snapshot.strategy_scope, prompt_hash:snapshot.prompt_hash, model_profile_id:snapshot.model_profile_id,
        provider:snapshot.provider, model_name:snapshot.model_name, credential_source:snapshot.credential_source,
        content_hash:snapshot.content_hash,
        source_identity:frozenSourceIdentities.length === 1 ? frozenSourceIdentities[0] : null,
        source_identities:frozenSourceIdentities,
      } : null,
      risk_decision:inference.risk_decision || null, original_order:inference.original_order || null,
      approved_order:inference.approved_order || null,
    },
    post_trade:{ outcome:postTrade.outcome || null, execution:postTrade.execution || null, deals:postTrade.deals || [],
      path_metrics:postTrade.path_metrics || null, post_trade_structure:postTrade.post_trade_structure || {},
      path_evidence:postTrade.path_evidence || null },
    evidence_refs:evidence.evidence_refs || {},
  }
}

async function upsertDailyGroup(group, clock, asOfUtcMs = Date.now()) {
  const existingCase = await queryOne(`SELECT * FROM period_review_cases WHERE period_type = 'daily' AND period_key = ?
    AND user_id = ? AND trading_account_id = ? AND strategy_id = ?
    ORDER BY CASE WHEN status = 'approved' THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT 1`,
  [group.periodKey, group.userId, group.tradingAccountId, group.strategyId])
  const creationWindow = periodReviewCreationWindowState('daily', group.endUtcMs, asOfUtcMs)
  // Look up the case first so an existing review can always be maintained;
  // only a genuinely new case is subject to the first-creation window.
  if (!existingCase && creationWindow.state !== 'within') {
    return { id:null, periodKey:group.periodKey, complete:false, sourceCount:0,
      evidenceHash:null, skippedCreationWindow:true, creationWindowState:creationWindow.state }
  }
  const existingMaintainedResult = value => ({ complete:existingCase?.evidence_status === 'complete', ...value,
    existingMaintained:true, creationWindowState:creationWindow.state })
  let existingSources = []
  if (existingCase) {
    group.strategyVersion = Number(existingCase.strategy_version || group.strategyVersion || 1)
    existingSources = await queryAll(`SELECT source.outcome_id, source.source_hash,
      review_case.evidence_hash AS current_evidence_hash, review_case.updated_at AS current_evidence_updated_at
      FROM period_review_sources source
      LEFT JOIN trade_review_cases review_case ON review_case.id = source.trade_review_case_id
      WHERE source.period_case_id = ? ORDER BY source.outcome_id`, [existingCase.id])
    const existingJob = await queryOne(`SELECT id, status FROM period_review_jobs
      WHERE period_case_id = ? AND job_type = 'daily_review' AND job_slot = 0 LIMIT 1`, [existingCase.id])
    await reconcilePersistedPeriodReviewState(existingCase, existingJob)
    const existingEvidence = parse(existingCase.evidence_json, {}) || {}
    const needsPeriodMarketUpgrade = shouldUpgradePeriodMarketEvidence(existingCase, existingEvidence)
    const refresh = shouldRefreshDailyReviewCase(existingCase, group, existingSources, asOfUtcMs)
    if (!refresh.refresh && !needsPeriodMarketUpgrade) return existingMaintainedResult({ id: Number(existingCase.id), periodKey: group.periodKey,
      complete: existingCase.evidence_status === 'complete', sourceCount: Number(existingCase.source_count || 0),
      evidenceHash: existingCase.evidence_hash, reused:true, refreshReason:refresh.reason })
    if (existingJob?.status === 'skipped' && !existingCase.current_version_id) {
      const now = beijingNow()
      if (existingCase.evidence_hash) {
        await refreshPeriodReviewJobForEvidence(queryRun, { periodType:'daily', periodCaseId:existingCase.id,
          evidenceHash:existingCase.evidence_hash, now })
      } else {
        await queryRun(`UPDATE period_review_jobs SET status = 'queued', progress_stage = 'queued', stage_updated_at = ?,
          attempt_count = 0, last_error_code = NULL, model_task_id = NULL, next_attempt_at = NULL,
          completed_at = NULL, updated_at = ? WHERE id = ?`, [now, now, existingJob.id])
      }
      return existingMaintainedResult({ id:Number(existingCase.id), periodKey:group.periodKey, complete:existingCase.evidence_status === 'complete',
        sourceCount:Number(existingCase.source_count || 0), evidenceHash:existingCase.evidence_hash, requeued:true })
    }
    if (existingJob && !existingCase.current_version_id && !needsPeriodMarketUpgrade) return existingMaintainedResult({ id: Number(existingCase.id), periodKey: group.periodKey,
      complete: existingCase.evidence_status === 'complete', sourceCount: Number(existingCase.source_count || 0), evidenceHash: existingCase.evidence_hash })
    if (!existingJob && existingCase.evidence_status === 'incomplete' && isTerminalTradeEvidenceReason(existingCase.evidence_reason) && !refresh.refresh) {
      return existingMaintainedResult({ id: Number(existingCase.id), periodKey: group.periodKey,
        complete: false, sourceCount: Number(existingCase.source_count || 0), evidenceHash: existingCase.evidence_hash, terminal: true, reused: true })
    }
  }
  const prepared = []
  for (const outcome of group.outcomes) prepared.push({ outcome, ...(await prepareTradeEvidence(outcome)) })
  const tradeEvidenceComplete = prepared.every(item => item.status === 'complete' && item.evidence)
  const reasons = [...new Set(prepared.flatMap(item => String(item.reason || '').split(',')).filter(Boolean))]
  const sources = prepared.map(item => ({ outcome_id: Number(item.outcome.id), trade_review_case_id: Number(item.reviewCase?.id || 0) || null,
    evidence_hash: item.reviewCase?.evidence_hash || null, evidence: compactPeriodTradeEvidence(item.evidence) }))
  const sourceIds = sources.map(item => item.outcome_id).sort((a, b) => a - b)
  const sourceHash = sha256(JSON.stringify(sources.map(item => [item.outcome_id, item.evidence_hash])))
  const evidence = {
    schema_version: 2,
    period: { type:'daily', key:group.periodKey, aggregation_basis:'fully_closed_at',
      timezone_offset_minutes:group.offsetMinutes, clock_status:clock.status,
      start_utc_msc:group.startUtcMs, end_utc_msc:group.endUtcMs },
    strategy: { id: group.strategyId, version: group.strategyVersion, versions:group.strategyVersions, scope: group.strategyScope,
      inference_system_prompt:prepared.find(item => item.evidence?.inference_time?.snapshot?.system_prompt)?.evidence?.inference_time?.snapshot?.system_prompt || null,
      prompt_hashes:[...new Set(prepared.map(item => item.evidence?.inference_time?.snapshot?.prompt_hash).filter(Boolean))] },
    statistics: dailyReviewStatistics(group.outcomes),
    sources,
  }
  evidence.period_market = await buildDailyPeriodMarketEvidence({ userId:group.userId, strategyId:group.strategyId,
    symbols:group.outcomes.map(item => item.symbol), startUtcMs:group.startUtcMs, endUtcMs:group.endUtcMs, sources })
  const periodMarketComplete = evidence.period_market.status === 'complete'
  const complete = tradeEvidenceComplete && periodMarketComplete
  if (!periodMarketComplete) reasons.push('period_market_incomplete')
  evidence.source_quality = { complete,
    trade_evidence_complete:tradeEvidenceComplete, period_market_status:evidence.period_market.status,
    period_market_reason:evidence.period_market.reason || null }
  const evidenceHash = sha256(JSON.stringify(evidence))
  const now = beijingNow()
  if (existingCase?.current_version_id) {
    const previousSemanticHash = dailyEvidenceSemanticHash(parse(existingCase.evidence_json, {}))
    const nextSemanticHash = dailyEvidenceSemanticHash(evidence)
    if (previousSemanticHash === nextSemanticHash) {
      await queryRun('UPDATE period_review_cases SET updated_at = ? WHERE id = ?', [now, existingCase.id])
      return existingMaintainedResult({ id:Number(existingCase.id), periodKey:group.periodKey, complete:existingCase.evidence_status === 'complete',
        sourceCount:Number(existingCase.source_count || 0), evidenceHash:existingCase.evidence_hash, reused:true, refreshReason:'semantic_evidence_unchanged' }
      )
    }
    const stillSettling = Number(asOfUtcMs) <= Number(group.endUtcMs || 0) + DAILY_SETTLE_MS
    const stabilityRows = [
      ...prepared.map(item => ({ updated_at:item.reviewCase?.updated_at })),
    ]
    if (stillSettling && !isPeriodReviewEvidenceStable(stabilityRows, asOfUtcMs)) {
      return existingMaintainedResult({ id:Number(existingCase.id), periodKey:group.periodKey, complete:existingCase.evidence_status === 'complete',
        sourceCount:Number(existingCase.source_count || 0), evidenceHash:existingCase.evidence_hash,
        reused:true, refreshReason:'evidence_stability_wait' })
    }
    await withTransaction(async run => {
      const [locked] = await run('SELECT * FROM period_review_cases WHERE id = ? FOR UPDATE', [existingCase.id])
      if (!locked[0] || Number(locked[0].current_version_id || 0) !== Number(existingCase.current_version_id)) throw new Error('period_review_version_conflict')
      const oldVersionId = Number(locked[0].approved_version_id || locked[0].current_version_id)
      // A confirmed memory is a separately governed artifact. Rebuilding a
      // review after late trades or a cross-version merge must not silently
      // revoke a memory that a user or administrator already approved.
      await run(`UPDATE period_review_derivation_jobs SET status = 'superseded', lease_token = NULL,
        lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE period_case_id = ? AND period_version_id = ? AND status NOT IN ('superseded')`, [now, existingCase.id, oldVersionId])
      await run(`UPDATE period_review_cases SET status = 'ready', current_version_id = NULL, approved_version_id = NULL,
        evidence_status = 'pending', evidence_reason = 'daily_evidence_changed', updated_at = ? WHERE id = ?`, [now, existingCase.id])
      await refreshPeriodReviewJobForEvidence(run, { periodType:'daily', periodCaseId:existingCase.id,
        evidenceHash, now })
    })
  }
  await queryRun(`INSERT INTO period_review_cases
    (period_type, period_key, user_id, trading_account_id, strategy_id, strategy_version, strategy_versions_json, strategy_compatibility_hash, strategy_scope,
     timezone_offset_minutes, period_start_utc_msc, period_end_utc_msc, status, evidence_status,
     evidence_reason, evidence_json, evidence_hash, source_count, created_at, updated_at)
    VALUES ('daily', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE evidence_status = IF(current_version_id IS NOT NULL, evidence_status, VALUES(evidence_status)),
      strategy_versions_json = VALUES(strategy_versions_json),
      evidence_reason = IF(current_version_id IS NOT NULL, evidence_reason, VALUES(evidence_reason)),
      evidence_json = IF(current_version_id IS NOT NULL, evidence_json, VALUES(evidence_json)),
      evidence_hash = IF(current_version_id IS NOT NULL, evidence_hash, VALUES(evidence_hash)),
      source_count = IF(current_version_id IS NOT NULL, source_count, VALUES(source_count)),
      status = IF(status IN ('generating','failed','approved','edited','needs_revision','deferred'), status, VALUES(status)), updated_at = VALUES(updated_at)`, [
    group.periodKey, group.userId, group.tradingAccountId, group.strategyId, group.strategyVersion, JSON.stringify(group.strategyVersions), periodCompatibilityHash(group), group.strategyScope,
    group.offsetMinutes, group.startUtcMs, group.endUtcMs, complete ? 'ready' : 'incomplete', complete ? 'complete' : 'incomplete',
    reasons.join(',').slice(0, 255) || null, JSON.stringify(evidence), evidenceHash, sourceIds.length, now, now,
  ])
  const periodCase = await queryOne(`SELECT * FROM period_review_cases WHERE period_type = 'daily' AND period_key = ?
    AND user_id = ? AND trading_account_id = ? AND strategy_id = ? ORDER BY id DESC LIMIT 1`, [group.periodKey, group.userId, group.tradingAccountId, group.strategyId])
  if (sourceIds.length) await queryRun(`DELETE FROM period_review_sources WHERE period_case_id = ? AND outcome_id IS NOT NULL
    AND outcome_id NOT IN (${sourceIds.map(() => '?').join(',')})`, [periodCase.id, ...sourceIds])
  for (const source of sources) await queryRun(`INSERT INTO period_review_sources
    (period_case_id, outcome_id, trade_review_case_id, source_hash, created_at) VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE trade_review_case_id = VALUES(trade_review_case_id), source_hash = VALUES(source_hash)`, [periodCase.id, source.outcome_id, source.trade_review_case_id, source.evidence_hash, now])
  if (complete && !periodCase.current_version_id) await queryRun(`INSERT IGNORE INTO period_review_jobs
    (period_case_id, job_type, idempotency_key, status, attempt_count, max_attempts, created_at, updated_at)
    VALUES (?, 'daily_review', ?, 'queued', 0, 3, ?, ?)`, [periodCase.id, `daily:${periodCase.id}:${evidenceHash}`, now, now])
  return { id: Number(periodCase.id), periodKey: group.periodKey, complete, sourceCount: sourceIds.length, evidenceHash,
    ...(existingCase ? { existingMaintained:true } : { created:true }), creationWindowState:creationWindow.state }
}

export async function prepareEligibleDailyReviews({ limit = 500, asOfUtcMs = Date.now() } = {}) {
  const rows = await eligibleOutcomeRows(limit)
  const userIds = [...new Set(rows.map(row => Number(row.user_id)).filter(id => id > 0))]
  const enabledEntries = await Promise.all(userIds.map(async userId => [userId, await isAiFeatureEnabled('review_generation_enabled', userId)]))
  const enabledUsers = new Set(enabledEntries.filter(([, enabled]) => enabled).map(([userId]) => userId))
  const enabledRows = rows.filter(row => enabledUsers.has(Number(row.user_id)))
  const groups = groupDailyReviewOutcomes(enabledRows, { asOfUtcMs })
  const result = { scanned: rows.length, skippedDisabled:rows.length - enabledRows.length,
    skippedClock:enabledRows.filter(row => row.timezone_offset_minutes == null
      || row.timezone_offset_minutes === '' || !Number.isInteger(Number(row.timezone_offset_minutes))).length,
    groups: groups.length, ready: 0, incomplete: 0,
    beforeCreationWindow: 0, outsideCreationWindow: 0, created: 0, existingMaintained: 0,
    clock:{ status:'per_account' } }
  for (const group of groups) {
    const prepared = await upsertDailyGroup(group, { status:group.clockStatus || 'account_terminal' }, asOfUtcMs)
    if (prepared.skippedCreationWindow && prepared.creationWindowState === 'before') result.beforeCreationWindow += 1
    if (prepared.skippedCreationWindow && prepared.creationWindowState === 'after') result.outsideCreationWindow += 1
    if (prepared.created) result.created += 1
    if (prepared.existingMaintained) result.existingMaintained += 1
    if (!prepared.skippedCreationWindow) result[prepared.complete ? 'ready' : 'incomplete'] += 1
  }
  return result
}

function monthlyReviewGroupLimit(limit = MONTHLY_REVIEW_GROUP_LIMIT_DEFAULT) {
  const value = Number(limit)
  if (!Number.isFinite(value)) return MONTHLY_REVIEW_GROUP_LIMIT_DEFAULT
  return Math.min(MONTHLY_REVIEW_GROUP_LIMIT_MAX, Math.max(1, Math.trunc(value)))
}

async function eligibleMonthlyReviewRows(limit) {
  const groupLimit = monthlyReviewGroupLimit(limit)
  // Scan a bounded overfetch so groups that are not yet past the per-account
  // month-end grace window do not consume the output group cap. The definitive
  // timezone/month-end check remains in groupMonthlyReviewCases(), which uses
  // each daily row's authoritative offset rather than an aggregate offset.
  // Recent months are considered first so a closed month outside its six-hour
  // creation window cannot consume the bounded scan before a newly eligible
  // month is seen. Existing monthly cases remain in the HAVING source-change/
  // recovery lanes below and are still maintained.
  const scanLimit = Math.min(MONTHLY_REVIEW_GROUP_SCAN_MAX, Math.max(groupLimit, groupLimit * 4))
  return queryAll(`WITH candidate_groups AS (
      SELECT daily.user_id,
          COALESCE(daily.trading_account_id, 0) AS trading_account_id,
          daily.strategy_id,
          LEFT(daily.period_key, 7) AS period_key,
          MAX(daily.updated_at) AS latest_daily_updated_at,
          MAX(monthly.id) AS monthly_case_id,
          MAX(monthly.current_version_id) AS monthly_current_version_id,
          MAX(monthly.updated_at) AS monthly_updated_at,
          MAX(monthly_jobs.id) AS monthly_job_id,
          MAX(CASE WHEN monthly_jobs.status = 'skipped' THEN 1 ELSE 0 END) AS monthly_job_skipped
        FROM period_review_cases daily
        JOIN period_review_versions daily_versions ON daily_versions.id = daily.current_version_id
        LEFT JOIN ai_feature_flags global_flags
          ON global_flags.scope = 'global' AND global_flags.user_id = 0
        LEFT JOIN ai_feature_flags user_flags
          ON user_flags.scope = 'user' AND user_flags.user_id = daily.user_id
        LEFT JOIN period_review_cases monthly ON monthly.id = (
          SELECT candidate.id
          FROM period_review_cases candidate
          WHERE candidate.period_type = 'monthly'
            AND candidate.period_key = LEFT(daily.period_key, 7)
            AND candidate.user_id = daily.user_id
            AND COALESCE(candidate.trading_account_id, 0) = COALESCE(daily.trading_account_id, 0)
            AND candidate.strategy_id = daily.strategy_id
            AND candidate.status <> 'superseded'
          ORDER BY CASE WHEN candidate.status = 'approved' THEN 0 ELSE 1 END,
            candidate.updated_at DESC, candidate.id DESC LIMIT 1
        )
        LEFT JOIN period_review_jobs monthly_jobs ON monthly_jobs.period_case_id = monthly.id
          AND monthly_jobs.job_type = 'monthly_review' AND monthly_jobs.job_slot = 0
        WHERE daily.period_type = 'daily' AND daily.evidence_status = 'complete'
          AND daily.strategy_compatibility_hash IS NOT NULL
          AND daily.status IN ('draft','edited','approved','needs_revision','deferred')
          AND COALESCE(global_flags.review_generation_enabled, 0) = 1
          AND COALESCE(user_flags.review_generation_enabled, 1) = 1
        GROUP BY daily.user_id, COALESCE(daily.trading_account_id, 0), daily.strategy_id,
          LEFT(daily.period_key, 7)
        HAVING (monthly_case_id IS NULL
            OR (monthly_current_version_id IS NULL
              AND (monthly_job_id IS NULL OR monthly_job_skipped = 1))
            OR (monthly_current_version_id IS NOT NULL
              AND (monthly_updated_at IS NULL OR latest_daily_updated_at > monthly_updated_at)))
        ORDER BY LEFT(daily.period_key, 7) DESC, latest_daily_updated_at DESC,
          daily.user_id ASC, COALESCE(daily.trading_account_id, 0) ASC,
          daily.strategy_id ASC, LEFT(daily.period_key, 7) ASC
        LIMIT ?
    )
    SELECT cases.*, versions.content_json AS current_content_json,
      versions.content_hash AS current_content_hash
    FROM candidate_groups candidates
    JOIN period_review_cases cases
      ON cases.period_type = 'daily'
      AND cases.user_id = candidates.user_id
      AND COALESCE(cases.trading_account_id, 0) = candidates.trading_account_id
      AND cases.strategy_id = candidates.strategy_id
      AND LEFT(cases.period_key, 7) = candidates.period_key
    JOIN period_review_versions versions ON versions.id = cases.current_version_id
    WHERE cases.evidence_status = 'complete'
      AND cases.strategy_compatibility_hash IS NOT NULL
      AND cases.status IN ('draft','edited','approved','needs_revision','deferred')
    ORDER BY cases.period_key DESC, cases.id ASC`, [scanLimit])
}

async function upsertMonthlyGroup(group, clock, asOfUtcMs = Date.now()) {
  const existingCase = await queryOne(`SELECT * FROM period_review_cases WHERE period_type = 'monthly' AND period_key = ?
    AND user_id = ? AND trading_account_id = ? AND strategy_id = ? AND status <> 'superseded'
    ORDER BY CASE WHEN status = 'approved' THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT 1`,
  [group.periodKey, group.userId, group.tradingAccountId, group.strategyId])
  const creationWindow = periodReviewCreationWindowState('monthly', group.endUtcMs, asOfUtcMs)
  // Existing monthly cases continue source-change maintenance and recovery
  // outside this window. Only a first case creation is deferred.
  if (!existingCase && creationWindow.state !== 'within') {
    return { id:null, periodKey:group.periodKey, complete:false, sourceCount:0,
      evidenceHash:null, skippedCreationWindow:true, creationWindowState:creationWindow.state }
  }
  const existingMaintainedResult = value => ({ complete:existingCase?.evidence_status === 'complete', ...value,
    existingMaintained:true, creationWindowState:creationWindow.state })
  let sourceChangedForExisting = false
  let existingJob = null
  if (existingCase) {
    group.strategyVersion = Number(existingCase.strategy_version || group.strategyVersion || 1)
    existingJob = await queryOne(`SELECT id, status FROM period_review_jobs
      WHERE period_case_id = ? AND job_type = 'monthly_review' AND job_slot = 0 LIMIT 1`, [existingCase.id])
    await reconcilePersistedPeriodReviewState(existingCase, existingJob)
    const existingEvidence = parse(existingCase.evidence_json, {}) || {}
    const sourceChanged = monthlyReviewSourceHash(group.dailyCases) !== monthlyReviewSourceHash(existingEvidence.sources || [])
    sourceChangedForExisting = sourceChanged
    if (existingCase.current_version_id && sourceChanged
      && !isPeriodReviewEvidenceStable(group.dailyCases.map(row => ({ updated_at:row.updated_at })), asOfUtcMs)) {
      return existingMaintainedResult({ id: Number(existingCase.id), periodKey: group.periodKey,
        sourceCount: Number(existingCase.source_count || 0), evidenceHash: existingCase.evidence_hash,
        reused:true, refreshReason:'source_stability_wait' })
    }
    if (existingCase.current_version_id && !sourceChanged) return existingMaintainedResult({ id: Number(existingCase.id), periodKey: group.periodKey,
      sourceCount: Number(existingCase.source_count || 0), evidenceHash: existingCase.evidence_hash, reused:true })
    if (existingJob?.status === 'skipped' && !existingCase.current_version_id) {
      const now = beijingNow()
      if (existingCase.evidence_hash) {
        await refreshPeriodReviewJobForEvidence(queryRun, { periodType:'monthly', periodCaseId:existingCase.id,
          evidenceHash:existingCase.evidence_hash, now })
      } else {
        await queryRun(`UPDATE period_review_jobs SET status = 'queued', progress_stage = 'queued', stage_updated_at = ?,
          attempt_count = 0, last_error_code = NULL, model_task_id = NULL, next_attempt_at = NULL,
          completed_at = NULL, updated_at = ? WHERE id = ?`, [now, now, existingJob.id])
      }
      return existingMaintainedResult({ id:Number(existingCase.id), periodKey:group.periodKey, sourceCount:Number(existingCase.source_count || 0),
        evidenceHash:existingCase.evidence_hash, requeued:true })
    }
    if (!sourceChanged && existingJob) return existingMaintainedResult({ id: Number(existingCase.id), periodKey: group.periodKey,
      sourceCount: Number(existingCase.source_count || 0), evidenceHash: existingCase.evidence_hash })
  }
  const refreshStages = monthlyReviewJobRefreshStages(existingCase, sourceChangedForExisting, existingJob)
  const sources = group.dailyCases.map(row => {
    const dailyEvidence = parse(row.evidence_json, {}) || {}
    const periodMarket = dailyEvidence.period_market && typeof dailyEvidence.period_market === 'object'
      ? dailyEvidence.period_market : {}
    return { period_case_id: Number(row.id), period_key: row.period_key,
      trading_account_id: Number(row.trading_account_id || 0), review_status: row.status,
      evidence_hash: row.evidence_hash, content_hash: row.current_content_hash,
      statistics: dailyEvidence.statistics || {},
      // Preserve only the frozen Chan decision/evidence envelope needed by the
      // monthly gate. The monthly model never receives raw source evidence.
      chan_frozen_evidence:{ period_market:{
        chan_requirement:periodMarket.chan_requirement || null,
        chan_evidence_status:periodMarket.chan_evidence_status || null,
      } },
      review: parse(row.current_content_json, {}) }
  })
  const periodMarketDigest = monthlyPeriodMarketDigest(group.dailyCases)
  const evidence = {
    schema_version: 2,
    period: { type: 'monthly', key: group.periodKey, timezone_offset_minutes: group.offsetMinutes,
      clock_status: clock.status, start_utc_msc: group.startUtcMs, end_utc_msc: group.endUtcMs },
    strategy: { id: group.strategyId, version: group.strategyVersion, versions:group.strategyVersions, scope: group.strategyScope },
    statistics: monthlyReviewStatistics(group.dailyCases),
    source_quality: { approved_days: sources.filter(item => item.review_status === 'approved').length,
      unconfirmed_days: sources.filter(item => item.review_status !== 'approved').length,
      market_complete_days:periodMarketDigest.filter(item => item.status === 'complete').length,
      market_partial_days:periodMarketDigest.filter(item => item.status !== 'complete').length },
    period_market_digest: periodMarketDigest,
    sources,
  }
  const evidenceHash = sha256(JSON.stringify(evidence))
  const now = beijingNow()
  if (refreshStages.rotateInTransaction) {
    await withTransaction(async run => {
      const [locked] = await run('SELECT * FROM period_review_cases WHERE id = ? FOR UPDATE', [existingCase.id])
      if (!locked[0] || Number(locked[0].current_version_id || 0) !== Number(existingCase.current_version_id || 0)) throw new Error('period_review_version_conflict')
      const oldVersionId = Number(locked[0].approved_version_id || locked[0].current_version_id)
      // Keep confirmed memories active until they are explicitly replaced
      // or revoked. Review evidence lifecycle must not mutate memory policy.
      if (oldVersionId > 0) await run(`UPDATE period_review_derivation_jobs SET status = 'superseded', lease_token = NULL,
          lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
          WHERE period_case_id = ? AND period_version_id = ? AND status NOT IN ('superseded')`, [now, existingCase.id, oldVersionId])
      await run(`UPDATE period_review_cases SET status = 'ready', current_version_id = NULL, approved_version_id = NULL,
        evidence_status = 'pending', evidence_reason = 'monthly_sources_changed', updated_at = ? WHERE id = ?`, [now, existingCase.id])
      await refreshPeriodReviewJobForEvidence(run, { periodType:'monthly', periodCaseId:existingCase.id,
        evidenceHash, now })
    })
  }
  await queryRun(`INSERT INTO period_review_cases
    (period_type, period_key, user_id, trading_account_id, strategy_id, strategy_version, strategy_versions_json, strategy_compatibility_hash, strategy_scope,
     timezone_offset_minutes, period_start_utc_msc, period_end_utc_msc, status, evidence_status,
     evidence_reason, evidence_json, evidence_hash, source_count, created_at, updated_at)
    VALUES ('monthly', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'complete', NULL, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE evidence_status = VALUES(evidence_status), evidence_reason = VALUES(evidence_reason),
      strategy_versions_json = VALUES(strategy_versions_json), evidence_json = VALUES(evidence_json), evidence_hash = VALUES(evidence_hash), source_count = VALUES(source_count),
      status = IF(status IN ('approved','edited','needs_revision','deferred'), status, VALUES(status)), updated_at = VALUES(updated_at)`, [
    group.periodKey, group.userId, group.tradingAccountId, group.strategyId, group.strategyVersion, JSON.stringify(group.strategyVersions), periodCompatibilityHash(group), group.strategyScope,
    group.offsetMinutes, group.startUtcMs, group.endUtcMs, JSON.stringify(evidence), evidenceHash, sources.length, now, now,
  ])
  const periodCase = await queryOne(`SELECT * FROM period_review_cases WHERE period_type = 'monthly' AND period_key = ?
    AND user_id = ? AND trading_account_id = ? AND strategy_id = ? ORDER BY id DESC LIMIT 1`,
  [group.periodKey, group.userId, group.tradingAccountId, group.strategyId])
  if (!periodCase.current_version_id) {
    const sourcePeriodIds = sources.map(source => Number(source.period_case_id))
    if (sourcePeriodIds.length) await queryRun(`DELETE FROM period_review_sources WHERE period_case_id = ? AND source_period_case_id IS NOT NULL
      AND source_period_case_id NOT IN (${sourcePeriodIds.map(() => '?').join(',')})`, [periodCase.id, ...sourcePeriodIds])
    for (const source of sources) await queryRun(`INSERT INTO period_review_sources
      (period_case_id, outcome_id, trade_review_case_id, source_period_case_id, source_hash, created_at)
      VALUES (?, NULL, NULL, ?, ?, ?) ON DUPLICATE KEY UPDATE source_hash = VALUES(source_hash)`,
    [periodCase.id, source.period_case_id, sha256(`${source.evidence_hash || ''}:${source.content_hash || ''}`), now])
    await queryRun(`INSERT IGNORE INTO period_review_jobs
      (period_case_id, job_type, idempotency_key, status, attempt_count, max_attempts, created_at, updated_at)
      VALUES (?, 'monthly_review', ?, 'queued', 0, 3, ?, ?)`, [periodCase.id, `monthly:${periodCase.id}:${evidenceHash}`, now, now])
    // A source change with an existing version was already rotated in the
    // transaction above. Rewriting the row again after the case becomes
    // complete would race a worker that has just claimed the new job.
    if (refreshStages.rotateAfterEvidence) {
      await refreshPeriodReviewJobForEvidence(queryRun, { periodType:'monthly', periodCaseId:periodCase.id,
        evidenceHash, now })
    }
  }
  return { id: Number(periodCase.id), periodKey: group.periodKey, sourceCount: sources.length, evidenceHash,
    complete:true, ...(existingCase ? { existingMaintained:true } : { created:true }), creationWindowState:creationWindow.state }
}

export async function prepareEligibleMonthlyReviews({ limit = MONTHLY_REVIEW_GROUP_LIMIT_DEFAULT, asOfUtcMs = Date.now() } = {}) {
  const groupLimit = monthlyReviewGroupLimit(limit)
  const rows = await eligibleMonthlyReviewRows(groupLimit)
  const candidateGroupKeys = new Set(rows.map(row => [Number(row.user_id), Number(row.trading_account_id || 0),
    Number(row.strategy_id), String(row.period_key || '').slice(0, 7)].join(':')))
  // Candidate selection is bounded in SQL; grace, timezone, and duplicate-day
  // rules are authoritative in the existing grouping helper. Apply the caller's
  // group cap only after those rules have produced complete monthly groups.
  // The grouping helper keeps its deterministic ascending order for callers
  // that render a calendar. Preparation is a bounded scheduler, so consume
  // the newest month groups first; otherwise an old no-case month could still
  // occupy the post-grouping cap even though SQL selected recent candidates.
  const groups = groupMonthlyReviewCases(rows, { asOfUtcMs })
    .sort((a, b) => b.periodKey.localeCompare(a.periodKey) || a.strategyId - b.strategyId
      || a.tradingAccountId - b.tradingAccountId)
    .slice(0, groupLimit)
  const result = { scanned: rows.length, candidateGroups:candidateGroupKeys.size,
    skippedDisabled:0,
    groups: groups.length, ready: 0, incomplete: 0,
    beforeCreationWindow: 0, outsideCreationWindow: 0, created: 0, existingMaintained: 0,
    clock:{ status:'per_account' } }
  for (const group of groups) {
    const prepared = await upsertMonthlyGroup(group, { status:'account_terminal' }, asOfUtcMs)
    if (prepared.skippedCreationWindow && prepared.creationWindowState === 'before') result.beforeCreationWindow += 1
    if (prepared.skippedCreationWindow && prepared.creationWindowState === 'after') result.outsideCreationWindow += 1
    if (prepared.created) result.created += 1
    if (prepared.existingMaintained) result.existingMaintained += 1
    if (!prepared.skippedCreationWindow) result[prepared.complete === false ? 'incomplete' : 'ready'] += 1
  }
  return result
}

function modelEndpoint(model) {
  const provider = model.provider || model.api_provider
  const protocol = modelProviderProtocol(provider)
  const base = String(model.api_base_url || MODEL_PROVIDER_DEFAULTS[provider] || '').replace(/\/+$/, '')
  if (!base) throw new Error('unsupported_daily_review_model_provider')
  return { protocol, url: `${base}/${protocol === 'responses' ? 'responses' : 'chat/completions'}` }
}

function startMonthlyReviewCheckpointLeaseHeartbeat(checkpoint, {
  intervalMs = 30_000,
  leaseMs = 120_000,
} = {}) {
  const controller = new AbortController()
  let stopped = false
  let lost = false
  let pending = null
  const markLost = error => {
    if (lost || stopped) return
    lost = true
    const reason = error instanceof Error ? error : new Error('monthly_review_checkpoint_lease_lost')
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const renewOnce = async () => {
    if (stopped || lost || pending) return
    pending = Promise.resolve(renewMonthlyReviewCheckpointLease({
      checkpointId:checkpoint.id, leaseToken:checkpoint.lease_token,
      fencingToken:checkpoint.fencing_token, leaseMs,
    })).then(renewed => {
      if (!renewed) markLost(new Error('monthly_review_checkpoint_lease_lost'))
    }).catch(error => markLost(error)).finally(() => { pending = null })
    await pending
  }
  const timer = setInterval(renewOnce, Math.max(1, Number(intervalMs) || 30_000))
  timer.unref?.()
  return {
    signal:controller.signal,
    get lost() { return lost },
    assertOwned() {
      if (lost) throw controller.signal.reason || new Error('monthly_review_checkpoint_lease_lost')
    },
    renewNow:renewOnce,
    async stop() {
      stopped = true
      clearInterval(timer)
      if (pending) await pending
    },
  }
}

function chunkContentText(item, keys = []) {
  for (const key of keys) {
    const text = String(item?.[key] || '').trim()
    if (text) return text
  }
  return ''
}

const CONDITION_FIELD_NAMES = new Set(['applicability', 'applicable_when', 'avoid_when'])

function stripHistoricalConditionFields(value) {
  if (Array.isArray(value)) return value.map(stripHistoricalConditionFields)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (CONDITION_FIELD_NAMES.has(String(key).toLowerCase())) continue
    result[key] = stripHistoricalConditionFields(entry)
  }
  return result
}

function normalizeChunkSupportIds(item, expectedSet) {
  const support = Array.isArray(item?.supporting_period_case_ids)
    ? [...new Set(item.supporting_period_case_ids.map(Number))]
    : []
  if (!support.length || support.some(id => !Number.isSafeInteger(id) || !expectedSet.has(id))) {
    throw new Error('monthly_review_chunk_support_invalid')
  }
  return support.sort((left, right) => left - right)
}

function normalizeChunkContext(item, expectedSet, textKeys) {
  const text = chunkContentText(item, textKeys)
  if (!text) throw new Error('monthly_review_chunk_item_text_missing')
  const support = normalizeChunkSupportIds(item, expectedSet)
  const marketRegime = String(item.market_regime || item.market_regimes || '').trim()
  if (!marketRegime) throw new Error('monthly_review_chunk_market_regime_missing')
  return { text, supporting_period_case_ids:support, market_regime:marketRegime,
    confidence:Math.min(1, Math.max(0, Number(item.confidence ?? 0))) }
}

function normalizeChunkContextArray(input, key, expectedSet, textKeys) {
  if (!Array.isArray(input?.[key])) throw new Error(`invalid_monthly_review_chunk_${key}`)
  return input[key].map(item => normalizeChunkContext(item, expectedSet, textKeys))
}

function normalizeChunkConflictGroups(input, expectedSet) {
  if (!Array.isArray(input?.conflict_groups)) throw new Error('invalid_monthly_review_chunk_conflict_groups')
  return input.conflict_groups.map(group => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error('invalid_monthly_review_chunk_conflict_group')
    const support = normalizeChunkSupportIds({ supporting_period_case_ids:group.supporting_period_case_ids }, expectedSet)
    const candidates = Array.isArray(group.candidates) ? group.candidates.map(candidate => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('invalid_monthly_review_chunk_conflict_candidate')
      const text = chunkContentText(candidate, ['text', 'candidate', 'lesson', 'summary'])
      if (!text) throw new Error('monthly_review_chunk_conflict_candidate_text_missing')
      const marketRegime = String(candidate.market_regime || '').trim()
      if (!marketRegime) throw new Error('monthly_review_chunk_market_regime_missing')
       return { text, market_regime:marketRegime,
         supporting_period_case_ids:normalizeChunkSupportIds(candidate, expectedSet) }
    }) : []
    if (candidates.length < 2) throw new Error('monthly_review_chunk_conflict_candidates_incomplete')
    return { conflict_key:String(group.conflict_key || group.group_id || group.id || '').trim() || `chunk-conflict-${support.join('-')}`,
      supporting_period_case_ids:support, candidates }
  })
}

/**
 * Chunk output is intentionally stricter than the final monthly contract.
 * Every local conclusion carries the exact source IDs that the merge model
 * must preserve rather than silently combine.
 */
export function validateMonthlyReviewChunkContent(input, expectedPeriodCaseIds = [], chanContext, conflictContext = {}) {
  const expected = [...new Set(expectedPeriodCaseIds.map(Number))].sort((left, right) => left - right)
  const coverage = validateMonthlyReviewCheckpointContent(input, expected)
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const expectedSet = new Set(expected)
  const normalizedChanContext = normalizeReviewChanContext(chanContext)
  const chanAllowed = normalizedChanContext.mode === 'legacy' || normalizedChanContext.mode === 'enabled_complete'
  if (!chanAllowed && hasNonEmptyValue(value.chan_observations)) {
    throw new Error('strategy_memory_chan_evidence_invalid')
  }
  const assessments = coverage.items.map(item => {
    const periodCaseId = Number(item.period_case_id)
    if (!DAILY_DECISIONS.has(item.decision_quality) || !String(item.summary || '').trim()) throw new Error('invalid_monthly_review_chunk_daily_assessment')
    return { period_case_id:periodCaseId, decision_quality:item.decision_quality,
      summary:String(item.summary).trim(), issue_codes:Array.isArray(item.issue_codes) ? item.issue_codes.map(String) : [] }
  }).sort((left, right) => left.period_case_id - right.period_case_id)
  const periodSummary = firstReviewText(value, ['period_summary', 'summary'])
  if (!periodSummary) throw new Error('monthly_review_chunk_summary_missing')
  if (!DAILY_DECISIONS.has(value.decision_quality)) throw new Error('invalid_monthly_review_chunk_decision')
  const allowedChunkRefs = new Set(expected.map(id => `period_review_case:${id}`))
  const result = {
    period_summary:periodSummary,
    decision_quality:value.decision_quality,
    daily_assessments:assessments,
    local_patterns:normalizeChunkContextArray(value, 'local_patterns', expectedSet, ['pattern', 'text', 'summary']),
    strengths:normalizeChunkContextArray(value, 'strengths', expectedSet, ['strength', 'text', 'summary']),
    risks:normalizeChunkContextArray(value, 'risks', expectedSet, ['risk', 'text', 'summary']),
    action_candidates:normalizeChunkContextArray(value, 'action_candidates', expectedSet, ['action', 'text', 'summary']),
    conflict_groups:normalizeChunkConflictGroups(value, expectedSet),
    strategy_conflicts:normalizeStrategyConflicts(value, {
      allowedSourceRefs:allowedChunkRefs, requireSourceRefs:normalizedChanContext.mode !== 'legacy',
      strategyText:conflictContext.strategyText, memoryText:conflictContext.memoryText,
    }),
    confidence:Math.min(1, Math.max(0, Number(value.confidence ?? 0))),
  }
  if (!Number.isFinite(Number(value.confidence)) || Number(value.confidence) < 0 || Number(value.confidence) > 1) throw new Error('invalid_monthly_review_chunk_confidence')
  if (chanAllowed) result.chan_observations = normalizeChunkContextArray(value, 'chan_observations', expectedSet, ['observation', 'text', 'summary'])
  return result
}

function parseCheckpointContent(row) {
  if (row?.content_json && typeof row.content_json === 'string') return parse(row.content_json, null)
  return row?.content_json || row?.content || null
}

async function inspectPeriodReviewModelTask(task) {
  const job = await queryOne(`SELECT jobs.id, jobs.status, jobs.period_case_id,
      cases.current_version_id, versions.content_hash AS result_hash
    FROM period_review_jobs jobs
    LEFT JOIN period_review_cases cases ON cases.id = jobs.period_case_id
    LEFT JOIN period_review_versions versions ON versions.id = cases.current_version_id
    WHERE jobs.model_task_id = ? LIMIT 1`, [task.task_id])
  if (job) {
    const succeeded = job.status === 'succeeded' && Number(job.current_version_id) > 0 && Boolean(job.result_hash)
    return { kind:'period_review', job, succeeded, resultRef:succeeded ? `period_review_case:${job.period_case_id}` : null,
      resultHash:succeeded ? job.result_hash : null }
  }
  const checkpoint = await queryOne(`SELECT checkpoints.*, jobs.status AS parent_status, jobs.period_case_id,
      jobs.id AS period_review_job_id
    FROM period_review_monthly_checkpoints checkpoints
    JOIN period_review_jobs jobs ON jobs.id = checkpoints.period_review_job_id
    WHERE checkpoints.model_task_id = ? LIMIT 1`, [task.task_id])
  if (!checkpoint) return null
  const content = parseCheckpointContent(checkpoint)
  const succeeded = checkpoint.status === MONTHLY_REVIEW_CHECKPOINT_STATUSES.SUCCEEDED
    && Boolean(content) && Boolean(checkpoint.content_hash)
  return { kind:'monthly_review_chunk', checkpoint,
    job:{ id:Number(checkpoint.period_review_job_id), status:checkpoint.parent_status,
      period_case_id:Number(checkpoint.period_case_id) }, succeeded,
    resultRef:succeeded ? `period_review_monthly_checkpoint:${checkpoint.id}` : null,
    resultHash:succeeded ? checkpoint.content_hash : null }
}

async function transitionPeriodReviewModelBusiness({ action, task, business, reason }) {
  const jobId = Number(business?.job?.id || 0)
  if (!jobId) return
  const now = beijingNow()
  if (business.kind === 'monthly_review_chunk') {
    const checkpointId = Number(business.checkpoint?.id || 0)
    if (!checkpointId) return
    if (action === 'requeued') {
      await queryRun(`UPDATE period_review_monthly_checkpoints SET status = 'queued',
        lease_token = NULL, lease_owner = NULL, lease_expires_at_utc_msc = NULL,
        fencing_token = fencing_token + 1, next_attempt_at_utc_msc = NULL,
        error_code = NULL, error_message = NULL, updated_at_utc_msc = ?
        WHERE id = ? AND model_task_id = ? AND status IN ('leased','failed')`, [Date.now(), checkpointId, task.task_id])
      await queryRun(`UPDATE period_review_jobs SET status = 'queued', progress_stage = 'queued', stage_updated_at = ?,
        last_error_code = NULL, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND status NOT IN ('succeeded','failed','skipped','status_unknown')`, [now, now, jobId])
      return
    }
    if (action === 'status_unknown') {
      await queryRun(`UPDATE period_review_monthly_checkpoints SET status = 'status_unknown',
        error_code = 'provider_status_unknown', error_message = ?, lease_token = NULL, lease_owner = NULL,
        lease_expires_at_utc_msc = NULL, fencing_token = fencing_token + 1,
        next_attempt_at_utc_msc = NULL, updated_at_utc_msc = ?
        WHERE id = ? AND model_task_id = ? AND status IN ('leased','failed')`,
      [String(reason || 'provider_status_unknown').slice(0, 512), Date.now(), checkpointId, task.task_id])
      await queryRun(`UPDATE period_review_jobs SET status = 'status_unknown', progress_stage = 'status_unknown', stage_updated_at = ?,
        last_error_code = 'provider_status_unknown', lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND status NOT IN ('succeeded','failed','skipped')`, [now, now, jobId])
      return
    }
    if (action === 'stale') {
      await queryRun(`UPDATE period_review_monthly_checkpoints SET status = 'failed',
        error_code = ?, error_message = ?, lease_token = NULL, lease_owner = NULL,
        lease_expires_at_utc_msc = NULL, fencing_token = fencing_token + 1,
        next_attempt_at_utc_msc = NULL, updated_at_utc_msc = ?
        WHERE id = ? AND model_task_id = ? AND status NOT IN ('succeeded','superseded')`,
      [String(reason || 'model_task_recovery_stale').slice(0, 128), String(reason || 'model_task_recovery_stale').slice(0, 512), Date.now(), checkpointId, task.task_id])
      await queryRun(`UPDATE period_review_jobs SET status = 'failed', progress_stage = 'failed', stage_updated_at = ?,
        last_error_code = ?, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
        completed_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('succeeded','failed','skipped')`,
      [now, String(reason || 'model_task_recovery_stale').slice(0, 128), now, now, jobId])
    }
    return
  }
  if (action === 'requeued') {
    await queryRun(`UPDATE period_review_jobs SET status = 'queued', progress_stage = 'queued', stage_updated_at = ?,
      last_error_code = NULL, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE id = ? AND model_task_id = ? AND status NOT IN ('succeeded','failed','skipped')`,
    [now, now, jobId, task.task_id])
    return
  }
  if (action === 'status_unknown') {
    await queryRun(`UPDATE period_review_jobs SET status = 'status_unknown', progress_stage = 'status_unknown', stage_updated_at = ?,
      last_error_code = 'provider_status_unknown', lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE id = ? AND model_task_id = ? AND status NOT IN ('succeeded','failed','skipped')`,
    [now, now, jobId, task.task_id])
    return
  }
  if (action === 'stale') {
    await queryRun(`UPDATE period_review_jobs SET status = 'failed', progress_stage = 'failed', stage_updated_at = ?,
      last_error_code = ?, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
      completed_at = ?, updated_at = ? WHERE id = ? AND model_task_id = ?
      AND status NOT IN ('succeeded','failed','skipped')`,
    [now, String(reason || 'model_task_recovery_stale').slice(0, 128), now, now, jobId, task.task_id])
  }
}

export async function recoverAbandonedPeriodReviewModelTasks({ nowUtcMs = Date.now(), limit = 100 } = {}) {
  return recoverAbandonedBusinessModelTasks({
    taskKinds:['daily_review', 'monthly_review_chunk', 'monthly_review_merge'], nowUtcMs, limit,
    inspectBusiness:inspectPeriodReviewModelTask,
    onBusinessTransition:transitionPeriodReviewModelBusiness,
  })
}

export function buildPeriodReviewModelTaskFrozenContext(job, extras = {}) {
  const memoryVersionNo = Number(job.memory_library_version_no || 0)
  const memoryContentHash = String(job.memory_library_content_hash || '') || null
  return {
    ...extras,
    memory_library_version_no:job.memory_library_version_no == null ? null : memoryVersionNo,
    memory_library_content_hash:memoryContentHash,
  }
}

async function startPeriodReviewModelTask(job, resolved, endpoint, evidence, taskKind) {
  const tracker = await createModelTaskTracker({
    taskKind,
    queueClass:'background',
    ownerUserId:job.user_id,
    strategyId:job.strategy_id,
    domainType:'period_review_job',
    domainId:job.id,
    idempotencyKey:`period_review:${job.id}:${job.idempotency_key}`,
    snapshotHash:job.evidence_hash || sha256(JSON.stringify(evidence)),
    inputHash:sha256(JSON.stringify(evidence)),
    provider:resolved.model.provider,
    model:resolved.model.model_name,
    modelProfileId:resolved.model_profile_id,
    protocol:endpoint.protocol,
    credentialSource:resolved.credential_source,
    frozenContext:buildPeriodReviewModelTaskFrozenContext(job, {
      period_case_id:Number(job.period_case_id), evidence_hash:job.evidence_hash,
    }),
    maxAttempts:Number(job.max_attempts) || 3,
    taskDeadlineAtUtcMs:job._deadlineAtMs,
  }, {
    workerId:`period-review:${process.pid}`,
    linkTask:async taskId => {
      const result = await queryRun(`UPDATE period_review_jobs SET model_task_id = COALESCE(model_task_id, ?)
        WHERE id = ?`, [taskId, job.id])
      const affected = Number(result?.affectedRows ?? result?.changes)
      if (Number.isFinite(affected) && affected < 1) {
        const linked = await queryOne('SELECT model_task_id FROM period_review_jobs WHERE id = ? LIMIT 1', [job.id])
        if (String(linked?.model_task_id || '') !== String(taskId)) throw new Error('model_task_link_failed')
      }
      return true
    },
  })
  job._modelTracker = tracker
  return tracker
}

function checkpointChunkFromRow(row, plan) {
  const chunk = plan.chunks.find(item => Number(item.chunk_index) === Number(row?.chunk_index))
  if (!chunk || String(chunk.source_hash) !== String(row?.source_hash)
    || String(chunk.expected_ids_hash) !== String(row?.expected_ids_hash || row?.expected_id_set_hash)) {
    throw new Error('monthly_review_checkpoint_identity_conflict')
  }
  return chunk
}

function beijingAtUtcMs(utcMs) {
  const date = new Date(Number(utcMs) + 8 * 3600000)
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

async function persistMonthlyReviewChunkSuccess(job, checkpoint, tracker, content) {
  const expectedIds = parse(checkpoint.expected_period_case_ids_json, []).map(Number)
  const validated = validateMonthlyReviewChunkContent(content, expectedIds)
  const body = JSON.stringify(validated)
  const contentHash = sha256(body)
  const nowUtcMs = Date.now()
  await withTransaction(async run => {
    const [jobs] = await run('SELECT status, lease_token FROM period_review_jobs WHERE id = ? FOR UPDATE', [job.id])
    if (!jobs[0] || jobs[0].status !== 'leased' || String(jobs[0].lease_token || '') !== String(job.lease_token || '')) {
      throw new Error('monthly_review_job_lease_lost')
    }
    await tracker.assertOwnedTx(run)
    const [rows] = await run(`SELECT status, lease_token, fencing_token FROM period_review_monthly_checkpoints
      WHERE id = ? FOR UPDATE`, [checkpoint.id])
    const current = rows?.[0]
    if (!current || current.status !== 'leased' || String(current.lease_token || '') !== String(checkpoint.lease_token || '')
      || Number(current.fencing_token) !== Number(checkpoint.fencing_token)) throw new Error('monthly_review_checkpoint_fence_lost')
    const result = await run(`UPDATE period_review_monthly_checkpoints
      SET status = 'succeeded', content_json = ?, content_hash = ?, completed_at_utc_msc = ?,
        lease_token = NULL, lease_owner = NULL, lease_expires_at_utc_msc = NULL,
        updated_at_utc_msc = ?, error_code = NULL, error_message = NULL
      WHERE id = ? AND status = 'leased' AND lease_token = ? AND fencing_token = ?`,
    [body, contentHash, nowUtcMs, nowUtcMs, checkpoint.id, checkpoint.lease_token, checkpoint.fencing_token])
    const affected = Number(result?.affectedRows ?? result?.changes ?? 0)
    if (affected !== 1) throw new Error('monthly_review_checkpoint_fence_lost')
  })
  return { content:validated, contentHash }
}

async function releaseMonthlyReviewParentAfterChunk(job, checkpoint, {
  status = 'queued', nextAttemptAtUtcMs = null, errorCode = null,
} = {}) {
  const now = beijingNow()
  const nextAttemptAt = nextAttemptAtUtcMs == null ? null : beijingAtUtcMs(nextAttemptAtUtcMs)
  const result = await queryRun(`UPDATE period_review_jobs SET status = ?, progress_stage = ?, stage_updated_at = ?,
    last_error_code = ?, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, updated_at = ?
    WHERE id = ? AND lease_token = ? AND status NOT IN ('succeeded','failed','skipped')`,
  [status, status === 'queued' ? 'queued' : status, now, errorCode, nextAttemptAt, now, job.id, job.lease_token])
  const affected = Number(result?.affectedRows ?? result?.changes ?? 0)
  if (affected !== 1) throw new Error('monthly_review_job_lease_lost')
  return { status, nextAttemptAtUtcMs:nextAttemptAtUtcMs == null ? null : Number(nextAttemptAtUtcMs), checkpointId:Number(checkpoint?.id || 0) }
}

function periodReviewProviderRequestStarted(tracker) {
  return tracker?.providerRequestState?.submitted === true
}

async function restoreUnstartedMonthlyCheckpointAttempt(checkpoint) {
  if (!checkpoint || Number(checkpoint.attempt_count || 0) <= 0) return false
  const result = await queryRun(`UPDATE period_review_monthly_checkpoints
    SET attempt_count = GREATEST(attempt_count - 1, 0), updated_at_utc_msc = ?
    WHERE id = ? AND status = 'leased' AND lease_token = ? AND fencing_token = ?
      AND attempt_count > 0`, [Date.now(), checkpoint.id, checkpoint.lease_token, checkpoint.fencing_token])
  const affected = Number(result?.affectedRows ?? result?.changes ?? 0)
  if (affected !== 1) return false
  checkpoint.attempt_count = Math.max(0, Number(checkpoint.attempt_count || 0) - 1)
  return true
}

async function failMonthlyReviewChunk(job, checkpoint, tracker, error) {
  let modelTask = null
  let failure = error
  const exhausted = Number(checkpoint.attempt_count || 0) >= Number(checkpoint.max_attempts || 3)
  try {
    modelTask = await tracker?.failed(error, exhausted)
  } catch (trackerError) {
    failure = trackerError
    console.error(`[PeriodReview case=${job.period_case_id}] monthly chunk model task failure:`, safeError(trackerError))
  }
  const unknown = providerResultUnknown(tracker, modelTask)
  if (unknown) {
  await releaseMonthlyReviewCheckpoint({ checkpointId:checkpoint.id, leaseToken:checkpoint.lease_token,
      fencingToken:checkpoint.fencing_token, status:MONTHLY_REVIEW_CHECKPOINT_STATUSES.STATUS_UNKNOWN,
      errorCode:'provider_status_unknown', errorMessage:safeError(failure) })
    await releaseMonthlyReviewParentAfterChunk(job, checkpoint, { status:'status_unknown', errorCode:'provider_status_unknown' })
    return { status:'status_unknown', error:safeError(failure), modelTask }
  }
  const released = await releaseMonthlyReviewCheckpoint({ checkpointId:checkpoint.id, leaseToken:checkpoint.lease_token,
    fencingToken:checkpoint.fencing_token, status:MONTHLY_REVIEW_CHECKPOINT_STATUSES.FAILED,
    errorCode:safeError(failure), errorMessage:safeError(failure) })
  const parentStatus = released.retryable ? 'queued' : 'failed'
  await releaseMonthlyReviewParentAfterChunk(job, checkpoint, {
    status:parentStatus, nextAttemptAtUtcMs:released.nextAttemptAtUtcMs, errorCode:safeError(failure),
  })
  return { status:released.retryable ? 'retry_wait' : 'failed', error:safeError(failure), modelTask, retryable:released.retryable }
}

async function startMonthlyReviewChunkModelTask(job, resolved, endpoint, checkpoint, chunk) {
  const chunkEvidence = {
    evidence_hash:chunk.evidence_hash || chunk.evidenceHash,
    source_hash:chunk.source_hash || chunk.sourceHash,
    chunk_index:Number(chunk.chunk_index ?? chunk.chunkIndex),
    expected_period_case_ids:chunk.expected_period_case_ids || chunk.expectedPeriodCaseIds,
    sources:chunk.sources || [],
  }
  const attemptNo = Math.max(1, Number(checkpoint.attempt_count || 1))
  const retryIdempotencyKey = [
    'monthly_review_chunk', Number(job.id), String(chunkEvidence.evidence_hash || job.evidence_hash || ''),
    Number(chunkEvidence.chunk_index), String(chunkEvidence.source_hash || ''),
    String(chunk.expected_ids_hash || chunk.expectedIdHash || ''), attemptNo,
  ].join(':')
  // A worker can die after creating the authoritative task but before the
  // provider request starts. Reuse that queued task by its durable key; only
  // an explicit retry/failed checkpoint gets a fresh attempt key.
  const existingTask = checkpoint.model_task_id
    ? await queryOne('SELECT task_id, status, idempotency_key FROM ai_model_tasks WHERE task_id = ? LIMIT 1', [checkpoint.model_task_id])
    : null
  const idempotencyKey = existingTask && ['queued', 'retry_wait'].includes(String(existingTask.status || ''))
    && existingTask.idempotency_key ? existingTask.idempotency_key : retryIdempotencyKey
  const tracker = await createModelTaskTracker({
    taskKind:'monthly_review_chunk',
    queueClass:'background',
    ownerUserId:job.user_id,
    strategyId:job.strategy_id,
    domainType:'period_review_monthly_checkpoint',
    domainId:checkpoint.id,
    idempotencyKey,
    snapshotHash:String(chunkEvidence.evidence_hash || job.evidence_hash || ''),
    inputHash:sha256(JSON.stringify(chunkEvidence)),
    provider:resolved.model.provider,
    model:resolved.model.model_name,
    modelProfileId:resolved.model_profile_id,
    protocol:endpoint.protocol,
    credentialSource:resolved.credential_source,
    frozenContext:buildPeriodReviewModelTaskFrozenContext(job, { period_review_job_id:Number(job.id), period_case_id:Number(job.period_case_id),
      checkpoint_id:Number(checkpoint.id), evidence_hash:chunkEvidence.evidence_hash,
      source_hash:chunkEvidence.source_hash, chunk_index:chunkEvidence.chunk_index,
      expected_period_case_ids:chunkEvidence.expected_period_case_ids }),
    maxAttempts:Number(checkpoint.max_attempts || 3),
    taskDeadlineAtUtcMs:job._deadlineAtMs,
  }, {
    workerId:`period-review-monthly-chunk:${process.pid}`,
    linkTask:taskId => linkMonthlyReviewCheckpointModelTask({
      checkpointId:checkpoint.id, leaseToken:checkpoint.lease_token,
      fencingToken:checkpoint.fencing_token, modelTaskId:taskId,
    }),
  })
  return tracker
}

async function claimDailyReviewJob() {
  return withTransaction(async run => {
    const [rows] = await run(`SELECT jobs.*, cases.user_id, cases.strategy_id, cases.evidence_json, cases.evidence_hash
      FROM period_review_jobs jobs JOIN period_review_cases cases ON cases.id = jobs.period_case_id
      WHERE jobs.job_type = 'daily_review'
        AND jobs.job_slot = 0
        AND ((jobs.status = 'queued' AND (jobs.next_attempt_at IS NULL OR jobs.next_attempt_at <= ?))
          OR (jobs.status = 'leased' AND jobs.lease_expires_at < ?))
        AND jobs.attempt_count < jobs.max_attempts AND cases.period_type = 'daily'
        AND cases.strategy_compatibility_hash IS NOT NULL AND cases.evidence_status = 'complete'
      ORDER BY jobs.updated_at, jobs.id LIMIT 1 FOR UPDATE`, [beijingNow(), beijingNow()])
    if (!rows[0]) return null
    const token = crypto.randomUUID()
    await run(`UPDATE period_review_jobs SET status = 'leased', progress_stage = 'preparing', stage_updated_at = ?, lease_token = ?, lease_expires_at = ?, next_attempt_at = NULL,
      updated_at = ? WHERE id = ?`, [beijingNow(), token, afterSeconds(120), beijingNow(), rows[0].id])
    await run(`UPDATE period_review_cases SET status = 'generating', updated_at = ?
      WHERE id = ? AND current_version_id IS NULL`, [beijingNow(), rows[0].period_case_id])
    return { ...rows[0], lease_token: token, attempt_count: Number(rows[0].attempt_count || 0) }
  })
}

async function getReviewStrategyMemorySnapshot(job) {
  if (job._strategyMemorySnapshot) return job._strategyMemorySnapshot
  if (job.memory_library_version_no !== null && job.memory_library_version_no !== undefined
    && job.memory_library_content_hash && job.memory_library_snapshot_text !== null
    && job.memory_library_snapshot_text !== undefined
    && job.memory_strategy_snapshot_text !== null && job.memory_strategy_snapshot_text !== undefined) {
    job._strategyMemorySnapshot = {
      strategy_text:String(job.memory_strategy_snapshot_text),
      library:{
        strategy_id:Number(job.strategy_id),
        version_no:Number(job.memory_library_version_no),
        content_hash:String(job.memory_library_content_hash),
        content_text:String(job.memory_library_snapshot_text),
        char_count:Array.from(String(job.memory_library_snapshot_text)).length,
      },
    }
    return job._strategyMemorySnapshot
  }
  const snapshot = await getStrategyMemoryLibraryForRuntime({
    strategyId:job.strategy_id,
    actor:{ userId:job.user_id, role:job.user_role || 'user' },
  })
  const result = await queryRun(`UPDATE period_review_jobs
      SET memory_library_version_no = ?, memory_library_content_hash = ?,
          memory_library_snapshot_text = ?, memory_strategy_snapshot_text = ?, updated_at = ?
    WHERE id = ? AND memory_library_version_no IS NULL`,
  [snapshot.library.version_no, snapshot.library.content_hash, snapshot.library.content_text,
    snapshot.strategy_text || '', beijingNow(), job.id])
  if (!Number(result.changes || result.affectedRows || 0)) {
    const frozen = await queryOne(`SELECT memory_library_version_no, memory_library_content_hash,
        memory_library_snapshot_text, memory_strategy_snapshot_text
      FROM period_review_jobs WHERE id = ?`, [job.id])
    if (!frozen || frozen.memory_library_version_no === null) throw new Error('period_review_memory_snapshot_freeze_failed')
    job.memory_library_version_no = frozen.memory_library_version_no
    job.memory_library_content_hash = frozen.memory_library_content_hash
    job.memory_library_snapshot_text = frozen.memory_library_snapshot_text
    job.memory_strategy_snapshot_text = frozen.memory_strategy_snapshot_text
    return getReviewStrategyMemorySnapshot(job)
  }
  job.memory_library_version_no = snapshot.library.version_no
  job.memory_library_content_hash = snapshot.library.content_hash
  job.memory_library_snapshot_text = snapshot.library.content_text
  job.memory_strategy_snapshot_text = snapshot.strategy_text || ''
  job._strategyMemorySnapshot = snapshot
  return snapshot
}

async function ensurePeriodReviewStrategyMemoryInjectionLog(job, snapshot, usageKind = 'review', modelTaskId = null, deps = {}) {
  const taskId = String(modelTaskId || job._modelTracker?.taskId || job.model_task_id || '').trim()
  if (!taskId) throw new Error('period_review_memory_task_missing')
  const rawVersionNo = snapshot?.library?.version_no
  const versionNo = Number(rawVersionNo)
  const contentHash = String(snapshot?.library?.content_hash || '')
  const hasContent = snapshot?.library && Object.hasOwn(snapshot.library, 'content_text')
    && snapshot.library.content_text !== null && snapshot.library.content_text !== undefined
  const contentText = hasContent ? String(snapshot.library.content_text) : ''
  if (rawVersionNo === null || rawVersionNo === undefined
    || !Number.isSafeInteger(versionNo) || versionNo < 0 || !hasContent
    || !/^[a-f0-9]{64}$/i.test(contentHash)
    || sha256(contentText) !== contentHash) throw new Error('period_review_memory_snapshot_invalid')
  const findExisting = typeof deps.findExisting === 'function' ? deps.findExisting : queryOne
  const existing = await findExisting(`SELECT * FROM strategy_memory_injection_logs
    WHERE strategy_id = ? AND library_version_no = ? AND library_content_hash = ?
      AND usage_kind = ? AND period_review_case_id = ? AND model_task_id = ?
    ORDER BY id LIMIT 1`, [Number(job.strategy_id), versionNo, contentHash, usageKind,
    Number(job.period_case_id), taskId])
  if (existing) return existing
  const createLog = typeof deps.createLog === 'function' ? deps.createLog : createStrategyMemoryInjectionLog
  const created = await createLog({
    strategyId:job.strategy_id,
    actor:{ userId:job.user_id, role:job.user_role || 'user' },
    library:snapshot.library,
    injectionKind:usageKind,
    periodReviewCaseId:job.period_case_id,
    modelTaskId:taskId,
  })
  if (!created?.id) throw new Error('period_review_memory_injection_log_failed')
  return created
}

export const __testEnsurePeriodReviewStrategyMemoryInjectionLog = ensurePeriodReviewStrategyMemoryInjectionLog

async function generateDailyReview(job, requestModel) {
  const evidence = parse(job.evidence_json, null)
  if (!evidence || !Array.isArray(evidence.sources) || !evidence.sources.length) throw new Error('daily_review_evidence_invalid')
  const resolved = await resolveAiTaskModel({ userId: job.user_id, strategyId: job.strategy_id, usage: 'review',
    modelPurpose:'daily_review' })
  if (!resolved.model) throw new Error(resolved.error || 'daily_review_model_unavailable')
  const strategyMemorySnapshot = await getReviewStrategyMemorySnapshot(job)
  const strategyMemoryForPrompt = sanitizeStrategyMemoryPrompt(strategyMemorySnapshot.library)
  const endpoint = modelEndpoint(resolved.model)
  const outcomeIds = evidence.sources.map(item => Number(item.outcome_id))
  const chanContext = frozenDailyChanContext(evidence)
  const chanAllowed = chanContext.mode === 'enabled_complete'
  const memoryCategoryEnum = chanAllowed
    ? 'general|market_regime|entry_setup|chan_structure|risk_execution'
    : 'general|market_regime|entry_setup|risk_execution'
  const shape = { period_summary: 'string', decision_quality: 'good|mixed|poor|insufficient_evidence',
    trade_assessments: outcomeIds.map(outcomeId => ({ outcome_id: outcomeId, decision_quality: 'good|mixed|poor|insufficient_evidence', summary: 'string', issue_codes: ['string'] })),
    repeated_issues: ['string'], strengths: ['string'], daily_lessons: ['string'], risk_observations: ['string'],
    memory_updates:[{ text:'string', category:memoryCategoryEnum, source_refs:['string'] }],
    strategy_conflicts:[{ conflict_target:'existing_memory|proposed_experience', category:memoryCategoryEnum,
      summary:'string', strategy_excerpt:'必须逐字来自 current_strategy',
      memory_excerpt:'必须逐字来自 strategy_memory_library 或同响应 memory_updates',
      suggested_change:'string', source_refs:['string'] }],
    confidence: 0.5 }
  if (chanAllowed) {
    shape.chan_diagnoses = outcomeIds.map(outcomeId => ({ outcome_id: outcomeId, status: 'normal|suspected_issue|confirmed_issue|insufficient_evidence', issue_source: 'data|calculation|confirmation_lag|ai_interpretation|strategy_rule|none|unknown', impact_on_decision: 'none|minor|material|unknown', explanation: 'string', confidence: 0.5 }))
    shape.period_chan_assessment = { status:'normal|suspected_issue|confirmed_issue|insufficient_evidence',
      issue_source:'data|calculation|confirmation_lag|ai_interpretation|strategy_rule|none|unknown',
      explanation:'string', affected_outcome_ids:outcomeIds, confidence:0.5 }
  }
  const tradeCoverageContract = chanAllowed
    ? `trade_assessments 和 chan_diagnoses 必须各包含 ${outcomeIds.length} 项，并且 outcome_id 只能且必须完整覆盖：${outcomeIds.join(', ')}。`
    : `trade_assessments 必须包含 ${outcomeIds.length} 项，并且 outcome_id 只能且必须完整覆盖：${outcomeIds.join(', ')}；Chan 未获准时 required_output 不包含 chan_diagnoses。`
  const memoryCategoryContract = chanAllowed
    ? 'memory_updates 的 category 可使用 required_output 中列出的全部类别。'
    : 'memory_updates 的 category 不得使用 chan_structure；Chan 未获准时不得生成 Chan 记忆。'
  const contract = [
    '输出必须是一个 JSON 对象，禁止 Markdown、解释文字和外层包装字段。',
    '必须原样使用 required_output 中的全部字段名；所有字段必填，即使没有内容也必须返回空数组。',
    'period_summary 必须是非空中文总结；decision_quality 只能使用给定枚举；confidence 必须是 0 到 1 的数字。',
    '除 JSON 字段名和规定枚举值外，所有用户可见字符串与数组内容必须使用简体中文；禁止输出内部错误码、英文状态或整句英文。品种代码、周期以及 AI、MT5、MACD、RSI、ATR、KDJ、EMA、SMA 等通用技术缩写可以保留。',
    tradeCoverageContract,
    `不得遗漏、合并或虚构交易；不得修改系统提供的基础统计。memory_updates 和 strategy_conflicts 没有可靠结论时必须返回空数组；每个对象的文本和引用字段必须符合 required_output。source_refs 只能引用服务器提供的 outcome:<id>，不得编造其他来源。strategy_excerpt 必须逐字来自 current_strategy；existing_memory 的 memory_excerpt 必须逐字来自 strategy_memory_library.content_text；proposed_experience 的 memory_excerpt 必须逐字来自同响应 memory_updates.text。${memoryCategoryContract}`,
    chanAllowed ? '只有冻结证据明确启用缠论且 Chan 证据完整时才可输出缠论诊断；缠论记忆类别必须有可靠结构证据。'
      : '冻结证据未同时满足缠论启用和完整条件；禁止输出任何缠论字段、缠论诊断或 chan_structure 记忆。',
  ].join('\n')
  const chanPrompt = chanAllowed
    ? '冻结证据明确启用了缠论且 period_market 的 Chan 证据完整；请根据能力字段判断可用结构。'
    : '冻结证据未同时满足缠论启用和完整条件；不要输出、推断或评价任何缠论结构，也不要生成 chan_structure 记忆。'
  const messages = [
    { role: 'system', content: `你是严格的交易日复盘分析器。所有基础统计以系统提供的数据为准，不得自行重算。period_market 是按策略周期提取的完整交易日行情；${chanPrompt} 必须判断问题来自行情数据、结构计算、确认延迟、AI 解读还是策略规则。period_market.status 不完整时必须降低置信度。必须区分推理时结构、同时间点回放结构和事后最终结构；未来数据只能用于事后解释，不能反过来判定当时决策错误。不得把盈利等同于决策正确，也不得把亏损等同于决策错误。\n\n以下输出契约不可违反：\n${contract}` },
    { role: 'user', content: JSON.stringify({ required_output: shape, current_strategy:strategyMemorySnapshot.strategy_text,
      strategy_memory_library:strategyMemoryForPrompt, evidence:stripHistoricalConditionFields(evidence) }) },
  ]
  const modelCall = await preparePeriodReviewModelCall('daily_review', resolved, messages,
    Math.max(3000, Math.ceil(JSON.stringify(shape).length / 2.5)), {
      nowUtcMs:Date.now(), businessDeadlineUtcMs:job._deadlineAtMs,
    })
  job._deadlineAtMs = modelCall.taskDeadlineUtcMs
  job._attemptDeadlineAtMs = modelCall.attemptSafetyDeadlineUtcMs
  job._modelBudget = modelCall.budget
  const tracker = await startPeriodReviewModelTask(job, resolved, endpoint, evidence, 'daily_review')
  await ensurePeriodReviewStrategyMemoryInjectionLog(job, strategyMemorySnapshot, 'daily_review', tracker.taskId)
  await tracker.persistBudget(modelCall.budget)
  const requestSignal = job._abortSignal && tracker.signal
    ? AbortSignal.any([job._abortSignal, tracker.signal])
    : tracker.signal || job._abortSignal || null
  const output = await requestModel({ url: endpoint.url, apiKey: resolved.model.api_key_encrypted, provider: resolved.model.provider,
    model: resolved.model.model_name, temperature: Math.min(Number(resolved.model.temperature ?? 0.2), 0.3),
    maxTokens:modelCall.budget.selectedMaxOutputTokens, thinkingEnabled: resolved.model.thinking_enabled,
    reasoningEffort: resolved.model.reasoning_effort, protocol: endpoint.protocol,
    timeout:modelCall.requestTimeoutMs, deadlineAtMs:modelCall.attemptSafetyDeadlineUtcMs,
    followupValidUntilMs:modelCall.attemptSafetyDeadlineUtcMs,
    signal:requestSignal,
    messages, modelTaskBudget:modelCall.budget,
    usageContext: { userId: job.user_id, profileId: resolved.model_profile_id, credentialSource: resolved.credential_source, usage: 'review', strategyId: job.strategy_id },
    onProviderRequest:periodReviewProviderRequestCallback(job, tracker),
    onProviderUsage:event => tracker.onProviderUsage(event),
    onProviderActivity:event => tracker.onProviderActivity(event),
    onProviderQuiet:event => tracker.onProviderQuiet(event),
    onProgress: stage => setPeriodReviewJobStage(job, stage),
     validateObject: value => validateDailyReviewContent(value, outcomeIds, chanContext, {
       strategyText:strategyMemorySnapshot.strategy_text,
       memoryText:strategyMemorySnapshot.library.content_text,
     }),
  })
  const content = validateDailyReviewContent(output, outcomeIds, chanContext, {
    strategyText:strategyMemorySnapshot.strategy_text,
    memoryText:strategyMemorySnapshot.library.content_text,
  })
  await tracker.resultReady({ resultHash:sha256(JSON.stringify(content)) })
  return { content, resolved }
}

async function finishDailyReviewSuccess(job, generated) {
  await withTransaction(async run => {
    const [jobs] = await run('SELECT * FROM period_review_jobs WHERE id = ? FOR UPDATE', [job.id])
    if (!jobs[0] || jobs[0].status !== 'leased' || jobs[0].lease_token !== job.lease_token) throw new Error('daily_review_job_lease_lost')
    await job._modelTracker?.assertOwnedTx(run)
    const [cases] = await run('SELECT * FROM period_review_cases WHERE id = ? FOR UPDATE', [job.period_case_id])
    if (!cases[0]) throw new Error('daily_review_case_missing')
    const now = beijingNow()
    if (!cases[0].current_version_id) {
      const [versions] = await run('SELECT id, version_no FROM period_review_versions WHERE period_case_id = ? ORDER BY version_no DESC LIMIT 1 FOR UPDATE', [job.period_case_id])
      const parentVersionId = versions[0]?.id || null
      const nextVersionNo = Number(versions[0]?.version_no || 0) + 1
      const body = JSON.stringify(generated.content)
      const [insert] = await run(`INSERT INTO period_review_versions
        (period_case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
        VALUES (?, ?, ?, 'ai', NULL, ?, ?, 'AI daily review draft', ?)`, [job.period_case_id, nextVersionNo, parentVersionId, body, sha256(body), now])
      await run(`UPDATE period_review_cases SET status = 'draft', current_version_id = ?, updated_at = ? WHERE id = ?`, [insert.insertId, now, job.period_case_id])
    }
    await run(`UPDATE period_review_jobs SET status = 'succeeded', progress_stage = 'succeeded', stage_updated_at = ?,
      model_profile_id = ?, credential_source = ?, last_error_code = NULL, next_attempt_at = NULL, completed_at = ?,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
    [now, generated.resolved.model_profile_id, generated.resolved.credential_source, now, now, job.id])
  })
}

function providerResultUnknown(tracker, task = null) {
  const status = String(task?.status || tracker?.status || '')
  if (status === 'status_unknown' || status === 'provider_quiet') return true
  const providerState = tracker?.providerRequestState
  return providerState?.submitted === true && providerState?.responseReceived !== true
}

async function finishDailyReviewFailure(job, error, modelTask = null) {
  const unknown = providerResultUnknown(job._modelTracker, modelTask)
  const exhausted = job.attempt_count >= Number(job.max_attempts)
  const retryAt = unknown || exhausted ? null : afterSeconds(Math.min(900, 60 * (2 ** Math.max(0, Number(job.attempt_count) - 1))))
  const jobStatus = unknown ? 'status_unknown' : exhausted ? 'failed' : 'queued'
  const errorCode = unknown ? 'provider_status_unknown' : safeError(error)
  await queryRun(`UPDATE period_review_jobs SET status = ?, last_error_code = ?, lease_token = NULL,
    lease_expires_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?`,
  [jobStatus, errorCode, retryAt, beijingNow(), job.id, job.lease_token])
  // The review case remains generating while the provider outcome is
  // unresolved.  Only the job/status stage is marked unknown; showing a
  // failed case would incorrectly imply that no provider request was made.
  await queryRun(`UPDATE period_review_cases SET status = ?, updated_at = ? WHERE id = ? AND current_version_id IS NULL`, [unknown ? 'generating' : exhausted ? 'failed' : 'ready', beijingNow(), job.period_case_id])
}

async function skipDisabledPeriodReviewJob(job) {
  const now = beijingNow()
  await withTransaction(async run => {
    await run(`UPDATE period_review_jobs SET status = 'skipped', progress_stage = 'skipped', stage_updated_at = ?,
      last_error_code = 'review_generation_disabled', lease_token = NULL, lease_expires_at = NULL,
      next_attempt_at = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?`,
    [now, now, now, job.id, job.lease_token])
    await run(`UPDATE period_review_cases SET status = 'ready', updated_at = ?
      WHERE id = ? AND current_version_id IS NULL`, [now, job.period_case_id])
  })
  await setPeriodReviewJobStage(job, 'skipped', 'info', 'review_generation_disabled')
  return { claimed:true, status:'skipped', periodCaseId:Number(job.period_case_id), reason:'review_generation_disabled' }
}

export async function runDailyReviewWorkerOnce({ requestModel = requestJsonObject } = {}) {
  const job = await claimDailyReviewJob()
  if (!job) return { claimed: false }
  job._deadlineAtMs = modelTaskDeadlines('daily_review', { nowUtcMs:Date.now() }).taskDeadlineUtcMs
  const lease = startPeriodReviewLeaseHeartbeat(job)
  job._abortSignal = lease.signal
  await setPeriodReviewJobStage(job, 'preparing')
  try {
    if (!await isAiFeatureEnabled('review_generation_enabled', job.user_id)) return skipDisabledPeriodReviewJob(job)
    const generated = await generateDailyReview(job, requestModel)
    lease.assertOwned()
    job._modelTracker?.assertOwned()
    await job._modelTracker?.applying()
    lease.assertOwned()
    job._modelTracker?.assertOwned()
    await finishDailyReviewSuccess(job, generated)
    await job._modelTracker?.succeeded({ resultRef:`period_review_case:${job.period_case_id}` })
    await setPeriodReviewJobStage(job, 'succeeded', 'success')
    return { claimed: true, status: 'succeeded', periodCaseId: Number(job.period_case_id) }
  } catch (error) {
    let failure = error
    let modelTask = null
    try {
      modelTask = await job._modelTracker?.failed(error, job.attempt_count >= Number(job.max_attempts))
    } catch (trackerError) {
      failure = trackerError
      console.error(`[PeriodReview case=${job.period_case_id}] model task failure:`, safeError(trackerError))
    }
    await finishDailyReviewFailure(job, failure, modelTask)
    const unknown = providerResultUnknown(job._modelTracker, modelTask)
    await setPeriodReviewJobStage(job, unknown ? 'status_unknown' : job.attempt_count >= Number(job.max_attempts) ? 'failed' : 'retry_wait', 'error', safeError(error),
      unknown || job.attempt_count >= Number(job.max_attempts) ? null : { retry_delay_seconds: Math.min(900, 60 * (2 ** Math.max(0, Number(job.attempt_count) - 1))) })
    return { claimed: true, status: unknown ? 'status_unknown' : 'failed', periodCaseId: Number(job.period_case_id), error: safeError(failure) }
  } finally {
    try { await job._modelTracker?.stop() } catch (trackerError) {
      console.error(`[PeriodReview case=${job.period_case_id}] model task stop:`, safeError(trackerError))
    }
    await lease.stop()
  }
}

async function claimMonthlyReviewJob() {
  return withTransaction(async run => {
    const [rows] = await run(`SELECT jobs.*, cases.user_id, cases.strategy_id, cases.evidence_json, cases.evidence_hash
      FROM period_review_jobs jobs JOIN period_review_cases cases ON cases.id = jobs.period_case_id
      WHERE jobs.job_type = 'monthly_review'
        AND jobs.job_slot = 0
        AND ((jobs.status = 'queued' AND (jobs.next_attempt_at IS NULL OR jobs.next_attempt_at <= ?))
          OR (jobs.status = 'leased' AND jobs.lease_expires_at < ?))
        AND jobs.attempt_count < jobs.max_attempts AND cases.period_type = 'monthly'
        AND cases.strategy_compatibility_hash IS NOT NULL AND cases.evidence_status = 'complete'
      ORDER BY jobs.updated_at, jobs.id LIMIT 1 FOR UPDATE`, [beijingNow(), beijingNow()])
    if (!rows[0]) return null
    const token = crypto.randomUUID()
    await run(`UPDATE period_review_jobs SET status = 'leased', progress_stage = 'preparing', stage_updated_at = ?, lease_token = ?, lease_expires_at = ?, next_attempt_at = NULL,
      updated_at = ? WHERE id = ?`, [beijingNow(), token, afterSeconds(120), beijingNow(), rows[0].id])
    await run(`UPDATE period_review_cases SET status = 'generating', updated_at = ?
      WHERE id = ? AND current_version_id IS NULL`, [beijingNow(), rows[0].period_case_id])
    return { ...rows[0], lease_token: token, attempt_count: Number(rows[0].attempt_count || 0) }
  })
}

async function generateMonthlyReviewChunk(job, requestModel, checkpoint, chunk) {
  const resolved = await resolveAiTaskModel({ userId:job.user_id, strategyId:job.strategy_id, usage:'review',
    modelPurpose:'monthly_review' })
  if (!resolved.model) throw new Error(resolved.error || 'monthly_review_model_unavailable')
  const strategyMemorySnapshot = await getReviewStrategyMemorySnapshot(job)
  const strategyMemoryForPrompt = sanitizeStrategyMemoryPrompt(strategyMemorySnapshot.library)
  const endpoint = modelEndpoint(resolved.model)
  const checkpointLease = startMonthlyReviewCheckpointLeaseHeartbeat(checkpoint)
  job._checkpointLease = checkpointLease
  const expectedIds = chunk.expected_period_case_ids || chunk.expectedPeriodCaseIds
  const chanContext = monthlyChanContext({ sources:chunk.sources || [] })
  const chanAllowed = chanContext.mode === 'enabled_complete'
  const shape = {
    period_summary:'string', decision_quality:'good|mixed|poor|insufficient_evidence',
    daily_assessments:expectedIds.map(id => ({ period_case_id:id, decision_quality:'good|mixed|poor|insufficient_evidence', summary:'string', issue_codes:['string'] })),
    local_patterns:[{ text:'string', supporting_period_case_ids:expectedIds.slice(0, 1), market_regime:'trend|range|breakout|pullback|reversal', confidence:0.5 }],
    strengths:[{ text:'string', supporting_period_case_ids:expectedIds.slice(0, 1), market_regime:'trend', confidence:0.5 }],
    risks:[{ text:'string', supporting_period_case_ids:expectedIds.slice(0, 1), market_regime:'range', confidence:0.5 }],
    action_candidates:[{ text:'string', supporting_period_case_ids:expectedIds.slice(0, 1), market_regime:'trend', confidence:0.5 }],
    conflict_groups:[{ conflict_key:'string', supporting_period_case_ids:expectedIds.slice(0, 2), candidates:[
      { text:'string', market_regime:'trend', supporting_period_case_ids:expectedIds.slice(0, 1) },
      { text:'string', market_regime:'range', supporting_period_case_ids:expectedIds.slice(0, 1) },
    ] }],
    strategy_conflicts:[{ conflict_target:'existing_memory', category:'general|market_regime|entry_setup|chan_structure|risk_execution',
      summary:'string', strategy_excerpt:'必须逐字来自 current_strategy',
      memory_excerpt:'必须逐字来自 strategy_memory_library.content_text', suggested_change:'string', source_refs:['string'] }],
    confidence:0.5,
  }
  if (chanAllowed) shape.chan_observations = [{ text:'string', supporting_period_case_ids:expectedIds.slice(0, 1), market_regime:'trend', confidence:0.5 }]
  const contract = [
    '输出必须是一个 JSON 对象，禁止 Markdown、解释文字和外层包装字段。',
    '必须原样使用 required_output 中的全部字段名；所有字段必填，没有结论时也必须返回空数组。',
    '除 JSON 字段名和规定枚举值外，分块内的用户可见字符串与数组内容使用简体中文；不得输出内部错误码、英文状态或整句英文。',
    `daily_assessments 必须恰好包含 ${expectedIds.length} 项，并完整覆盖且仅覆盖：${expectedIds.join(', ')}。`,
    `${chanAllowed ? 'local_patterns、strengths、risks、chan_observations、action_candidates' : 'local_patterns、strengths、risks、action_candidates'} 的每项必须是结构化对象，带 supporting_period_case_ids 和 market_regime；支持 ID 只能来自本分块。`,
    '互相矛盾的行情经验必须分别放在 conflict_groups.candidates 中，不能合并成一条；每个候选仍需保留自己的行情状态和支持 ID。strategy_conflicts 只允许 existing_memory，两个 excerpt 都必须逐字复制对应冻结原文。',
  ].join('\n')
  const messages = [
    { role:'system', content:`你是严格的交易月度复盘分块分析器。只能分析本分块已冻结的日复盘和行情摘要，不得自行补造统计。\n\n${contract}` },
    { role:'user', content:JSON.stringify({ required_output:shape,
      current_strategy:strategyMemorySnapshot.strategy_text,
      strategy_memory_library:strategyMemoryForPrompt, chunk:stripHistoricalConditionFields(chunk) }) },
  ]
  const modelCall = await preparePeriodReviewModelCall('monthly_review_chunk', resolved, messages,
    Math.max(3500, Math.ceil(JSON.stringify(shape).length / 2.5)), {
      nowUtcMs:Date.now(), businessDeadlineUtcMs:job._deadlineAtMs,
    })
  job._deadlineAtMs = modelCall.taskDeadlineUtcMs
  job._attemptDeadlineAtMs = modelCall.attemptSafetyDeadlineUtcMs
  job._modelBudget = modelCall.budget
  const tracker = await startMonthlyReviewChunkModelTask(job, resolved, endpoint, checkpoint, chunk)
  job._modelTracker = tracker
  await ensurePeriodReviewStrategyMemoryInjectionLog(job, strategyMemorySnapshot, 'monthly_review_chunk', tracker.taskId)
  await tracker.persistBudget(modelCall.budget)
  const requestSignal = [job._abortSignal, checkpointLease.signal, tracker.signal].filter(Boolean).length > 1
    ? AbortSignal.any([job._abortSignal, checkpointLease.signal, tracker.signal].filter(Boolean))
    : tracker.signal || checkpointLease.signal || job._abortSignal || null
  const output = await requestModel({ url:endpoint.url, apiKey:resolved.model.api_key_encrypted, provider:resolved.model.provider,
    model:resolved.model.model_name, temperature:Math.min(Number(resolved.model.temperature ?? 0.2), 0.3),
    maxTokens:modelCall.budget.selectedMaxOutputTokens, thinkingEnabled:resolved.model.thinking_enabled,
    reasoningEffort:resolved.model.reasoning_effort, protocol:endpoint.protocol,
    timeout:modelCall.requestTimeoutMs, deadlineAtMs:modelCall.attemptSafetyDeadlineUtcMs,
    followupValidUntilMs:modelCall.attemptSafetyDeadlineUtcMs, signal:requestSignal,
    messages, modelTaskBudget:modelCall.budget,
    usageContext:{ userId:job.user_id, profileId:resolved.model_profile_id, credentialSource:resolved.credential_source, usage:'review', strategyId:job.strategy_id },
    // Chunk retries are accounted by their fenced checkpoint. The parent
    // business attempt is reserved for the final monthly merge; otherwise a
    // month with more chunks than max_attempts could exhaust before merging.
    onProviderRequest:event => tracker.onProviderRequest(event),
    onProviderUsage:event => tracker.onProviderUsage(event),
    onProviderActivity:event => tracker.onProviderActivity(event),
    onProviderQuiet:event => tracker.onProviderQuiet(event),
    onProgress:stage => setPeriodReviewJobStage(job, `monthly_chunk_${Number(chunk.chunk_index)}`,
      'info', stage),
     validateObject:value => validateMonthlyReviewChunkContent(value, expectedIds, chanContext, {
       strategyText:strategyMemorySnapshot.strategy_text,
       memoryText:strategyMemorySnapshot.library.content_text,
     }),
  })
  const content = validateMonthlyReviewChunkContent(output, expectedIds, chanContext, {
    strategyText:strategyMemorySnapshot.strategy_text,
    memoryText:strategyMemorySnapshot.library.content_text,
  })
  await tracker.resultReady({ resultHash:sha256(JSON.stringify(content)) })
  return { content, resolved, tracker, checkpointLease }
}

function verifiedMonthlyMergeEvidence(evidence, checkpointResult) {
  const chunks = checkpointResult.checkpoints.map(row => ({
    checkpoint_id:Number(row.id), chunk_index:Number(row.chunk_index), source_hash:row.source_hash,
    expected_period_case_ids:parse(row.expected_period_case_ids_json, []).map(Number),
    content:parseCheckpointContent(row),
  }))
  const conflictGroups = chunks.flatMap(chunk => Array.isArray(chunk.content?.conflict_groups)
    ? chunk.content.conflict_groups.map(group => ({ ...group, chunk_index:chunk.chunk_index, checkpoint_id:chunk.checkpoint_id })) : [])
  const strategyConflicts = chunks.flatMap(chunk => Array.isArray(chunk.content?.strategy_conflicts)
    ? chunk.content.strategy_conflicts.map(conflict => ({ ...conflict, chunk_index:chunk.chunk_index, checkpoint_id:chunk.checkpoint_id })) : [])
  return {
    evidence_hash:evidence.evidence_hash,
    period:evidence.period,
    strategy:evidence.strategy,
    statistics:evidence.statistics,
    source_quality:evidence.source_quality,
    period_market_digest:evidence.period_market_digest,
    expected_period_case_ids:checkpointResult.expectedPeriodCaseIds,
    verified_daily_assessments:checkpointResult.assessments,
    verified_chunks:chunks,
    conflict_groups:conflictGroups,
    strategy_conflicts:strategyConflicts,
  }
}

async function generateMonthlyReviewMerge(job, requestModel, evidence, checkpointResult) {
  const resolved = await resolveAiTaskModel({ userId:job.user_id, strategyId:job.strategy_id, usage:'review',
    modelPurpose:'monthly_review' })
  if (!resolved.model) throw new Error(resolved.error || 'monthly_review_model_unavailable')
  const strategyMemorySnapshot = await getReviewStrategyMemorySnapshot(job)
  const strategyMemoryForPrompt = sanitizeStrategyMemoryPrompt(strategyMemorySnapshot.library)
  const endpoint = modelEndpoint(resolved.model)
  const dailyCaseIds = checkpointResult.expectedPeriodCaseIds
  const approvedDailyCaseIds = evidence.sources.filter(item => item.review_status === 'approved')
    .map(item => Number(item.period_case_id)).filter(id => dailyCaseIds.includes(id))
  const chanContext = monthlyChanContext(evidence)
  const memoryCategoryEnum = chanContext.mode === 'enabled_complete'
    ? 'general|market_regime|entry_setup|chan_structure|risk_execution'
    : 'general|market_regime|entry_setup|risk_execution'
  const mergeEvidence = verifiedMonthlyMergeEvidence(evidence, checkpointResult)
  const shape = { period_summary:'string', decision_quality:'good|mixed|poor|insufficient_evidence',
    daily_assessments:dailyCaseIds.map(id => ({ period_case_id:id, decision_quality:'good|mixed|poor|insufficient_evidence', summary:'string', issue_codes:['string'] })),
    recurring_patterns:['string'], strengths:['string'], risk_observations:['string'],
    next_month_actions:['string'], memory_candidates:approvedDailyCaseIds.length >= 2 ? [{ lesson:'string', anti_pattern:'string',
      memory_category:memoryCategoryEnum,
      supporting_period_case_ids:approvedDailyCaseIds.slice(0, 2), confidence:0.5 }] : [],
    conflict_groups:mergeEvidence.conflict_groups,
    strategy_conflicts:mergeEvidence.strategy_conflicts,
    confidence:0.5 }
  if (chanContext.mode === 'enabled_complete') shape.chan_issue_summary = ['string']
  const contract = [
    '输出必须是一个 JSON 对象，禁止 Markdown、解释文字和外层包装字段。',
    '必须原样使用 required_output 的字段名；基础统计、已验证日复盘和 conflict_groups 只可作为输入依据。',
    '除 JSON 字段名和规定枚举值外，所有用户可见字符串与数组内容必须使用简体中文；禁止输出内部错误码、英文状态或整句英文。',
    'daily_assessments 必须恰好覆盖全部且仅覆盖 expected_period_case_ids；不得遗漏、重复、合并或虚构日复盘。',
    `memory_candidates 是唯一的新月度记忆候选结构，只能包含 lesson、anti_pattern、memory_category、supporting_period_case_ids、confidence；memory_category 只能使用 ${memoryCategoryEnum}；必须仅引用已确认日复盘且每项至少两个不同日复盘支持；不满足时返回空数组。supporting_period_case_ids 是服务器提供的权威 period_review_case:<id> 来源，不得编造或留空。`,
    chanContext.mode === 'enabled_complete'
      ? '冻结月度来源中的 Chan 证据全部启用且完整，才可输出 Chan 字段或 chan_structure 记忆。'
      : '冻结月度来源中的 Chan 证据未同时满足启用和完整条件；required_output 不包含 Chan 字段，禁止输出 Chan 内容或 chan_structure 记忆。',
    'strategy_conflicts 是服务器已验证的分块冲突，必须原样保留；不得删除、改写、补造或用新的描述覆盖。',
    '冲突行情经验必须保留为独立 conflict_groups.candidates，分别写明 market_regime 与 supporting_period_case_ids，不得静默合并。',
  ].join('\n')
  const messages = [
    { role:'system', content:`你是严格的交易月度复盘汇总分析器。只能使用 verified_chunks、verified_daily_assessments 和确定性统计/元数据；不得读取或重建未验证来源。\n\n${contract}` },
    { role:'user', content:JSON.stringify({ required_output:shape,
      current_strategy:strategyMemorySnapshot.strategy_text,
      strategy_memory_library:strategyMemoryForPrompt, evidence:stripHistoricalConditionFields(mergeEvidence) }) },
  ]
  const modelCall = await preparePeriodReviewModelCall('monthly_review_merge', resolved, messages,
    Math.max(4000, Math.ceil(JSON.stringify(shape).length / 2.5)), {
      nowUtcMs:Date.now(), businessDeadlineUtcMs:job._deadlineAtMs,
    })
  job._deadlineAtMs = modelCall.taskDeadlineUtcMs
  job._attemptDeadlineAtMs = modelCall.attemptSafetyDeadlineUtcMs
  job._modelBudget = modelCall.budget
  const tracker = await startPeriodReviewModelTask(job, resolved, endpoint,
    verifiedMonthlyMergeEvidence(evidence, checkpointResult), 'monthly_review_merge')
  await ensurePeriodReviewStrategyMemoryInjectionLog(job, strategyMemorySnapshot, 'monthly_review_merge', tracker.taskId)
  await tracker.persistBudget(modelCall.budget)
  const requestSignal = job._abortSignal && tracker.signal
    ? AbortSignal.any([job._abortSignal, tracker.signal]) : tracker.signal || job._abortSignal || null
  const output = await requestModel({ url:endpoint.url, apiKey:resolved.model.api_key_encrypted, provider:resolved.model.provider,
    model:resolved.model.model_name, temperature:Math.min(Number(resolved.model.temperature ?? 0.2), 0.3),
    maxTokens:modelCall.budget.selectedMaxOutputTokens, thinkingEnabled:resolved.model.thinking_enabled,
    reasoningEffort:resolved.model.reasoning_effort, protocol:endpoint.protocol,
    timeout:modelCall.requestTimeoutMs, deadlineAtMs:modelCall.attemptSafetyDeadlineUtcMs,
    followupValidUntilMs:modelCall.attemptSafetyDeadlineUtcMs, signal:requestSignal,
    messages, modelTaskBudget:modelCall.budget,
    usageContext:{ userId:job.user_id, profileId:resolved.model_profile_id, credentialSource:resolved.credential_source, usage:'review', strategyId:job.strategy_id },
    onProviderRequest:periodReviewProviderRequestCallback(job, tracker), onProviderUsage:event => tracker.onProviderUsage(event),
    onProviderActivity:event => tracker.onProviderActivity(event), onProviderQuiet:event => tracker.onProviderQuiet(event),
    onProgress:stage => setPeriodReviewJobStage(job, stage),
     validateObject:value => validateMonthlyReviewMergeContent(value, dailyCaseIds, approvedDailyCaseIds,
      mergeEvidence.conflict_groups, chanContext, mergeEvidence.strategy_conflicts, {
        strategyText:strategyMemorySnapshot.strategy_text,
        memoryText:strategyMemorySnapshot.library.content_text,
      }),
  })
  const content = validateMonthlyReviewMergeContent(output, dailyCaseIds, approvedDailyCaseIds,
    mergeEvidence.conflict_groups, chanContext, mergeEvidence.strategy_conflicts, {
      strategyText:strategyMemorySnapshot.strategy_text,
      memoryText:strategyMemorySnapshot.library.content_text,
    })
  await tracker.resultReady({ resultHash:sha256(JSON.stringify(content)) })
  return { content, resolved, tracker }
}

async function finishMonthlyReviewSuccess(job, generated) {
  await withTransaction(async run => {
    const [jobs] = await run('SELECT * FROM period_review_jobs WHERE id = ? FOR UPDATE', [job.id])
    if (!jobs[0] || jobs[0].status !== 'leased' || jobs[0].lease_token !== job.lease_token) throw new Error('monthly_review_job_lease_lost')
    await job._modelTracker?.assertOwnedTx(run)
    const [cases] = await run('SELECT * FROM period_review_cases WHERE id = ? FOR UPDATE', [job.period_case_id])
    if (!cases[0]) throw new Error('monthly_review_case_missing')
    const now = beijingNow()
    if (!cases[0].current_version_id) {
      const [versions] = await run('SELECT id, version_no FROM period_review_versions WHERE period_case_id = ? ORDER BY version_no DESC LIMIT 1 FOR UPDATE', [job.period_case_id])
      const parentVersionId = versions[0]?.id || null
      const nextVersionNo = Number(versions[0]?.version_no || 0) + 1
      const body = JSON.stringify(generated.content)
      const [insert] = await run(`INSERT INTO period_review_versions
        (period_case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
        VALUES (?, ?, ?, 'ai', NULL, ?, ?, 'AI monthly review draft', ?)`,
      [job.period_case_id, nextVersionNo, parentVersionId, body, sha256(body), now])
      await run(`UPDATE period_review_cases SET status = 'draft', current_version_id = ?, updated_at = ? WHERE id = ?`, [insert.insertId, now, job.period_case_id])
    }
    await run(`UPDATE period_review_jobs SET status = 'succeeded', progress_stage = 'succeeded', stage_updated_at = ?,
      model_profile_id = ?, credential_source = ?, last_error_code = NULL, next_attempt_at = NULL, completed_at = ?,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
    [now, generated.resolved.model_profile_id, generated.resolved.credential_source, now, now, job.id])
  })
}

async function finishMonthlyReviewFailure(job, error, modelTask = null) {
  const unknown = providerResultUnknown(job._modelTracker, modelTask)
  const exhausted = job.attempt_count >= Number(job.max_attempts)
  const retryAt = unknown || exhausted ? null : afterSeconds(Math.min(900, 60 * (2 ** Math.max(0, Number(job.attempt_count) - 1))))
  const jobStatus = unknown ? 'status_unknown' : exhausted ? 'failed' : 'queued'
  const errorCode = unknown ? 'provider_status_unknown' : safeError(error)
  await queryRun(`UPDATE period_review_jobs SET status = ?, last_error_code = ?, lease_token = NULL,
    lease_expires_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?`,
  [jobStatus, errorCode, retryAt, beijingNow(), job.id, job.lease_token])
  await queryRun(`UPDATE period_review_cases SET status = ?, updated_at = ? WHERE id = ? AND current_version_id IS NULL`,
  [unknown ? 'generating' : exhausted ? 'failed' : 'ready', beijingNow(), job.period_case_id])
}

export async function runMonthlyReviewWorkerOnce({ requestModel = requestJsonObject } = {}) {
  const job = await claimMonthlyReviewJob()
  if (!job) return { claimed: false }
  job._deadlineAtMs = modelTaskDeadlines('monthly_review_merge', { nowUtcMs:Date.now() }).taskDeadlineUtcMs
  const lease = startPeriodReviewLeaseHeartbeat(job)
  job._abortSignal = lease.signal
  await setPeriodReviewJobStage(job, 'preparing')
  try {
    if (!await isAiFeatureEnabled('review_generation_enabled', job.user_id)) return skipDisabledPeriodReviewJob(job)
    const evidence = parse(job.evidence_json, null)
    if (!evidence || !Array.isArray(evidence.sources) || !evidence.sources.length) throw new Error('monthly_review_evidence_invalid')
    // The snapshot is persisted on period_review_jobs, so every chunk, retry
    // and the final merge uses exactly the same strategy and memory version.
    await getReviewStrategyMemorySnapshot(job)
    const plan = buildMonthlyReviewChunks(evidence, { maxDays:8, evidenceHash:job.evidence_hash })
    const materialized = await ensureMonthlyReviewCheckpoints({ periodReviewJobId:Number(job.id), evidence,
      evidenceHash:plan.evidenceHash, maxDays:8 })
    const checkpoint = await claimMonthlyReviewCheckpoint({ periodReviewJobId:Number(job.id), evidenceHash:plan.evidenceHash,
      workerId:`period-review-monthly:${process.pid}` })
    if (checkpoint) {
      job._checkpoint = checkpoint
      const chunk = checkpointChunkFromRow(checkpoint, plan)
      const generated = await generateMonthlyReviewChunk(job, requestModel, checkpoint, chunk)
      lease.assertOwned()
      job._checkpointLease?.assertOwned()
      job._modelTracker?.assertOwned()
      await job._modelTracker.applying()
      lease.assertOwned()
      job._checkpointLease?.assertOwned()
      const persisted = await persistMonthlyReviewChunkSuccess(job, checkpoint, job._modelTracker, generated.content)
      job._chunkPersisted = true
      await releaseMonthlyReviewParentAfterChunk(job, checkpoint)
      await job._modelTracker.succeeded({ resultRef:`period_review_monthly_checkpoint:${checkpoint.id}`, resultHash:persisted.contentHash })
      await setPeriodReviewJobStage(job, 'monthly_chunk_succeeded', 'success', null,
        { checkpoint_id:Number(checkpoint.id), chunk_index:Number(chunk.chunk_index) })
      return { claimed:true, status:'chunk_succeeded', periodCaseId:Number(job.period_case_id),
        checkpointId:Number(checkpoint.id), chunkIndex:Number(chunk.chunk_index) }
    }

    const currentRows = Array.isArray(materialized.checkpoints) ? materialized.checkpoints : []
    const unknownCheckpoint = currentRows.find(row => String(row.status) === MONTHLY_REVIEW_CHECKPOINT_STATUSES.STATUS_UNKNOWN)
    if (unknownCheckpoint) {
      await releaseMonthlyReviewParentAfterChunk(job, unknownCheckpoint, { status:'status_unknown', errorCode:'provider_status_unknown' })
      await setPeriodReviewJobStage(job, 'status_unknown', 'error', 'provider_status_unknown')
      return { claimed:true, status:'status_unknown', periodCaseId:Number(job.period_case_id), checkpointId:Number(unknownCheckpoint.id) }
    }
    const allSucceeded = currentRows.length === plan.chunks.length
      && currentRows.every(row => String(row.status) === MONTHLY_REVIEW_CHECKPOINT_STATUSES.SUCCEEDED)
    if (!allSucceeded) {
      const nextCheckpoint = currentRows.filter(row => ['failed', 'leased'].includes(String(row.status)))
        .sort((left, right) => Number(left.next_attempt_at_utc_msc || left.lease_expires_at_utc_msc || 0)
          - Number(right.next_attempt_at_utc_msc || right.lease_expires_at_utc_msc || 0))[0]
      const nextAt = Number(nextCheckpoint?.next_attempt_at_utc_msc || nextCheckpoint?.lease_expires_at_utc_msc || 0)
      const terminalFailure = nextCheckpoint && String(nextCheckpoint.status) === 'failed'
        && Number(nextCheckpoint.attempt_count || 0) >= Number(nextCheckpoint.max_attempts || 3)
      await releaseMonthlyReviewParentAfterChunk(job, nextCheckpoint, {
        status:terminalFailure ? 'failed' : 'queued', nextAttemptAtUtcMs:terminalFailure ? null : nextAt > 0 ? nextAt : null,
        errorCode:nextCheckpoint?.error_code || null,
      })
      await setPeriodReviewJobStage(job, terminalFailure ? 'failed' : 'retry_wait', 'info', nextCheckpoint?.error_code || null)
      return { claimed:true, status:terminalFailure ? 'failed' : 'retry_wait', periodCaseId:Number(job.period_case_id),
        checkpointId:Number(nextCheckpoint?.id || 0) }
    }

    const verified = await loadSucceededMonthlyReviewCheckpoints({ periodReviewJobId:Number(job.id),
      evidenceHash:plan.evidenceHash, expectedPeriodCaseIds:plan.expectedPeriodCaseIds })
    assertMonthlyReviewCheckpointCoverage(verified.checkpoints, plan.expectedPeriodCaseIds)
    const generated = await generateMonthlyReviewMerge(job, requestModel, evidence, verified)
    lease.assertOwned()
    job._modelTracker?.assertOwned()
    await job._modelTracker?.applying()
    lease.assertOwned()
    job._modelTracker?.assertOwned()
    await finishMonthlyReviewSuccess(job, generated)
    await job._modelTracker?.succeeded({ resultRef:`period_review_case:${job.period_case_id}` })
    await setPeriodReviewJobStage(job, 'succeeded', 'success')
    return { claimed:true, status:'succeeded', periodCaseId:Number(job.period_case_id) }
  } catch (error) {
    if (job._checkpoint && job._chunkPersisted) {
      // The checkpoint content is already fenced and durable. A transient
      // failure while releasing the parent or finalizing the generic task
      // must not turn that completed chunk into a fresh provider request.
      try { await releaseMonthlyReviewParentAfterChunk(job, job._checkpoint) } catch (releaseError) {
        console.error(`[PeriodReview case=${job.period_case_id}] monthly chunk parent release:`, safeError(releaseError))
      }
      return { claimed:true, status:'chunk_succeeded', periodCaseId:Number(job.period_case_id),
        checkpointId:Number(job._checkpoint.id) }
    }
    if (job._checkpoint && !job._chunkPersisted) {
      if (!periodReviewProviderRequestStarted(job._modelTracker)) {
        try { await restoreUnstartedMonthlyCheckpointAttempt(job._checkpoint) } catch (restoreError) {
          console.error(`[PeriodReview case=${job.period_case_id}] monthly chunk attempt restore:`, safeError(restoreError))
        }
      }
      const chunkFailure = await failMonthlyReviewChunk(job, job._checkpoint, job._modelTracker, error)
      await setPeriodReviewJobStage(job, chunkFailure.status === 'status_unknown' ? 'status_unknown'
        : chunkFailure.status === 'failed' ? 'failed' : 'retry_wait', 'error', chunkFailure.error)
      return { claimed:true, status:chunkFailure.status, periodCaseId:Number(job.period_case_id),
        checkpointId:Number(job._checkpoint.id), error:chunkFailure.error }
    }
    let failure = error
    let modelTask = null
    try {
      modelTask = await job._modelTracker?.failed(error, job.attempt_count >= Number(job.max_attempts))
    } catch (trackerError) {
      failure = trackerError
      console.error(`[PeriodReview case=${job.period_case_id}] model task failure:`, safeError(trackerError))
    }
    await finishMonthlyReviewFailure(job, failure, modelTask)
    const unknown = providerResultUnknown(job._modelTracker, modelTask)
    await setPeriodReviewJobStage(job, unknown ? 'status_unknown' : job.attempt_count >= Number(job.max_attempts) ? 'failed' : 'retry_wait', 'error', safeError(error),
      unknown || job.attempt_count >= Number(job.max_attempts) ? null : { retry_delay_seconds: Math.min(900, 60 * (2 ** Math.max(0, Number(job.attempt_count) - 1))) })
    return { claimed: true, status: unknown ? 'status_unknown' : 'failed', periodCaseId: Number(job.period_case_id), error: safeError(failure) }
  } finally {
    try { await job._modelTracker?.stop() } catch (trackerError) {
      console.error(`[PeriodReview case=${job.period_case_id}] model task stop:`, safeError(trackerError))
    }
    try { await job._checkpointLease?.stop() } catch (checkpointError) {
      console.error(`[PeriodReview case=${job.period_case_id}] monthly checkpoint lease stop:`, safeError(checkpointError))
    }
    await lease.stop()
  }
}

function periodReviewContentForCase(reviewCase, content) {
  const evidence = parse(reviewCase.evidence_json, {})
  if (reviewCase.period_type === 'daily') {
    const outcomeIds = (evidence.sources || []).map(item => Number(item.outcome_id))
    return validateDailyReviewContent(content, outcomeIds, frozenDailyChanContext(evidence))
  }
  if (reviewCase.period_type === 'monthly') {
    const dailyCaseIds = (evidence.sources || []).map(item => Number(item.period_case_id))
    const approvedDailyCaseIds = (evidence.sources || []).filter(item => item.review_status === 'approved').map(item => Number(item.period_case_id))
    return validateMonthlyReviewContent(content, dailyCaseIds, approvedDailyCaseIds, monthlyChanContext(evidence))
  }
  throw new Error('invalid_review_period_type')
}

export async function listPeriodReviewCases(actor, { periodType = null, status = null, limit = 50, offset = 0, includePageInfo = false } = {}) {
  const access = periodReviewAccessScope(actor)
  const params = [access.userId, ...access.params]
  let where = `WHERE ${access.sql} AND cases.status <> 'superseded'`
  if (periodType) {
    if (!['daily', 'monthly'].includes(periodType)) throw new Error('invalid_review_period_type')
    where += ' AND cases.period_type = ?'; params.push(periodType)
  }
  if (status === 'pending') {
    where += ` AND cases.status IN ('evidence_pending','incomplete','ready','generating','failed')`
  } else if (status) {
    if (!['draft', 'approved', 'needs_revision'].includes(status)) throw new Error('invalid_review_status')
    if (status === 'draft') {
      where += ` AND (cases.status = 'draft'
        OR (cases.current_version_id IS NOT NULL
          AND cases.status IN ('evidence_pending','incomplete','ready','generating','failed')))`
    } else {
      where += ' AND cases.status = ?'; params.push(status)
    }
  }
  const safeLimit = Math.min(100, Math.max(1, Number(limit || 50)))
  const safeOffset = Math.max(0, Number(offset || 0))
  const pageLimit = safeLimit + (includePageInfo ? 1 : 0)
  const fetchLimit = Math.min(500, Math.max(pageLimit, (safeOffset + pageLimit) * 4))
  params.push(fetchLimit, 0)
  const rows = await queryAll(`SELECT cases.id, cases.user_id, cases.period_type, cases.period_key, cases.trading_account_id,
      cases.strategy_id, cases.strategy_version, cases.strategy_scope, cases.timezone_offset_minutes,
      cases.status, cases.evidence_status, cases.evidence_reason, cases.source_count,
      cases.current_version_id, cases.approved_version_id, cases.evidence_json, cases.created_at, cases.updated_at,
      COALESCE(strategies.title, CONCAT('策略 #', cases.strategy_id)) AS strategy_title,
      jobs.status AS job_status, jobs.progress_stage, jobs.stage_updated_at, jobs.attempt_count, jobs.max_attempts,
      jobs.last_error_code, jobs.next_attempt_at,
      derivation.status AS derivation_status, derivation.last_error_code AS derivation_error_code,
      ${strategyMemoryStateSelectSql()},
      CASE WHEN cases.current_version_id IS NOT NULL AND (seen.last_seen_version_id IS NULL OR seen.last_seen_version_id <> cases.current_version_id) THEN 1 ELSE 0 END AS is_unread
    FROM period_review_cases cases
    LEFT JOIN auto_prompt_types strategies ON strategies.id = cases.strategy_id
    LEFT JOIN period_review_jobs jobs ON jobs.period_case_id = cases.id AND jobs.job_slot = 0
    LEFT JOIN period_review_derivation_jobs derivation ON derivation.period_case_id = cases.id
      AND derivation.period_version_id = cases.approved_version_id
    LEFT JOIN strategy_memory_libraries memory_library ON memory_library.strategy_id = cases.strategy_id
    LEFT JOIN period_review_user_states seen ON seen.period_case_id = cases.id AND seen.user_id = ? ${where}
    ORDER BY cases.created_at DESC, cases.id DESC LIMIT ? OFFSET ?`, params)
  const logicalRows = []
  const logicalIndexes = new Map()
  for (const rawRow of rows) {
    const row = normalizePeriodReviewState(rawRow)
    const key = [row.user_id, row.period_type, row.period_key, row.trading_account_id || 0, row.strategy_id].join(':')
    if (!logicalIndexes.has(key)) {
      logicalIndexes.set(key, logicalRows.length); logicalRows.push(row); continue
    }
    const index = logicalIndexes.get(key)
    if (row.status === 'approved' && logicalRows[index].status !== 'approved') logicalRows[index] = row
  }
  const pageRows = logicalRows.slice(safeOffset, safeOffset + pageLimit)
  const cases = pageRows.slice(0, safeLimit).map(row => {
    const evidence = parse(row.evidence_json, {})
    return { ...row, evidence_json: undefined, statistics: evidence.statistics || {}, source_quality: evidence.source_quality || null }
  })
  if (!includePageInfo) return cases
  return {
    cases,
    pagination: {
      limit:safeLimit,
      offset:safeOffset,
      next_offset:safeOffset + cases.length,
      has_more:pageRows.length > safeLimit,
    },
  }
}

export async function getPeriodReviewCase(periodCaseId, actor) {
  const access = periodReviewAccessScope(actor)
  const reviewCase = await queryOne(`SELECT cases.*,
      COALESCE(strategies.title, CONCAT('策略 #', cases.strategy_id)) AS strategy_title,
      jobs.id AS job_id, jobs.status AS job_status, jobs.progress_stage, jobs.stage_updated_at,
      jobs.attempt_count, jobs.max_attempts, jobs.last_error_code, jobs.next_attempt_at, jobs.completed_at,
      derivation.id AS derivation_job_id, derivation.status AS derivation_status,
      derivation.attempt_count AS derivation_attempt_count, derivation.max_attempts AS derivation_max_attempts,
      derivation.last_error_code AS derivation_error_code, derivation.completed_at AS derivation_completed_at,
      ${strategyMemoryStateSelectSql()},
      CASE WHEN cases.current_version_id IS NOT NULL AND (seen.last_seen_version_id IS NULL OR seen.last_seen_version_id <> cases.current_version_id) THEN 1 ELSE 0 END AS is_unread
    FROM period_review_cases cases
    LEFT JOIN auto_prompt_types strategies ON strategies.id = cases.strategy_id
    LEFT JOIN period_review_jobs jobs ON jobs.period_case_id = cases.id AND jobs.job_slot = 0
    LEFT JOIN period_review_derivation_jobs derivation ON derivation.period_case_id = cases.id
      AND derivation.period_version_id = cases.approved_version_id
    LEFT JOIN strategy_memory_libraries memory_library ON memory_library.strategy_id = cases.strategy_id
    LEFT JOIN period_review_user_states seen ON seen.period_case_id = cases.id AND seen.user_id = ?
    WHERE cases.id = ? AND ${access.sql}`, [access.userId, periodCaseId, ...access.params])
  if (!reviewCase) throw new Error('period_review_not_found')
  const [versions, sources, events] = await Promise.all([
    queryAll(`SELECT id, version_no, parent_version_id, author_type, author_user_id, content_json,
      content_hash, change_note, created_at FROM period_review_versions WHERE period_case_id = ? ORDER BY version_no`, [periodCaseId]),
    queryAll(`SELECT id, outcome_id, trade_review_case_id, source_period_case_id, source_hash, created_at
      FROM period_review_sources WHERE period_case_id = ? ORDER BY id`, [periodCaseId]),
    queryAll(`SELECT id, attempt_no, stage, event_status, message_code, metadata_json, created_at
      FROM period_review_job_events WHERE period_case_id = ? ORDER BY id DESC LIMIT 30`, [periodCaseId]),
  ])
  const normalizedReviewCase = normalizePeriodReviewState(reviewCase)
  return { ...normalizedReviewCase, evidence: parse(normalizedReviewCase.evidence_json, null), evidence_json: undefined, sources,
    job_events: events.map(row => ({ ...row, metadata: parse(row.metadata_json, null), metadata_json: undefined })),
    versions: versions.map(row => ({ ...row, content: parse(row.content_json, {}), content_json: undefined })) }
}

export async function getPeriodReviewSummary(actor) {
  const access = periodReviewAccessScope(actor)
  const rows = await queryAll(`SELECT cases.id, cases.user_id, cases.period_type, cases.period_key, cases.trading_account_id,
      cases.strategy_id, cases.status, cases.current_version_id,
      cases.approved_version_id, seen.last_seen_version_id, jobs.status AS job_status,
      derivation.status AS derivation_status, ${strategyMemoryStateSelectSql()}
    FROM period_review_cases cases
    LEFT JOIN period_review_user_states seen ON seen.period_case_id = cases.id AND seen.user_id = ?
    LEFT JOIN period_review_jobs jobs ON jobs.period_case_id = cases.id AND jobs.job_slot = 0
    LEFT JOIN period_review_derivation_jobs derivation ON derivation.period_case_id = cases.id
      AND derivation.period_version_id = cases.approved_version_id
    LEFT JOIN strategy_memory_libraries memory_library ON memory_library.strategy_id = cases.strategy_id
    WHERE ${access.sql} AND cases.status <> 'superseded'`, [access.userId, ...access.params])
  const summary = { attention:0, unread:0, pending_confirmation:0, generating:0, failed:0,
    total:0, daily_total:0, monthly_total:0,
    daily_attention:0, monthly_attention:0, daily_pending:0, monthly_pending:0,
    derivation_pending:0, derivation_failed:0 }
  const logical = new Map()
  for (const rawRow of rows) {
    const row = normalizePeriodReviewState(rawRow)
    const key = [row.user_id, row.period_type, row.period_key, row.trading_account_id || 0, row.strategy_id].join(':')
    const current = logical.get(key)
    if (!current || (row.status === 'approved' && current.status !== 'approved')
      || (row.status === current.status && Number(row.id) > Number(current.id))) logical.set(key, row)
  }
  for (const row of logical.values()) {
    summary.total += 1
    summary[row.period_type === 'monthly' ? 'monthly_total' : 'daily_total'] += 1
    const unread = row.current_version_id != null && Number(row.last_seen_version_id || 0) !== Number(row.current_version_id)
    const pending = ['draft', 'edited'].includes(row.status)
    const failed = row.status === 'failed' || row.job_status === 'failed'
    const derivationPending = ['queued','leased','paused'].includes(row.derivation_status)
    const derivationFailed = row.derivation_status === 'failed'
    const attention = unread || pending || row.status === 'needs_revision' || failed || derivationFailed
    if (unread) summary.unread += 1
    if (pending) summary.pending_confirmation += 1
    if (row.status === 'generating' || row.job_status === 'leased') summary.generating += 1
    if (failed) summary.failed += 1
    if (derivationPending) summary.derivation_pending += 1
    if (derivationFailed) summary.derivation_failed += 1
    if (attention) {
      summary.attention += 1
      summary[row.period_type === 'monthly' ? 'monthly_attention' : 'daily_attention'] += 1
    }
    if (pending) summary[row.period_type === 'monthly' ? 'monthly_pending' : 'daily_pending'] += 1
  }
  return summary
}

export async function markPeriodReviewRead(periodCaseId, actor, versionId) {
  const access = periodReviewAccessScope(actor)
  const reviewCase = await queryOne(`SELECT cases.current_version_id FROM period_review_cases cases
    WHERE cases.id = ? AND ${access.sql}`, [periodCaseId, ...access.params])
  if (!reviewCase) throw new Error('period_review_not_found')
  if (!reviewCase.current_version_id || Number(reviewCase.current_version_id) !== Number(versionId)) throw new Error('period_review_version_conflict')
  const now = beijingNow()
  await queryRun(`INSERT INTO period_review_user_states
    (period_case_id, user_id, last_seen_version_id, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE last_seen_version_id = VALUES(last_seen_version_id), last_seen_at = VALUES(last_seen_at), updated_at = VALUES(updated_at)`,
  [periodCaseId, access.userId, versionId, now, now, now, now])
  return { read: true, versionId: Number(versionId) }
}

export async function getPeriodReviewJobStatus(periodCaseId, actor) {
  const access = periodReviewAccessScope(actor)
  const status = await queryOne(`SELECT cases.id, cases.period_type, cases.status, cases.current_version_id,
      cases.approved_version_id,
      jobs.id AS job_id, jobs.status AS job_status, jobs.progress_stage, jobs.stage_updated_at,
      jobs.attempt_count, jobs.max_attempts, jobs.last_error_code, jobs.next_attempt_at, jobs.completed_at,
      derivation.status AS derivation_status, derivation.attempt_count AS derivation_attempt_count,
      derivation.max_attempts AS derivation_max_attempts, derivation.last_error_code AS derivation_error_code,
      derivation.completed_at AS derivation_completed_at, ${strategyMemoryStateSelectSql()}
    FROM period_review_cases cases
    LEFT JOIN period_review_jobs jobs ON jobs.period_case_id = cases.id AND jobs.job_slot = 0
    LEFT JOIN period_review_derivation_jobs derivation ON derivation.period_case_id = cases.id
      AND derivation.period_version_id = cases.approved_version_id
    LEFT JOIN strategy_memory_libraries memory_library ON memory_library.strategy_id = cases.strategy_id
    WHERE cases.id = ? AND ${access.sql}`, [periodCaseId, ...access.params])
  if (!status) throw new Error('period_review_not_found')
  const events = await queryAll(`SELECT id, attempt_no, stage, event_status, message_code, metadata_json, created_at
    FROM period_review_job_events WHERE period_case_id = ? ORDER BY id DESC LIMIT 12`, [periodCaseId])
  return { ...normalizePeriodReviewState(status), job_events:events.map(row => ({ ...row, metadata:parse(row.metadata_json, null), metadata_json:undefined })) }
}

export async function editPeriodReviewCase({ periodCaseId, actor, content, expectedVersionId, changeNote = null }) {
  const access = periodReviewAccessScope(actor)
  return withTransaction(async run => {
    const [rows] = await run(`SELECT cases.* FROM period_review_cases cases
      WHERE cases.id = ? AND ${access.sql} AND cases.status <> 'superseded' FOR UPDATE`, [periodCaseId, ...access.params])
    const reviewCase = rows[0]
    if (!reviewCase) throw new Error('period_review_not_found')
    if (!reviewCase.current_version_id || Number(reviewCase.current_version_id) !== Number(expectedVersionId)) throw new Error('period_review_version_conflict')
    const normalized = periodReviewContentForCase(reviewCase, content)
    const [versions] = await run('SELECT COALESCE(MAX(version_no), 0) AS max_version FROM period_review_versions WHERE period_case_id = ? FOR UPDATE', [periodCaseId])
    const now = beijingNow()
    const body = JSON.stringify(normalized)
    const [insert] = await run(`INSERT INTO period_review_versions
      (period_case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
      VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)`, [periodCaseId, Number(versions[0].max_version) + 1,
      reviewCase.current_version_id, access.userId, body, sha256(body), String(changeNote || '').slice(0, 500) || null, now])
    await run(`UPDATE period_review_cases SET status = 'edited', current_version_id = ?, approved_version_id = NULL,
      updated_at = ? WHERE id = ?`, [insert.insertId, now, periodCaseId])
    return { versionId: Number(insert.insertId), versionNo: Number(versions[0].max_version) + 1 }
  })
}

export async function confirmPeriodReviewCase({ periodCaseId, actor, versionId, action }) {
  if (!['approve', 'needs_revision', 'defer'].includes(action)) throw new Error('invalid_review_action')
  const access = periodReviewAccessScope(actor)
  return withTransaction(async run => {
    const [rows] = await run(`SELECT cases.* FROM period_review_cases cases
      WHERE cases.id = ? AND ${access.sql} AND cases.status <> 'superseded' FOR UPDATE`, [periodCaseId, ...access.params])
    const reviewCase = rows[0]
    if (!reviewCase) throw new Error('period_review_not_found')
    if (!reviewCase.current_version_id || Number(reviewCase.current_version_id) !== Number(versionId)) throw new Error('period_review_version_conflict')
    const [versions] = await run('SELECT id FROM period_review_versions WHERE id = ? AND period_case_id = ?', [versionId, periodCaseId])
    if (!versions[0]) throw new Error('period_review_version_not_found')
    const status = action === 'approve' ? 'approved' : action === 'defer' ? 'deferred' : 'needs_revision'
    const now = beijingNow()
    await run(`UPDATE period_review_cases SET status = ?, approved_version_id = ?, updated_at = ? WHERE id = ?`,
    [status, action === 'approve' ? versionId : null, now, periodCaseId])
    let derivationJobId = null
    if (action === 'approve') {
      const targetType = 'strategy_memory_library'
      await run(`INSERT IGNORE INTO period_review_derivation_jobs
        (period_case_id, period_version_id, user_id, target_type, status, attempt_count, max_attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', 0, 5, ?, ?)`, [periodCaseId, versionId, access.userId, targetType, now, now])
      const [jobs] = await run(`SELECT id FROM period_review_derivation_jobs
        WHERE period_case_id = ? AND period_version_id = ? AND target_type = ? LIMIT 1`, [periodCaseId, versionId, targetType])
      derivationJobId = Number(jobs[0]?.id || 0) || null
    }
    return { status, periodType: reviewCase.period_type, strategyScope: reviewCase.strategy_scope,
      approvedVersionId: action === 'approve' ? Number(versionId) : null,
      derivationJobId, derivationStatus:action === 'approve' ? 'queued' : null }
  })
}

async function claimPeriodReviewDerivationJob() {
  return withTransaction(async run => {
    const now = beijingNow()
    const [rows] = await run(`SELECT jobs.*, cases.period_type, cases.strategy_scope
      FROM period_review_derivation_jobs jobs
      JOIN period_review_cases cases ON cases.id = jobs.period_case_id
      WHERE ((jobs.status = 'queued' AND (jobs.next_attempt_at IS NULL OR jobs.next_attempt_at <= ?))
        OR (jobs.status = 'leased' AND jobs.lease_expires_at < ?))
        AND jobs.attempt_count < jobs.max_attempts AND cases.strategy_compatibility_hash IS NOT NULL
      ORDER BY jobs.updated_at, jobs.id LIMIT 1 FOR UPDATE`, [now, now])
    if (!rows[0]) return null
    const token = crypto.randomUUID()
    await run(`UPDATE period_review_derivation_jobs SET status = 'leased', lease_token = ?, lease_expires_at = ?,
      next_attempt_at = NULL, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`,
    [token, afterSeconds(180), now, rows[0].id])
    return { ...rows[0], lease_token:token, attempt_count:Number(rows[0].attempt_count || 0) + 1 }
  })
}

async function pausePeriodReviewDerivationJob(job, reason) {
  await queryRun(`UPDATE period_review_derivation_jobs SET status = 'paused', last_error_code = ?,
    lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
    WHERE id = ? AND lease_token = ?`, [reason, beijingNow(), job.id, job.lease_token])
  return { claimed:true, status:'paused', jobId:Number(job.id), reason }
}

function memoryMarkdownText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g, '')
    .trim()
}

function reviewTextForMatching(value) {
  // Lesson/update identity is deliberately only trim-based.  Do not make
  // line-ending or control-character normalization silently turn two distinct
  // approved texts into one memory entry.
  return String(value ?? '').trim()
}

function reviewSourceIds(approved, type) {
  const evidence = parse(approved?.evidence_json, {}) || {}
  const refs = []
  for (const source of Array.isArray(evidence.sources) ? evidence.sources : []) {
    const value = type === 'daily' ? Number(source?.outcome_id) : Number(source?.period_case_id)
    if (!Number.isSafeInteger(value) || value <= 0) continue
    const ref = type === 'daily' ? `outcome:${value}` : `period_review_case:${value}`
    if (!refs.includes(ref)) refs.push(ref)
  }
  return refs
}

export function deterministicReviewMemoryMarkdown(entries) {
  const lines = []
  for (const entry of entries || []) {
    const text = memoryMarkdownText(entry.text || entry.lesson)
    if (!text) continue
    lines.push(`- ${text}`)
    const antiPattern = memoryMarkdownText(entry.anti_pattern)
    const risk = memoryMarkdownText(entry.risk || entry.risk_observation)
    if (antiPattern) lines.push(`  - 反模式：${antiPattern}`)
    if (risk) lines.push(`  - 风险：${risk}`)
  }
  return lines.join('\n')
}

function derivationMemoryEntries(approved, content) {
  const periodType = String(approved?.period_type || '')
  const evidence = parse(approved?.evidence_json, {}) || {}
  const currentRefs = [`period_review_case:${Number(approved.id)}`, `period_review_version:${Number(approved.approved_version_id)}`]
  const canonicalRefs = reviewSourceIds(approved, periodType)
  if (periodType === 'daily') {
    const chanContext = frozenDailyChanContext(evidence)
    // `daily_lessons` is the user-visible, approved collection.  Model
    // memory_updates may carry useful metadata for a matching lesson, but it
    // is not allowed to add hidden/combined lessons to the persisted library.
    const lessons = (Array.isArray(content.daily_lessons) ? content.daily_lessons : [])
      .map(text => reviewTextForMatching(text)).filter(Boolean)
    const updatesByText = new Map()
    for (const item of Array.isArray(content.memory_updates) ? content.memory_updates : []) {
      const text = reviewTextForMatching(item?.text || item?.lesson)
      if (text && !updatesByText.has(text)) updatesByText.set(text, item)
    }
    return lessons.map(lesson => {
      const matched = updatesByText.get(lesson)
      const category = [matched?.category, matched?.memory_category]
        .find(value => MEMORY_CATEGORIES.has(value)) || 'general'
      if (category === 'chan_structure' && chanContext.mode !== 'enabled_complete') {
        throw new Error('strategy_memory_chan_evidence_invalid')
      }
      return { ...(matched || {}), text:lesson, category, source_refs:[...canonicalRefs, ...currentRefs] }
    })
  }
  if (periodType === 'monthly') {
    const candidates = Array.isArray(content.memory_candidates) ? content.memory_candidates : null
    if (candidates) {
      const knownApproved = new Set((Array.isArray(evidence.sources) ? evidence.sources : [])
        .filter(source => source.review_status === 'approved')
        .map(source => Number(source.period_case_id)).filter(id => Number.isSafeInteger(id) && id > 0))
      const chanContext = monthlyChanContext(evidence)
      return candidates.map(candidate => {
        const support = [...new Set((candidate.supporting_period_case_ids || []).map(Number))]
        if (support.length < 2 || support.some(id => !knownApproved.has(id))) throw new Error('invalid_monthly_memory_candidate')
        if (candidate.memory_category === 'chan_structure' && chanContext.mode !== 'enabled_complete') {
          throw new Error('strategy_memory_chan_evidence_invalid')
        }
        return { ...candidate, text:candidate.lesson, category:candidate.memory_category || 'general',
          supporting_period_case_ids:support, source_refs:[...support.map(id => `period_review_case:${id}`), ...currentRefs] }
      })
    }
    // Approved historical monthly versions used memory_updates. Keep that
    // compatibility path, but never copy model refs or old applicability data.
    if (Array.isArray(content.memory_updates)) {
      return content.memory_updates.map(item => ({ ...item,
        category:item.category || item.memory_category || 'general', source_refs:[...canonicalRefs, ...currentRefs] }))
    }
  }
  return []
}

function derivationMemoryConflictExperiences(approved, content) {
  const periodType = String(approved?.period_type || '')
  if (periodType === 'daily') {
    // Conflict evidence validates approved model excerpts, so retain the
    // original memory_updates text as candidates even when an update is not a
    // user-visible daily lesson.  This is intentionally separate from the
    // entries that are actually written to the unified memory library.
    const values = []
    for (const item of Array.isArray(content.memory_updates) ? content.memory_updates : []) {
      for (const key of ['text', 'lesson', 'anti_pattern']) {
        const text = memoryMarkdownText(item?.[key])
        if (text) values.push(text)
      }
    }
    for (const lesson of Array.isArray(content.daily_lessons) ? content.daily_lessons : []) {
      const text = memoryMarkdownText(lesson)
      if (text) values.push(text)
    }
    return [...new Set(values)]
  }
  return derivationMemoryEntries(approved, content)
    .flatMap(item => [item.text, item.lesson, item.anti_pattern])
    .filter(Boolean)
}

// Kept deliberately test-only: production callers use the derivation worker
// above, while focused tests can verify the server-owned daily lesson mapping
// without running a database-backed worker cycle.
export function __testDeriveDailyReviewMemoryEntries(approved, content) {
  return derivationMemoryEntries({ ...(approved || {}), period_type:'daily' }, content || {})
}

export function __testDeriveDailyReviewConflictExperiences(approved, content) {
  return derivationMemoryConflictExperiences({ ...(approved || {}), period_type:'daily' }, content || {})
}

export function periodReviewConflictSnapshotsRequired(content) {
  return Array.isArray(content?.strategy_conflicts) && content.strategy_conflicts.length > 0
}

export async function resumePeriodReviewDerivationJobs(limit = 100) {
  const rows = await queryAll(`SELECT jobs.id, jobs.user_id, jobs.target_type, cases.period_type
    FROM period_review_derivation_jobs jobs JOIN period_review_cases cases ON cases.id = jobs.period_case_id
    WHERE jobs.status = 'paused' AND cases.strategy_compatibility_hash IS NOT NULL
    ORDER BY jobs.updated_at LIMIT ?`, [Math.min(500, Math.max(1, Number(limit || 100)))])
  let resumed = 0
  for (const row of rows) {
    const enabled = row.target_type === 'strategy_memory_library'
    if (!enabled) continue
    const result = await queryRun(`UPDATE period_review_derivation_jobs SET status = 'queued', attempt_count = 0,
      last_error_code = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND status = 'paused'`, [beijingNow(), row.id])
    resumed += Number(result.changes || result.affectedRows || 0) > 0 ? 1 : 0
  }
  return resumed
}

export async function runPeriodReviewDerivationOnce() {
  const job = await claimPeriodReviewDerivationJob()
  if (!job) return { claimed:false }
  try {
    if (job.target_type !== 'strategy_memory_library') {
      throw new Error('invalid_period_review_derivation_target')
    }
    const approved = await queryOne(`SELECT cases.*, versions.content_json AS approved_content_json,
        versions.id AS approved_version_id, apt.scope AS strategy_scope, apt.owner_user_id,
        generation_job.memory_library_version_no, generation_job.memory_library_content_hash,
        generation_job.memory_library_snapshot_text, generation_job.memory_strategy_snapshot_text
      FROM period_review_cases cases
      JOIN period_review_versions versions ON versions.id = cases.approved_version_id
      JOIN auto_prompt_types apt ON apt.id = cases.strategy_id AND apt.deleted_at IS NULL
      LEFT JOIN period_review_jobs generation_job ON generation_job.id = (
        SELECT MAX(candidate_job.id) FROM period_review_jobs candidate_job
        WHERE candidate_job.period_case_id = cases.id AND candidate_job.status = 'succeeded'
      )
      WHERE cases.id = ? AND cases.status = 'approved' AND cases.approved_version_id IS NOT NULL`, [job.period_case_id])
    if (!approved) throw new Error('approved_period_review_required')
    const content = parse(approved.approved_content_json, {}) || {}
    const updateKind = approved.period_type === 'monthly' ? 'monthly_review' : 'daily_review'
    const entries = derivationMemoryEntries(approved, content)
    const updateText = deterministicReviewMemoryMarkdown(entries)
    let memoryUpdateResult = null
    if (updateText) {
      memoryUpdateResult = await enqueueApprovedStrategyMemoryUpdate({
        strategyId:approved.strategy_id, actor:{ serverOwned:true, userId:job.user_id },
        serverOwned:true, strategyScope:approved.strategy_scope, strategyOwnerUserId:Number(approved.owner_user_id || 0),
        validatedReviewCase:{ ...approved, strategy_id:approved.strategy_id, scope:approved.strategy_scope,
          owner_user_id:Number(approved.owner_user_id || 0), status:'approved' },
        approved:true, review_status:'approved', period_review_version_id:approved.approved_version_id,
        period_review_case_id:approved.id, update_kind:updateKind, content_text:updateText,
        source_refs:[...new Set(entries.flatMap(entry => entry.source_refs || []))],
      })
    }
    const conflicts = Array.isArray(content.strategy_conflicts) ? content.strategy_conflicts : []
    const frozenMemory = approved.memory_library_snapshot_text
    const frozenStrategy = approved.memory_strategy_snapshot_text
    // Snapshots are needed only to verify an actual conflict excerpt. Older
    // approved reviews can legitimately have no frozen conflict context; they
    // must still be able to append their deterministic memory lessons.
    if (conflicts.length > 0 && (frozenMemory == null || frozenStrategy == null)) {
      throw new Error('strategy_memory_conflict_frozen_snapshot_missing')
    }
    const proposedExperiences = derivationMemoryConflictExperiences(approved, content)
    for (const conflict of conflicts) {
      const canonicalConflictRefs = [...new Set([
        ...reviewSourceIds(approved, approved.period_type),
        `period_review_case:${Number(approved.id)}`,
        `period_review_version:${Number(approved.approved_version_id)}`,
      ])]
      await recordStrategyMemoryConflictEvidence({
        strategyId:approved.strategy_id, actor:{ serverOwned:true, userId:job.user_id },
        serverOwned:true, strategyScope:approved.strategy_scope, strategyOwnerUserId:Number(approved.owner_user_id || 0),
        validatedReviewCase:{ ...approved, strategy_id:approved.strategy_id, scope:approved.strategy_scope,
          owner_user_id:Number(approved.owner_user_id || 0), status:'approved' },
        approved:true, review_status:'approved', period_review_version_id:approved.approved_version_id,
        period_review_case_id:approved.id, ...conflict, source_refs:canonicalConflictRefs,
        frozen_strategy_text:frozenStrategy, frozen_memory_text:frozenMemory,
        proposed_experiences:proposedExperiences,
      })
    }
    if (memoryUpdateResult?.merged) {
      try {
        const consistency = await queueStrategyMemoryConsistencyCheck({
          strategyId:Number(approved.strategy_id),
          strategyVersion:Number(approved.strategy_version || 0) || undefined,
          libraryVersionNo:Number(memoryUpdateResult.library?.version_no || 0) || undefined,
          triggerType:'review_merge',
        })
        if (consistency.created) requestStrategyMemoryConsistencyCycle()
      } catch (error) {
        console.error('[StrategyMemory] consistency queue after review merge:', error.message)
      }
    }
    const now = beijingNow()
    await queryRun(`UPDATE period_review_derivation_jobs SET status = 'succeeded', last_error_code = NULL,
      lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND lease_token = ?`, [now, now, job.id, job.lease_token])
    return { claimed:true, status:'succeeded', jobId:Number(job.id), periodCaseId:Number(job.period_case_id) }
  } catch (error) {
    const exhausted = Number(job.attempt_count) >= Number(job.max_attempts)
    const retryAt = exhausted ? null : afterSeconds(Math.min(3600, 60 * (2 ** Math.max(0, Number(job.attempt_count) - 1))))
    await queryRun(`UPDATE period_review_derivation_jobs SET status = ?, last_error_code = ?,
      lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND lease_token = ?`, [exhausted ? 'failed' : 'queued', safeError(error), retryAt, beijingNow(), job.id, job.lease_token])
    return { claimed:true, status:exhausted ? 'failed' : 'retry_wait', jobId:Number(job.id), error:safeError(error) }
  }
}

export async function retryPeriodReviewDerivation(periodCaseId, actor) {
  const access = periodReviewAccessScope(actor, 'period_review_cases')
  const result = await withTransaction(async run => {
    const [cases] = await run(`SELECT id, approved_version_id FROM period_review_cases
      WHERE id = ? AND ${access.sql} FOR UPDATE`, [periodCaseId, ...access.params])
    const reviewCase = cases[0]
    if (!reviewCase || !reviewCase.approved_version_id) throw new Error('approved_period_review_required')
    const [jobs] = await run(`SELECT * FROM period_review_derivation_jobs
      WHERE period_case_id = ? AND period_version_id = ? LIMIT 1 FOR UPDATE`, [periodCaseId, reviewCase.approved_version_id])
    if (!jobs[0]) throw new Error('period_review_derivation_not_found')
    if (jobs[0].status === 'succeeded') return { queued:false, status:'succeeded', jobId:Number(jobs[0].id) }
    const now = beijingNow()
    await run(`UPDATE period_review_derivation_jobs SET status = 'queued', attempt_count = 0,
      last_error_code = NULL, next_attempt_at = NULL, lease_token = NULL, lease_expires_at = NULL,
      completed_at = NULL, updated_at = ? WHERE id = ?`, [now, jobs[0].id])
    return { queued:true, status:'queued', jobId:Number(jobs[0].id) }
  })
  if (result.queued) requestPeriodReviewCycle()
  return result
}

export async function retryPeriodReviewCase(periodCaseId, actor) {
  const access = periodReviewAccessScope(actor)
  const result = await withTransaction(async run => {
    const [rows] = await run(`SELECT cases.* FROM period_review_cases cases
      WHERE cases.id = ? AND ${access.sql} AND cases.status <> 'superseded' FOR UPDATE`, [periodCaseId, ...access.params])
    const reviewCase = rows[0]
    if (!reviewCase) throw new Error('period_review_not_found')
    if (reviewCase.evidence_status !== 'complete') throw new Error('period_review_evidence_incomplete')
    if (reviewCase.current_version_id) throw new Error('period_review_already_generated')
    const jobType = reviewCase.period_type === 'daily' ? 'daily_review' : reviewCase.period_type === 'monthly' ? 'monthly_review' : null
    if (!jobType) throw new Error('invalid_review_period_type')
    const [jobs] = await run('SELECT * FROM period_review_jobs WHERE period_case_id = ? AND job_type = ? AND job_slot = 0 LIMIT 1 FOR UPDATE', [periodCaseId, jobType])
    const now = beijingNow()
    let jobId = Number(jobs[0]?.id || 0)
    if (jobs[0]) {
      if (jobType === 'monthly_review') {
        const [checkpoints] = await run(`SELECT * FROM period_review_monthly_checkpoints
          WHERE period_review_job_id = ? ORDER BY evidence_hash, chunk_index FOR UPDATE`, [jobs[0].id])
        for (const checkpoint of checkpoints || []) {
          const checkpointStatus = String(checkpoint.status || '')
          if (checkpointStatus === MONTHLY_REVIEW_CHECKPOINT_STATUSES.STATUS_UNKNOWN
            || checkpointStatus === MONTHLY_REVIEW_CHECKPOINT_STATUSES.LEASED) {
            throw new Error('period_review_chunk_checkpoint_unresolved')
          }
          if (checkpoint.model_task_id) {
            const [tasks] = await run('SELECT task_id, status FROM ai_model_tasks WHERE task_id = ? LIMIT 1 FOR UPDATE', [checkpoint.model_task_id])
            const task = tasks?.[0]
            if (!task) throw new Error('period_review_chunk_model_task_missing')
            if (!MODEL_TASK_TERMINAL_STATES.has(String(task.status || ''))) {
              throw new Error('period_review_chunk_model_task_unresolved')
            }
          }
          if (checkpointStatus === MONTHLY_REVIEW_CHECKPOINT_STATUSES.FAILED) {
            await run(`UPDATE period_review_monthly_checkpoints SET status = 'queued', attempt_count = 0,
              next_attempt_at_utc_msc = NULL, model_task_id = NULL, lease_token = NULL, lease_owner = NULL,
              lease_expires_at_utc_msc = NULL, fencing_token = fencing_token + 1,
              error_code = NULL, error_message = NULL, updated_at_utc_msc = ?
              WHERE id = ? AND status = 'failed'`, [Date.now(), checkpoint.id])
          }
        }
      }
      let nextIdempotencyKey = jobs[0].idempotency_key
      let clearModelTask = false
      if (jobs[0].model_task_id) {
        const [tasks] = await run('SELECT task_id, status FROM ai_model_tasks WHERE task_id = ? LIMIT 1 FOR UPDATE', [jobs[0].model_task_id])
        const task = tasks?.[0]
        if (!task) throw new Error('period_review_model_task_missing')
        if (!MODEL_TASK_TERMINAL_STATES.has(String(task.status || ''))) {
          throw new Error('period_review_model_task_unresolved')
        }
        nextIdempotencyKey = `retry:${jobType}:${periodCaseId}:${crypto.randomUUID()}`
        clearModelTask = true
      }
      await run(`UPDATE period_review_jobs SET status = 'queued', progress_stage = 'queued', stage_updated_at = ?, attempt_count = 0, last_error_code = NULL,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, completed_at = NULL,
        idempotency_key = ?, model_task_id = ${clearModelTask ? 'NULL' : 'model_task_id'}, updated_at = ? WHERE id = ?`,
      [now, nextIdempotencyKey, now, jobs[0].id])
    }
    else {
      const [insert] = await run(`INSERT INTO period_review_jobs
      (period_case_id, job_type, idempotency_key, status, attempt_count, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', 0, 3, ?, ?)`, [periodCaseId, jobType, `retry:${jobType}:${periodCaseId}:${crypto.randomUUID()}`, now, now])
      jobId = Number(insert.insertId)
    }
    await run(`UPDATE period_review_cases SET status = 'ready', updated_at = ? WHERE id = ?`, [now, periodCaseId])
    return { queued: true, jobId, period_case_id: periodCaseId, attempt_count: 0, job_status: 'queued', progress_stage: 'queued' }
  })
  await setPeriodReviewJobStage({ id:result.jobId, period_case_id:periodCaseId, attempt_count:0 }, 'queued', 'info', 'manual_retry_queued')
  requestPeriodReviewCycle()
  return result
}

export async function recoverExpiredPeriodReviewJobs() {
  const now = beijingNow()
  const expired = await queryAll(`SELECT id, period_case_id, attempt_count
    FROM period_review_jobs
    WHERE status = 'leased' AND lease_expires_at < ? AND attempt_count >= max_attempts`, [now])
  let recovered = 0
  for (const job of expired) {
    const changed = await withTransaction(async run => {
      const [update] = await run(`UPDATE period_review_jobs SET status = 'failed', progress_stage = 'failed', stage_updated_at = ?,
        last_error_code = 'period_review_model_timeout', lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'leased' AND lease_expires_at < ? AND attempt_count >= max_attempts`, [now, now, job.id, now])
      if (!update.affectedRows) return false
      await run(`UPDATE period_review_cases SET status = 'failed', updated_at = ?
        WHERE id = ? AND current_version_id IS NULL`, [now, job.period_case_id])
      await run(`INSERT INTO period_review_job_events
        (job_id, period_case_id, attempt_no, stage, event_status, message_code, metadata_json, created_at)
        VALUES (?, ?, ?, 'failed', 'error', 'period_review_model_timeout', NULL, ?)`,
      [job.id, job.period_case_id, Number(job.attempt_count || 0), now])
      return true
    })
    if (changed) {
      recovered += 1
      console.warn(`[PeriodReview case=${job.period_case_id}] expired after final attempt; marked failed`)
    }
  }
  return recovered
}

export async function runPeriodReviewCycle() {
  const recoveredModelTasks = await recoverAbandonedPeriodReviewModelTasks()
  const recoveredExpiredJobs = await recoverExpiredPeriodReviewJobs()
  const resumedDerivationJobs = await resumePeriodReviewDerivationJobs()
  const dailyPreparation = await prepareEligibleDailyReviews()
  const dailyWorker = await runDailyReviewWorkerOnce()
  const monthlyPreparation = await prepareEligibleMonthlyReviews()
  const monthlyWorker = await runMonthlyReviewWorkerOnce()
  const derivationWorker = await runPeriodReviewDerivationOnce()
  return { recoveredModelTasks, recoveredExpiredJobs, resumedDerivationJobs, dailyPreparation, dailyWorker, monthlyPreparation, monthlyWorker, derivationWorker }
}

export function startPeriodReviewWorker(intervalMs = 60_000) {
  if (periodReviewTimer) return false
  requestPeriodReviewCycle()
  periodReviewTimer = setInterval(requestPeriodReviewCycle, Math.max(10_000, Number(intervalMs || 60_000)))
  periodReviewTimer.unref?.()
  return true
}

export function stopPeriodReviewWorker() {
  if (!periodReviewTimer) return false
  clearInterval(periodReviewTimer)
  periodReviewTimer = null
  periodReviewWakeRequested = false
  return true
}
