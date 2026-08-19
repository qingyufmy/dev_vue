import crypto from 'crypto'
import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { sha256, resolveFrozenChanRequirement } from './inference-snapshots.js'
import { ensureReviewCaseForOutcome } from './review-workflow.js'
import { resolveAiTaskModel } from './model-profiles.js'
import { requestJsonObject } from './llm.js'
import { MODEL_PROVIDER_DEFAULTS, modelProviderProtocol } from './model-providers.js'
import { buildDailyPeriodMarketEvidence, monthlyPeriodMarketDigest,
  PERIOD_MARKET_SOURCE_POLICY_VERSION } from './period-market-evidence.js'
import { isAiFeatureEnabled } from './rollout-governance.js'
import {
  getStrategyMemoryLibraryForRuntime,
  sanitizeStrategyMemoryPrompt,
  strategyMemoryEstimatedTokenCount,
  createStrategyMemoryInjectionLog,
  enqueueApprovedStrategyMemoryUpdate,
  recordStrategyMemoryConflictEvidence,
} from './strategy-memory-library.js'
import { queueStrategyMemoryConsistencyCheck, requestStrategyMemoryConsistencyCycle } from './strategy-memory-consistency.js'
import { canManagePlatformAiContent, platformAiContentManagerSql } from './platform-content-access.js'
import { applyDefaultObserverClockBootstrap } from './terminal-clock.js'
import { getDefaultObserverSourceClock } from './observer-channels.js'
import { createModelTaskTracker } from './model-task-tracker.js'
import { MODEL_TASK_TERMINAL_STATES, appendModelTaskEvent, recoverAbandonedBusinessModelTasks } from './model-task-runtime.js'
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
// Evidence collection can be temporarily unavailable while the Bridge or its
// market source reconnects.  These retries are deliberately separate from the
// model-generation attempt counter: no provider task is created while the
// case is waiting for market evidence.
export const DAILY_EVIDENCE_RETRY_DELAYS_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000]
const DAILY_EVIDENCE_RETRY_MAX_DELAY_MS = DAILY_EVIDENCE_RETRY_DELAYS_MS.at(-1)
const DAILY_EVIDENCE_RETRY_STAGE = 'evidence_retry_wait'
const DAILY_EVIDENCE_RETRY_ERROR = 'period_market_incomplete'
// Failures before the provider request must not consume the business attempt
// counter, but they also must not wake the same broken setup every minute.
// Their ordinal is derived from period_review_job_events, so no new column or
// migration is needed and evidence_retry_count keeps its original meaning.
export const PERIOD_REVIEW_PRE_PROVIDER_RETRY_DELAYS_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000]
const PERIOD_REVIEW_PRE_PROVIDER_RETRY_MAX_DELAY_MS = PERIOD_REVIEW_PRE_PROVIDER_RETRY_DELAYS_MS.at(-1)
const PERIOD_REVIEW_PRE_PROVIDER_RETRY_STAGE = 'pre_provider_retry_wait'
const PERIOD_REVIEW_PRE_PROVIDER_RETRY_CODES = new Set([
  'model_task_create_failed', 'model_task_link_failed', 'model_task_transaction_runner_missing',
])

// ai_model_tasks.idempotency_key is VARCHAR(191) characters. Keep the historical
// period-review key character-for-character when it fits; only oversized task keys are
// replaced with a deterministic ASCII identity that still exposes the task
// namespace, job id, task kind, and the SHA-256 of the historical key.
export const PERIOD_REVIEW_MODEL_TASK_KEY_MAX_CHARS = 191
const PERIOD_REVIEW_MODEL_TASK_KEY_NAMESPACE = 'period_review'

function periodReviewAsciiKeyPart(value, fallback) {
  const normalized = String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '_')
  return (normalized || fallback).slice(0, 48)
}

export function buildPeriodReviewModelTaskRawKey({
  jobId, jobIdempotencyKey, taskKeySuffix = '',
} = {}) {
  const suffix = String(taskKeySuffix || '').trim()
  return `${PERIOD_REVIEW_MODEL_TASK_KEY_NAMESPACE}:${String(jobId)}:${String(jobIdempotencyKey)}${suffix ? `:${suffix}` : ''}`
}

export function periodReviewModelTaskIdempotencyKey({
  rawKey = null, jobId, jobIdempotencyKey, modelTaskKind, taskKeySuffix = '',
} = {}) {
  const historicalKey = rawKey == null
    ? buildPeriodReviewModelTaskRawKey({ jobId, jobIdempotencyKey, taskKeySuffix })
    : String(rawKey)
  if (Array.from(historicalKey).length <= PERIOD_REVIEW_MODEL_TASK_KEY_MAX_CHARS) return historicalKey
  const safeJobId = periodReviewAsciiKeyPart(jobId, 'unknown_job')
  const safeTaskKind = periodReviewAsciiKeyPart(modelTaskKind, 'unknown_task')
  const compactKey = `${PERIOD_REVIEW_MODEL_TASK_KEY_NAMESPACE}:${safeJobId}:${safeTaskKind}:sha256:${sha256(historicalKey)}`
  // The fixed 48-character component bounds above keep this below 191 characters;
  // retain an assertion so a future format change cannot reintroduce the
  // database error silently.
  if (Array.from(compactKey).length > PERIOD_REVIEW_MODEL_TASK_KEY_MAX_CHARS) {
    const error = new Error('period_review_model_task_key_generation_failed')
    error.code = 'period_review_model_task_key_generation_failed'
    throw error
  }
  return compactKey
}

const DAILY_EVIDENCE_RETRY_DISABLED_ERROR = 'review_generation_disabled'
const DAILY_EVIDENCE_RETRY_TERMINAL_STATES = new Set(['leased', 'status_unknown', 'succeeded', 'failed'])
const DAILY_EVIDENCE_RETRY_MARKET_REASONS = new Set([
  'period_market_incomplete', 'period_market_source_unavailable', 'period_market_candles_unavailable',
  'period_market_endpoint_incomplete', 'period_market_internal_gap', 'platform_market_source_unavailable',
  'bridge_not_connected', 'bridge_history_terminal_clock_unavailable', 'rates_gap_refill_failed',
  'market_session_policy_unavailable',
])
// The maintenance query below cannot call the JS classifier. Keep its legacy
// recovery lane to exact, reviewed reason/error codes instead of a broad LIKE
// match that could resurrect an identity, contract, or terminal evidence case.
const DAILY_EVIDENCE_RETRY_SQL_ALLOWLIST = [...DAILY_EVIDENCE_RETRY_MARKET_REASONS]
  .map(value => `'${value}'`).join(', ')
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

export function periodReviewModelInputBudget(messages) {
  const serialized = JSON.stringify(messages || [])
  const requestBytes = Buffer.byteLength(serialized, 'utf8')
  const estimatedInputTokens = estimateModelInputTokens(messages)
  return { requestBytes, estimatedInputTokens,
    withinBytes:requestBytes <= DAILY_REVIEW_MODEL_MAX_BYTES,
    withinTokens:estimatedInputTokens <= DAILY_REVIEW_MODEL_MAX_INPUT_TOKENS,
    maxBytes:DAILY_REVIEW_MODEL_MAX_BYTES,
    maxInputTokens:DAILY_REVIEW_MODEL_MAX_INPUT_TOKENS }
}

function assertPeriodReviewModelInputBudget(messages, taskKind) {
  // Monthly review has its own chunking and a different physical provider
  // contract.  The daily model-facing projection is the path that previously
  // sent an unbounded historical snapshot, so keep this gate scoped to it.
  if (String(taskKind || '') !== 'daily_review') return periodReviewModelInputBudget(messages)
  const budget = periodReviewModelInputBudget(messages)
  if (!budget.withinBytes || !budget.withinTokens) {
    const error = new Error('period_review_input_budget_exceeded')
    error.code = error.message
    error.requestBytes = budget.requestBytes
    error.estimatedInputTokens = budget.estimatedInputTokens
    error.maxBytes = budget.maxBytes
    error.maxInputTokens = budget.maxInputTokens
    throw error
  }
  return budget
}

async function preparePeriodReviewModelCall(taskKind, resolved, messages, schemaNeedTokens, {
  nowUtcMs = Date.now(), businessDeadlineUtcMs = null,
} = {}) {
  const inputBudget = assertPeriodReviewModelInputBudget(messages, taskKind)
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
    budget:{ ...budget, requestBytes:inputBudget.requestBytes,
      estimatedInputTokens:inputBudget.estimatedInputTokens },
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
  const regenerationJob = Number(normalized.job_slot || 0) > 0
    || String(normalized.job_idempotency_key || '').startsWith('regenerate:')
  if (!regenerationJob && ['evidence_pending', 'incomplete', 'ready', 'generating', 'failed'].includes(String(normalized.status || ''))) {
    normalized.status = 'draft'
  }
  // A durable version is the authoritative result.  If a worker died between
  // persisting that version and updating its business job, expose the result
  // as completed instead of leaving the UI in an endless generating state.
  if (!regenerationJob && Object.prototype.hasOwnProperty.call(normalized, 'job_status')) {
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
  const activeRegeneration = await queryOne(`SELECT id, status FROM period_review_jobs
    WHERE period_case_id = ? AND job_slot > 0 AND status IN ('queued', 'leased', 'status_unknown')
    ORDER BY id DESC LIMIT 1`, [reviewCase.id])
  if (activeRegeneration) return
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

export function shouldRefreshDailyReviewCase(reviewCase, group, sources = [], asOfUtcMs = Date.now(), existingJob = null) {
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
    if (isRecoverableDailyEvidenceJob(existingJob, reviewCase)) {
      const nextAttemptAtUtcMs = beijingDateTimeMs(existingJob.next_attempt_at)
      if (!nextAttemptAtUtcMs || Number(asOfUtcMs) >= nextAttemptAtUtcMs) {
        return { refresh:true, reason:'evidence_retry_due' }
      }
      return { refresh:false, reason:'evidence_retry_wait', next_attempt_at:existingJob.next_attempt_at }
    }
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
    || String(evidence?.period_market?.source_policy_version || '') !== PERIOD_MARKET_SOURCE_POLICY_VERSION
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
  periodType, periodCaseId, evidenceHash, now = beijingNow(), preserveQuotaFailure = false, targetStatus = null,
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
  const nextStatus = targetStatus || (preserveQuotaFailure ? 'failed' : 'queued')
  const preserveError = preserveQuotaFailure && nextStatus === 'failed'
  const result = !preserveError && !targetStatus
    ? await run(`UPDATE period_review_jobs SET idempotency_key = ?, model_task_id = NULL,
        status = 'queued', progress_stage = 'queued', stage_updated_at = ?, attempt_count = 0,
        last_error_code = NULL, evidence_retry_count = 0, evidence_last_checked_at = NULL,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
        completed_at = NULL, updated_at = ?
        WHERE period_case_id = ? AND job_type = ? AND job_slot = 0`,
      [idempotencyKey, now, now, caseId, jobType])
    : await run(`UPDATE period_review_jobs SET idempotency_key = ?, model_task_id = NULL,
        status = ?, progress_stage = ?, stage_updated_at = ?, attempt_count = 0,
        last_error_code = IF(? = 1, last_error_code, NULL), evidence_retry_count = 0, evidence_last_checked_at = NULL,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
        completed_at = NULL, updated_at = ?
        WHERE period_case_id = ? AND job_type = ? AND job_slot = 0`,
      [idempotencyKey, nextStatus, nextStatus, now, preserveError ? 1 : 0, now, caseId, jobType])
  const resultHeader = Array.isArray(result) ? result[0] : result
  const affectedRows = Number(resultHeader?.affectedRows ?? resultHeader?.changes ?? 0)
  if (affectedRows !== 1) throw new Error('period_review_job_refresh_conflict')
  return { idempotencyKey, jobType, periodCaseId:caseId,
    affectedRows }
}

async function queueDailyEvidenceRetry(run, {
  periodCaseId, evidenceHash, existingJob = null, now = beijingNow(),
} = {}) {
  if (typeof run !== 'function') throw new Error('period_review_job_transaction_required')
  const caseId = Number(periodCaseId)
  const hash = String(evidenceHash || '').trim()
  if (!Number.isSafeInteger(caseId) || caseId <= 0 || !hash) throw new Error('period_review_evidence_retry_identity_invalid')
  const retryCount = Math.max(0, Number(existingJob?.evidence_retry_count || 0)) + 1
  const retryAt = dailyEvidenceRetryAt(retryCount - 1, beijingDateTimeMs(now) || Date.now())
  const idempotencyKey = `daily:${caseId}:${hash}`
  if (existingJob?.id) {
    const result = await run(`UPDATE period_review_jobs SET idempotency_key = ?, status = 'queued',
        progress_stage = ?, stage_updated_at = ?, attempt_count = 0, last_error_code = ?,
        evidence_retry_count = ?, evidence_last_checked_at = ?, model_task_id = NULL,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, completed_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'skipped') AND lease_token IS NULL`,
    [idempotencyKey, DAILY_EVIDENCE_RETRY_STAGE, now, DAILY_EVIDENCE_RETRY_ERROR, retryCount, now,
      retryAt, now, existingJob.id])
    const header = Array.isArray(result) ? result[0] : result
    const affectedRows = Number(header?.affectedRows ?? header?.changes ?? 0)
    if (affectedRows !== 1) throw new Error('period_review_evidence_retry_conflict')
    return { id:Number(existingJob.id), idempotencyKey, retryCount, retryAt, affectedRows }
  }
  const result = await run(`INSERT IGNORE INTO period_review_jobs
      (period_case_id, job_type, job_slot, idempotency_key, status, progress_stage, stage_updated_at,
       attempt_count, max_attempts, last_error_code, evidence_retry_count, evidence_last_checked_at,
       next_attempt_at, created_at, updated_at, completed_at)
    VALUES (?, 'daily_review', 0, ?, 'queued', ?, ?, 0, 3, ?, ?, ?, ?, ?, ?, NULL)`,
  [caseId, idempotencyKey, DAILY_EVIDENCE_RETRY_STAGE, now, DAILY_EVIDENCE_RETRY_ERROR, retryCount, now,
    retryAt, now, now])
  const header = Array.isArray(result) ? result[0] : result
  const affectedRows = Number(header?.affectedRows ?? header?.changes ?? 0)
  if (affectedRows !== 1) {
    const current = await queryOne(`SELECT id, status, evidence_retry_count, next_attempt_at
      FROM period_review_jobs WHERE period_case_id = ? AND job_type = 'daily_review' AND job_slot = 0 LIMIT 1`, [caseId])
    if (!current) throw new Error('period_review_evidence_retry_conflict')
    return { id:Number(current.id), idempotencyKey, retryCount:Number(current.evidence_retry_count || 0),
      retryAt:current.next_attempt_at || retryAt, affectedRows:0 }
  }
  return { id:Number(header.insertId || 0), idempotencyKey, retryCount, retryAt, affectedRows }
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

function dailyEvidenceReasonTokens(value) {
  return [...new Set(String(value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean))]
}

export function isRecoverableDailyEvidenceReason(value) {
  const tokens = dailyEvidenceReasonTokens(value)
  if (!tokens.length || tokens.some(token => TERMINAL_TRADE_EVIDENCE_REASONS.has(token))) return false
  // Unknown market/source/identity/contract errors must fail closed. Only the
  // explicit transient allowlist below can be scheduled for automatic retry.
  const isTransient = token => DAILY_EVIDENCE_RETRY_MARKET_REASONS.has(token)
    || token === 'bridge not connected' || token === 'bridge history terminal clock unavailable'
    || token.endsWith(':bridge not connected') || token.endsWith(':bridge history terminal clock unavailable')
  return tokens.every(isTransient)
}

export function dailyEvidenceRetryDelayMs(evidenceRetryCount = 0) {
  const count = Math.max(0, Math.trunc(Number(evidenceRetryCount) || 0))
  return DAILY_EVIDENCE_RETRY_DELAYS_MS[Math.min(count, DAILY_EVIDENCE_RETRY_DELAYS_MS.length - 1)]
    || DAILY_EVIDENCE_RETRY_MAX_DELAY_MS
}

export function dailyEvidenceRetryAt(evidenceRetryCount = 0, nowUtcMs = Date.now()) {
  return beijingAtUtcMs(Number(nowUtcMs) + dailyEvidenceRetryDelayMs(evidenceRetryCount))
}

export function periodReviewPreProviderRetryDelayMs(retryCount = 0) {
  const count = Math.max(0, Math.trunc(Number(retryCount) || 0))
  return PERIOD_REVIEW_PRE_PROVIDER_RETRY_DELAYS_MS[Math.min(count, PERIOD_REVIEW_PRE_PROVIDER_RETRY_DELAYS_MS.length - 1)]
    || PERIOD_REVIEW_PRE_PROVIDER_RETRY_MAX_DELAY_MS
}

export function periodReviewPreProviderRetryAt(retryCount = 0, nowUtcMs = Date.now()) {
  return beijingAtUtcMs(Number(nowUtcMs) + periodReviewPreProviderRetryDelayMs(retryCount))
}

function periodReviewPreProviderErrorCode(error) {
  const code = String(error?.code || '').trim()
  if (PERIOD_REVIEW_PRE_PROVIDER_RETRY_CODES.has(code)) return code
  const messageCode = String(error?.message || '').split(':', 1)[0].trim()
  return PERIOD_REVIEW_PRE_PROVIDER_RETRY_CODES.has(messageCode) ? messageCode : null
}

async function nextPeriodReviewPreProviderRetry(job, error) {
  const errorCode = periodReviewPreProviderErrorCode(error)
  if (!errorCode || periodReviewProviderRequestStarted(job?._modelTracker)) return null
  let previousCount = 0
  try {
    const row = await queryOne(`SELECT COUNT(*) AS retry_count
      FROM period_review_job_events
      WHERE job_id = ? AND stage = ? AND event_status = 'error' AND message_code = ?`,
    [job.id, PERIOD_REVIEW_PRE_PROVIDER_RETRY_STAGE, errorCode])
    previousCount = Math.max(0, Number(row?.retry_count || 0))
  } catch (lookupError) {
    // The event table is observability state. If it is temporarily unavailable,
    // retain a safe first backoff rather than turning the business job terminal.
    console.warn(`[PeriodReview case=${job?.period_case_id}] pre-provider retry history unavailable:`, safeError(lookupError))
  }
  const retryCount = previousCount + 1
  const retryAt = periodReviewPreProviderRetryAt(retryCount - 1)
  return { errorCode, retryCount, retryAt, delayMs:periodReviewPreProviderRetryDelayMs(retryCount - 1) }
}

export function isRecoverableDailyEvidenceJob(job, reviewCase = null) {
  if (!job || Number(reviewCase?.current_version_id || 0) > 0
    || String(reviewCase?.evidence_status || '') === 'complete') return false
  const status = String(job.status || '').toLowerCase()
  if (DAILY_EVIDENCE_RETRY_TERMINAL_STATES.has(status)
    || status === 'disabled' || String(job.last_error_code || '').toLowerCase() === DAILY_EVIDENCE_RETRY_DISABLED_ERROR) return false
  return ['queued', 'skipped', 'retry_wait', DAILY_EVIDENCE_RETRY_STAGE].includes(status)
    && isRecoverableDailyEvidenceReason([reviewCase?.evidence_reason, job.last_error_code].filter(Boolean).join(','))
}

function isRecoverableDailyQuotaFailure(job) {
  const code = String(job?.last_error_code || '').toLowerCase()
  return String(job?.status || '') === 'failed'
    && !String(job?.idempotency_key || '').endsWith(`:${DAILY_REVIEW_QUOTA_RECOVERY_VERSION}`)
    && (code.includes('model_quota_exhausted') || code.includes('http 429') || code.includes('rate limit'))
}

async function recoverDailyQuotaFailure(reviewCase, job) {
  if (!reviewCase || !job || reviewCase.current_version_id || reviewCase.evidence_status !== 'complete'
    || !isRecoverableDailyQuotaFailure(job)) return false
  const baseKey = String(job.idempotency_key || `daily:${reviewCase.id}:${reviewCase.evidence_hash}`)
    .replace(/:quota-recovery-v1$/, '')
  const now = beijingNow()
  const result = await queryRun(`UPDATE period_review_jobs SET idempotency_key = ?, model_task_id = NULL,
      status = 'queued', progress_stage = 'queued', stage_updated_at = ?, attempt_count = 0,
      last_error_code = NULL, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
      completed_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'failed' AND last_error_code = ?`,
  [`${baseKey}:${DAILY_REVIEW_QUOTA_RECOVERY_VERSION}`, now, now, job.id, job.last_error_code])
  const affected = Number(result?.affectedRows ?? result?.changes ?? 0)
  if (affected !== 1) return false
  await queryRun(`UPDATE period_review_cases SET status = 'ready', updated_at = ?
    WHERE id = ? AND current_version_id IS NULL AND evidence_status = 'complete'`, [now, reviewCase.id])
  return true
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
const DAILY_REVIEW_V3_CONTRACT = 'daily-period-review-v3'
const V3_MARKET_ALIGNMENT = new Set(['aligned', 'partly_aligned', 'conflict', 'insufficient_evidence'])
const V3_STRATEGY_ALIGNMENT = new Set(['aligned', 'partly_aligned', 'conflict', 'insufficient_evidence'])
const V3_OUTCOME_RESULTS = new Set(['profit', 'loss', 'breakeven'])
const V3_AVOIDABILITY = new Set(['avoidable', 'partly_avoidable', 'normal_strategy_loss', 'insufficient_evidence'])
const V3_RISK_EXECUTION_STATUS = new Set(['compliant', 'partly_compliant', 'violation', 'insufficient_evidence'])
const V3_MAX_ISSUE_CODES = 20
const V3_MAX_EVIDENCE_REFS = 50
const V3_MAX_PRIMARY_CAUSES = 8
const V3_MAX_EXPERIENCE_RULES = 100
const DAILY_MISSED_WINDOW_RECOVERY_GRACE_MINUTES = 30
const DAILY_REVIEW_CHUNK_MAX_OUTCOMES = 20
// The provider receives the model projection, not the frozen evidence blob.
// Leave headroom for the contract/system message while keeping both physical
// request bytes and the calibrated input-token estimate below the acceptance
// gates.  A separate hard guard below still protects callers that build a
// larger request accidentally.
const DAILY_REVIEW_CHUNK_MAX_BYTES = 180000
const DAILY_REVIEW_MODEL_MAX_BYTES = 500 * 1024
const DAILY_REVIEW_MODEL_MAX_INPUT_TOKENS = 120000
const DAILY_REVIEW_CHUNK_PLAN_MAX_BYTES = 470 * 1024
const DAILY_REVIEW_CHUNK_PLAN_MAX_INPUT_TOKENS = 110000
const DAILY_REVIEW_CHUNK_PLAN_VERSION = 'daily-request-budget-v2'
const DAILY_REVIEW_POLICY_UPGRADE_LIMIT = 5
const DAILY_REVIEW_PRE_TRADE_TEXT_MAX_BYTES = 12000
const DAILY_REVIEW_STRATEGY_TEXT_MAX_BYTES = 72000
const DAILY_REVIEW_MEMORY_TEXT_MAX_BYTES = 72000
const DAILY_REVIEW_LOCAL_KLINE_LIMIT = 32
const DAILY_REVIEW_MODEL_TASK_MAX_ATTEMPTS = 12
const DAILY_REVIEW_MARKET_DIGEST_VERSION = 'daily-market-digest-v1'
const DAILY_REVIEW_QUOTA_RECOVERY_VERSION = 'quota-recovery-v1'
const DAILY_RECOVERY_LIMIT_MAX = 100
const DAILY_RECOVERY_GRACE_MAX_MINUTES = 7 * 24 * 60

export const DAILY_PERIOD_REVIEW_V3_CONTRACT = DAILY_REVIEW_V3_CONTRACT

// Period-review UI metadata is deliberately kept separate from the model
// output contract.  The frontend contract identifies the editor/runtime that
// is allowed to write a review, while period_review_contracts describes the
// output shapes that this server can still read.
export const PERIOD_REVIEW_FRONTEND_CONTRACT_VERSION = 'period-review-ui-v1'
export const PERIOD_REVIEW_FRONTEND_BUILD = 'period-review-evidence-retry1'
export const PERIOD_REVIEW_SUPPORTED_OUTPUT_CONTRACTS = Object.freeze([
  DAILY_PERIOD_REVIEW_V3_CONTRACT,
  'daily-period-review-v1',
  'daily-period-review-v2',
  'period-review-v1',
  'period-review-v2',
])

export function periodReviewFrontendMetadata() {
  return {
    frontend_contract_version:PERIOD_REVIEW_FRONTEND_CONTRACT_VERSION,
    period_review_contracts:[...PERIOD_REVIEW_SUPPORTED_OUTPUT_CONTRACTS],
    ai_frontend_build:PERIOD_REVIEW_FRONTEND_BUILD,
  }
}

const PERIOD_REVIEW_FRONTEND_BUILD_HEADER_NAMES = new Set([
  'x-aurum-ai-frontend-build',
  'x-ai-frontend-build',
  'x-frontend-build',
])
const PERIOD_REVIEW_FRONTEND_CONTRACT_HEADER_NAMES = new Set([
  'x-aurum-period-review-frontend-contract',
  'x-aurum-ai-frontend-contract',
  'x-ai-frontend-contract',
  'x-frontend-contract',
])

function explicitFrontendHeaderValues(headers, acceptedNames) {
  if (!headers || typeof headers !== 'object') return []
  const values = []
  for (const [key, raw] of Object.entries(headers)) {
    if (!acceptedNames.has(String(key).toLowerCase())) continue
    for (const value of (Array.isArray(raw) ? raw : [raw])) values.push(String(value ?? '').trim())
  }
  return values
}

/**
 * Returns true when a content/status/model-call writer does not identify the
 * exact UI build and contract that owns the current editor.  Both headers are
 * required for writes; output-contract headers are intentionally not part of
 * this UI write guard.
 */
export function periodReviewFrontendContractMismatch(input = {}) {
  const headers = input?.headers && typeof input.headers === 'object' ? input.headers : input
  const declaredBuilds = explicitFrontendHeaderValues(headers, PERIOD_REVIEW_FRONTEND_BUILD_HEADER_NAMES)
  const declaredContracts = explicitFrontendHeaderValues(headers, PERIOD_REVIEW_FRONTEND_CONTRACT_HEADER_NAMES)
  return declaredBuilds.length === 0 || declaredBuilds.some(value => value !== PERIOD_REVIEW_FRONTEND_BUILD)
    || declaredContracts.length === 0 || declaredContracts.some(value => value !== PERIOD_REVIEW_FRONTEND_CONTRACT_VERSION)
}

export function dailyReviewRecoveryRuntimeOptions(env = process.env) {
  const enabled = /^(1|true|yes|on)$/i.test(String(env?.AI_DAILY_REVIEW_MISSED_WINDOW_RECOVERY || '').trim())
  const parsedLimit = Number(env?.AI_DAILY_REVIEW_MISSED_WINDOW_RECOVERY_LIMIT)
  const parsedGrace = Number(env?.AI_DAILY_REVIEW_MISSED_WINDOW_RECOVERY_GRACE_MINUTES)
  const recoveryLimit = Number.isFinite(parsedLimit)
    ? Math.min(DAILY_RECOVERY_LIMIT_MAX, Math.max(0, Math.trunc(parsedLimit))) : 0
  const recoveryGraceMinutes = Number.isFinite(parsedGrace)
    ? Math.min(DAILY_RECOVERY_GRACE_MAX_MINUTES, Math.max(0, Math.trunc(parsedGrace)))
    : DAILY_MISSED_WINDOW_RECOVERY_GRACE_MINUTES
  return { missedWindowRecovery:enabled && recoveryLimit > 0, recoveryLimit, recoveryGraceMinutes,
    maxRecoveryLimit:DAILY_RECOVERY_LIMIT_MAX }
}

function boundedReviewText(value, field, { maxLength = 8000, required = true } = {}) {
  const text = memoryMarkdownText(value)
  if (required && !text) throw new Error(`${field}_missing`)
  if (text.length > maxLength) throw new Error(`${field}_too_long`)
  return text
}

function normalizeConfidence(value, field = 'daily_review_confidence') {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`invalid_${field}`)
  return number
}

function normalizeV3TextArray(value, field, maxItems = 100) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`invalid_daily_v3_${field}`)
  return value.map((item, index) => boundedReviewText(item, `daily_v3_${field}_${index}`, { maxLength:3000 }))
}

function normalizeV3ObservationArray(value, field, knownOutcomeIds, { requireTwoSources = false } = {}) {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`invalid_daily_v3_${field}`)
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`invalid_daily_v3_${field}`)
    const text = boundedReviewText(item.text, `daily_v3_${field}_${index}_text`, { maxLength:3000 })
    if (!Array.isArray(item.source_refs) || item.source_refs.length < 1) throw new Error(`daily_v3_${field}_source_refs_missing`)
    const refs = [...new Set(item.source_refs.map(ref => String(ref ?? '').trim()))]
    if (refs.some(ref => !/^outcome:\d+$/.test(ref))
      || refs.some(ref => !knownOutcomeIds.has(Number(ref.slice('outcome:'.length))))) {
      throw new Error(`daily_v3_${field}_source_refs_invalid`)
    }
    const occurrenceCount = Number(item.occurrence_count)
    if (!Number.isSafeInteger(occurrenceCount) || occurrenceCount !== refs.length || occurrenceCount < 1) {
      throw new Error(`daily_v3_${field}_occurrence_count_invalid`)
    }
    if (requireTwoSources && refs.length < 2) throw new Error('daily_v3_repeated_issue_requires_two_outcomes')
    return { text, source_refs:refs, occurrence_count:occurrenceCount }
  })
}

function normalizeV3EvidenceRefs(value, outcomeId, allowedRefs = null) {
  if (!Array.isArray(value) || value.length < 1 || value.length > V3_MAX_EVIDENCE_REFS) {
    throw new Error('invalid_daily_v3_evidence_refs')
  }
  const refs = [...new Set(value.map(ref => String(ref ?? '').trim()))]
  if (refs.some(ref => !ref) || refs.some(ref => !/^[-a-zA-Z0-9_:.]+$/.test(ref))) {
    throw new Error('invalid_daily_v3_evidence_refs')
  }
  const fallback = new Set([`outcome:${outcomeId}`])
  const allowed = allowedRefs instanceof Set && allowedRefs.size ? allowedRefs : fallback
  if (refs.some(ref => !allowed.has(ref))) throw new Error('daily_v3_evidence_ref_not_allowed')
  return refs
}

function normalizeExperienceRules(input, {
  allowedSourceRefs = null, chanMemoryAllowed = true, knownOutcomeIds = new Set(),
} = {}) {
  if (!Array.isArray(input)) throw new Error('invalid_daily_experience_rules')
  if (input.length > V3_MAX_EXPERIENCE_RULES) throw new Error('daily_experience_rules_too_many')
  return input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid_daily_experience_rule')
    const category = String(item.category || item.memory_category || 'general').trim().toLowerCase()
    if (!MEMORY_CATEGORIES.has(category)) throw new Error('daily_experience_rule_category_invalid')
    if (category === 'chan_structure' && !chanMemoryAllowed) throw new Error('strategy_memory_chan_evidence_invalid')
    const condition = boundedReviewText(item.condition, 'daily_experience_rule_condition', { maxLength: 3000 })
    const action = boundedReviewText(item.action, 'daily_experience_rule_action', { maxLength: 3000 })
    const riskControl = boundedReviewText(item.risk_control, 'daily_experience_rule_risk_control', { maxLength: 3000 })
    const invalidation = boundedReviewText(item.invalidation, 'daily_experience_rule_invalidation', { maxLength: 3000 })
    const prohibitedAction = boundedReviewText(item.prohibited_action, 'daily_experience_rule_prohibited_action', { maxLength: 3000 })
    const refs = item.source_refs ?? item.evidence_refs
    if (!Array.isArray(refs) || refs.length < 1) throw new Error('daily_experience_rule_source_refs_missing')
    const sourceRefs = [...new Set(refs.map(ref => String(ref ?? '').trim()))]
    if (sourceRefs.some(ref => !/^outcome:\d+$/.test(ref))) throw new Error('daily_experience_rule_source_refs_invalid')
    if (allowedSourceRefs && sourceRefs.some(ref => !allowedSourceRefs.has(ref))) throw new Error('daily_experience_rule_source_refs_invalid')
    const referencedOutcomeIds = sourceRefs.map(ref => Number(ref.slice('outcome:'.length)))
    if (referencedOutcomeIds.some(id => !knownOutcomeIds.has(id))) throw new Error('daily_experience_rule_source_refs_invalid')
    return {
      category, condition, action, risk_control:riskControl, invalidation, prohibited_action:prohibitedAction,
      source_refs:sourceRefs, confidence:normalizeConfidence(item.confidence, 'daily_experience_rule_confidence'),
    }
  })
}

function dailyOutcomeEvidenceRefs(source, outcomeId) {
  const refs = new Set([`outcome:${outcomeId}`])
  const evidenceRefs = source?.evidence_refs && typeof source.evidence_refs === 'object' ? source.evidence_refs : {}
  for (const [key, value] of Object.entries(evidenceRefs)) {
    const id = value && typeof value === 'object' ? (value.id ?? value.hash ?? value.outcome_id) : value
    if (id !== null && id !== undefined && String(id).trim()) refs.add(`${key}:${String(id).trim()}`)
  }
  return refs
}

function dailyOutcomeFacts(outcomeFacts) {
  if (outcomeFacts instanceof Map) return outcomeFacts
  const map = new Map()
  if (Array.isArray(outcomeFacts)) {
    for (const item of outcomeFacts) {
      const id = Number(item?.outcome_id ?? item?.id)
      if (Number.isSafeInteger(id) && id > 0) map.set(id, item)
    }
  } else if (outcomeFacts && typeof outcomeFacts === 'object') {
    for (const [key, item] of Object.entries(outcomeFacts)) {
      const id = Number(item?.outcome_id ?? item?.id ?? key)
      if (Number.isSafeInteger(id) && id > 0) map.set(id, item)
    }
  }
  return map
}

function expectedV3OutcomeResult(netProfit) {
  const value = Number(netProfit)
  if (!Number.isFinite(value)) return null
  return value > 0 ? 'profit' : value < 0 ? 'loss' : 'breakeven'
}

function normalizeDailyV3Content(input, outcomeIds, chanContext, conflictContext = {}) {
  const normalizedChanContext = normalizeReviewChanContext(chanContext)
  // v3 callers must provide an explicit frozen Chan capability.  Undefined
  // context is retained only for the legacy v2 validator compatibility path.
  const chanAllowed = normalizedChanContext.mode === 'enabled_complete'
  const known = new Set(outcomeIds.map(Number))
  const facts = dailyOutcomeFacts(conflictContext.outcomeFacts)
  const evidenceRefsByOutcome = conflictContext.evidenceRefsByOutcome instanceof Map
    ? conflictContext.evidenceRefsByOutcome : new Map()
  const evidenceLimitationsByOutcome = conflictContext.evidenceLimitationsByOutcome instanceof Map
    ? conflictContext.evidenceLimitationsByOutcome : new Map()
  const periodSummary = firstReviewText(input, ['period_summary', 'daily_summary', 'review_summary', 'summary'])
  if (!periodSummary) throw new Error('daily_review_summary_missing')
  if (!DAILY_DECISIONS.has(input.decision_quality)) throw new Error('invalid_daily_review_decision')
  for (const key of ['trade_assessments', 'repeated_issues', 'strengths', 'risk_observations', 'next_day_actions']) {
    if (!Array.isArray(input[key])) throw new Error(`invalid_daily_review_${key}`)
  }
  if (!Array.isArray(input.experience_rules)) throw new Error('invalid_daily_experience_rules')
  if (chanAllowed && !Array.isArray(input.chan_diagnoses)) throw new Error('invalid_daily_review_chan_diagnoses')
  if (!chanAllowed && (hasNonEmptyValue(input.chan_diagnoses) || hasNonEmptyValue(input.period_chan_assessment))) {
    throw new Error('strategy_memory_chan_evidence_invalid')
  }
  const assessments = input.trade_assessments.map(item => {
    const outcomeId = Number(item?.outcome_id)
    if (!known.has(outcomeId) || !DAILY_DECISIONS.has(item?.decision_quality)) throw new Error('invalid_daily_v3_trade_assessment')
    const originalSignalLogic = boundedReviewText(item.original_signal_logic, 'daily_v3_original_signal_logic')
    const technicalBasisAssessment = boundedReviewText(item.technical_basis_assessment, 'daily_v3_technical_basis_assessment')
    const riskExecutionAssessment = boundedReviewText(typeof item.risk_execution_assessment === 'object'
      ? (item.risk_execution_assessment.summary || item.risk_execution_assessment.text) : item.risk_execution_assessment,
    'daily_v3_risk_execution_assessment')
    const riskExecutionStatus = String(item.risk_execution_status
      || (item.risk_execution_assessment && typeof item.risk_execution_assessment === 'object'
        ? item.risk_execution_assessment.status : '')).trim()
    if (!V3_RISK_EXECUTION_STATUS.has(riskExecutionStatus)) throw new Error('invalid_daily_v3_risk_execution_status')
    if (!V3_MARKET_ALIGNMENT.has(item.market_alignment)) throw new Error('invalid_daily_v3_market_alignment')
    if (!V3_STRATEGY_ALIGNMENT.has(item.strategy_alignment)) throw new Error('invalid_daily_v3_strategy_alignment')
    const attribution = item?.outcome_attribution
    if (!attribution || typeof attribution !== 'object' || Array.isArray(attribution)) throw new Error('invalid_daily_v3_outcome_attribution')
    if (!V3_OUTCOME_RESULTS.has(attribution.result)) throw new Error('invalid_daily_v3_outcome_result')
    if (!Array.isArray(attribution.primary_causes) || attribution.primary_causes.length < 1
      || attribution.primary_causes.length > V3_MAX_PRIMARY_CAUSES) throw new Error('invalid_daily_v3_primary_causes')
    const primaryCauses = attribution.primary_causes.map((cause, index) => boundedReviewText(cause,
      `daily_v3_primary_cause_${index}`, { maxLength:2000 }))
    const explanation = boundedReviewText(attribution.explanation, 'daily_v3_outcome_explanation')
    if (!V3_AVOIDABILITY.has(attribution.avoidability)) throw new Error('invalid_daily_v3_avoidability')
    const factsForOutcome = facts.get(outcomeId)
    const expectedResult = expectedV3OutcomeResult(factsForOutcome?.net_profit ?? factsForOutcome?.outcome?.net_profit)
    if (expectedResult && expectedResult !== attribution.result) throw new Error('daily_v3_outcome_result_mismatch')
    if (attribution.avoidability === 'normal_strategy_loss'
      && (expectedResult !== 'loss' || item.decision_quality !== 'good' || item.market_alignment !== 'aligned'
        || item.strategy_alignment !== 'aligned' || riskExecutionStatus !== 'compliant')) {
      throw new Error('daily_v3_normal_loss_inconsistent')
    }
    if (Object.prototype.hasOwnProperty.call(item, 'missing_evidence')
      && !Array.isArray(item.missing_evidence)) throw new Error('invalid_daily_v3_missing_evidence')
    const serverEvidenceLimitations = (evidenceLimitationsByOutcome.get(outcomeId) || []).map(item => ({
      scope:String(item?.scope || ''), description:String(item?.description || ''),
      unavailable_capabilities:[...new Set((Array.isArray(item?.unavailable_capabilities)
        ? item.unavailable_capabilities : []).map(String).filter(Boolean))],
    })).filter(item => item.scope && item.description)
    const hasInsufficientState = item.decision_quality === 'insufficient_evidence'
      || item.market_alignment === 'insufficient_evidence'
      || item.strategy_alignment === 'insufficient_evidence'
      || riskExecutionStatus === 'insufficient_evidence'
      || attribution.avoidability === 'insufficient_evidence'
    // Evidence availability is a server-owned fact. Ignore invented model
    // gaps when deterministic evidence is complete, and derive the visible
    // list from frozen limitations when an insufficient state is permitted.
    const missingEvidence = hasInsufficientState
      ? serverEvidenceLimitations.map(value => boundedReviewText(value.description,
        'daily_v3_server_missing_evidence', { maxLength:2000 }))
      : []
    if (hasInsufficientState && !missingEvidence.length) throw new Error('daily_v3_insufficient_state_without_server_limitation')
    if (item.decision_quality === 'insufficient_evidence'
      && item.market_alignment !== 'insufficient_evidence'
      && item.strategy_alignment !== 'insufficient_evidence'
      && riskExecutionStatus !== 'insufficient_evidence'
      && attribution.avoidability !== 'insufficient_evidence') {
      throw new Error('daily_v3_insufficient_decision_contradicts_deterministic')
    }
    // Validation no longer spends a provider repair call solely because a
    // complete trade contained an extra model-authored missing_evidence.
    const nextRule = item.next_time_rule
    if (!nextRule || typeof nextRule !== 'object' || Array.isArray(nextRule)) throw new Error('invalid_daily_v3_next_time_rule')
    const normalizedRule = {
      condition:boundedReviewText(nextRule.condition, 'daily_v3_next_rule_condition'),
      action:boundedReviewText(nextRule.action, 'daily_v3_next_rule_action'),
      risk_control:boundedReviewText(nextRule.risk_control, 'daily_v3_next_rule_risk_control'),
      invalidation:boundedReviewText(nextRule.invalidation, 'daily_v3_next_rule_invalidation'),
      prohibited_action:boundedReviewText(nextRule.prohibited_action, 'daily_v3_next_rule_prohibited_action'),
    }
    const refs = normalizeV3EvidenceRefs(item.evidence_refs, outcomeId, evidenceRefsByOutcome.get(outcomeId))
    return {
      outcome_id:outcomeId, decision_quality:item.decision_quality,
      original_signal_logic:originalSignalLogic, technical_basis_assessment:technicalBasisAssessment,
      market_alignment:item.market_alignment, strategy_alignment:item.strategy_alignment,
      risk_execution_assessment:riskExecutionAssessment, risk_execution_status:riskExecutionStatus,
      missing_evidence:missingEvidence,
      evidence_limitations:serverEvidenceLimitations,
      outcome_attribution:{ result:attribution.result, primary_causes:primaryCauses, explanation,
        avoidability:attribution.avoidability },
      next_time_rule:normalizedRule,
      issue_codes:[...new Set((Array.isArray(item.issue_codes) ? item.issue_codes : []).map(code => boundedReviewText(code,
        'daily_v3_issue_code', { maxLength:120 })).slice(0, V3_MAX_ISSUE_CODES))],
      evidence_refs:refs, confidence:normalizeConfidence(item.confidence, 'daily_v3_trade_confidence'),
    }
  })
  if (assessments.length !== known.size || new Set(assessments.map(item => item.outcome_id)).size !== known.size) {
    throw new Error('daily_review_trade_coverage_incomplete')
  }
  const normalizedRules = normalizeExperienceRules(input.experience_rules, {
    allowedSourceRefs:new Set([...known].map(id => `outcome:${id}`)), chanMemoryAllowed:chanAllowed, knownOutcomeIds:known,
  })
  const normalizedRepeatedIssues = normalizeV3ObservationArray(input.repeated_issues, 'repeated_issues', known, { requireTwoSources:true })
  const normalizedStrengths = normalizeV3ObservationArray(input.strengths, 'strengths', known)
  const periodChan = chanAllowed && input.period_chan_assessment && typeof input.period_chan_assessment === 'object'
    ? input.period_chan_assessment : { status:'insufficient_evidence', issue_source:'unknown', explanation:'', affected_outcome_ids:[], confidence:0 }
  const affectedOutcomeIds = [...new Set((Array.isArray(periodChan.affected_outcome_ids) ? periodChan.affected_outcome_ids : []).map(Number))]
  if (chanAllowed && (!CHAN_SOURCES.has(periodChan.issue_source) || affectedOutcomeIds.some(id => !known.has(id)))) {
    throw new Error('invalid_daily_period_chan_assessment')
  }
  const strategyConflicts = normalizeStrategyConflicts({ ...input }, {
    allowedSourceRefs:new Set([...known].map(id => `outcome:${id}`)), requireSourceRefs:true,
    strategyText:conflictContext.strategyText, memoryText:conflictContext.memoryText,
    proposedExperiences:normalizedRules.map(rule => [rule.condition, rule.action, rule.prohibited_action].join('；')),
    requireExactProposedExcerpt:true,
  })
  const result = {
    output_contract_version:DAILY_REVIEW_V3_CONTRACT, period_summary:periodSummary, decision_quality:input.decision_quality,
    trade_assessments:assessments, repeated_issues:normalizedRepeatedIssues,
    strengths:normalizedStrengths,
    risk_observations:normalizeV3TextArray(input.risk_observations, 'risk_observations'),
    next_day_actions:normalizeV3TextArray(input.next_day_actions, 'next_day_actions'),
    experience_rules:normalizedRules, strategy_conflicts:strategyConflicts, confidence:normalizeConfidence(input.confidence),
  }
  if (chanAllowed) {
    if (input.chan_diagnoses.length !== known.size || new Set(input.chan_diagnoses.map(item => Number(item?.outcome_id))).size !== known.size) {
      throw new Error('daily_review_chan_coverage_incomplete')
    }
    result.chan_diagnoses = input.chan_diagnoses.map(item => {
      const outcomeId = Number(item?.outcome_id)
      if (!known.has(outcomeId) || !CHAN_SOURCES.has(item?.issue_source)) throw new Error('invalid_daily_chan_diagnosis')
      return { outcome_id:outcomeId, status:String(item.status || 'insufficient_evidence'), issue_source:item.issue_source,
        impact_on_decision:String(item.impact_on_decision || 'unknown'), explanation:String(item.explanation || '').trim(),
        confidence:normalizeConfidence(item.confidence || 0, 'daily_chan_confidence') }
    })
    result.period_chan_assessment = { status:String(periodChan.status || 'insufficient_evidence'), issue_source:periodChan.issue_source,
      explanation:String(periodChan.explanation || '').trim(), affected_outcome_ids:affectedOutcomeIds,
      confidence:normalizeConfidence(periodChan.confidence || 0, 'daily_period_chan_confidence') }
  }
  return result
}

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
  memoryText = null, proposedExperiences = [], requireExactProposedExcerpt = false,
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
      && !proposedExperiences.some(value => requireExactProposedExcerpt
        ? String(value || '').trim() === memoryExcerpt
        : String(value || '').includes(memoryExcerpt))) {
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
  if (String(input.output_contract_version || input.contract_version || '') === DAILY_REVIEW_V3_CONTRACT) {
    return normalizeDailyV3Content(input, outcomeIds, chanContext, conflictContext)
  }
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

/**
 * Validator used by newly created daily-period-review-v3 model tasks.  The
 * legacy public validator remains backwards compatible for old editors, but a
 * new task must never silently fall back to the daily_lessons contract.  A
 * response that is structurally v3 but only omits the version marker is the
 * one safe normalization performed here.
 */
export function validateDailyReviewV3Content(input, outcomeIds = [], chanContext, conflictContext = {}) {
  const value = unwrapReviewContent(input, ['daily_review', 'review'])
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_daily_v3_contract_version')
  const declared = String(value.output_contract_version || value.contract_version || '').trim()
  if (declared && declared !== DAILY_REVIEW_V3_CONTRACT) throw new Error('invalid_daily_v3_contract_version')
  const looksV3 = Object.prototype.hasOwnProperty.call(value, 'trade_assessments')
    || Object.prototype.hasOwnProperty.call(value, 'experience_rules')
    || Object.prototype.hasOwnProperty.call(value, 'next_day_actions')
    || Object.prototype.hasOwnProperty.call(value, 'original_signal_logic')
  const looksLegacy = Object.prototype.hasOwnProperty.call(value, 'daily_lessons')
    || Object.prototype.hasOwnProperty.call(value, 'memory_updates')
  if (!declared && (!looksV3 || looksLegacy)) throw new Error('invalid_daily_v3_contract_version')
  return normalizeDailyV3Content({ ...value, output_contract_version:DAILY_REVIEW_V3_CONTRACT }, outcomeIds,
    chanContext, conflictContext)
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

async function eligibleOutcomeRows(limit, { includeHistoricalRecovery = false } = {}) {
  const batchLimit = Math.min(2000, Math.max(2, Number(limit || 500)))
  // Reserve a stable live lane on every cycle. Historical recovery is an
  // optional third lane and receives only its own budget, so enabling it can
  // reduce maintenance throughput but can never displace newly eligible
  // outcomes from the live lane or make the aggregate exceed `limit`.
  const liveLimit = Math.max(1, Math.floor(batchLimit * 0.3))
  // Keep a small batch useful as well: reserving a recovery slot for a
  // two-to-four row batch would make the lane budgets exceed the requested
  // limit once the maintenance lane is retained. Recovery is therefore
  // intentionally deferred until there is a bounded slot left for it.
  const recoveryLimit = includeHistoricalRecovery && batchLimit >= 5
    ? Math.max(1, Math.floor(batchLimit * 0.2)) : 0
  // Policy upgrades are a priority sub-lane inside the bounded maintenance
  // budget, not extra capacity.  This preserves the live lane and prevents
  // an upgrade batch from making the scheduler exceed `batchLimit`.
  const backlogLimit = Math.max(0, batchLimit - liveLimit - recoveryLimit)
  const policyUpgradeLimit = Math.min(DAILY_REVIEW_POLICY_UPGRADE_LIMIT, backlogLimit)
  // Keep a full recent lane after removing historical unassociated rows from
  // the maintenance lane. This lets a busy period converge even when more
  // than 30% of a batch belongs to newly eligible outcomes; both queries stay
  // explicitly bounded and the merged result remains de-duplicated below.
  const recentLimit = liveLimit
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
  const unassociated = `NOT EXISTS (SELECT 1 FROM period_review_sources prs
      JOIN period_review_cases cases ON cases.id = prs.period_case_id
      WHERE prs.outcome_id = so.id AND cases.period_type = 'daily' AND cases.status <> 'superseded')`
  // Select candidate IDs separately from outcome rows.  This keeps the
  // policy lane compatible with MySQL versions without window functions and,
  // more importantly, lets us greedily reserve only whole cases that fit the
  // maintenance budget.  A case larger than the remaining budget is deferred
  // rather than returned partially.
  const policyCandidateRows = policyUpgradeLimit > 0 ? await queryAll(`SELECT policy_case.id AS period_case_id,
      policy_case.updated_at AS period_case_updated_at,
      COUNT(policy_source.outcome_id) AS outcome_count
    FROM period_review_cases policy_case
    JOIN period_review_sources policy_source ON policy_source.period_case_id = policy_case.id
    JOIN signal_outcomes policy_outcome ON policy_outcome.id = policy_source.outcome_id
    JOIN users policy_user ON policy_user.id = policy_outcome.user_id
    JOIN trading_accounts policy_account ON policy_account.id = policy_outcome.trading_account_id
      AND policy_account.user_id = policy_outcome.user_id
    JOIN inference_snapshots policy_snapshot ON policy_snapshot.id = (
      SELECT MAX(policy_snapshot_latest.id) FROM inference_snapshots policy_snapshot_latest
      WHERE policy_snapshot_latest.signal_id = policy_outcome.signal_id)
    WHERE policy_case.period_type = 'daily' AND policy_case.status <> 'superseded'
      AND policy_case.current_version_id IS NULL
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(policy_case.evidence_json), policy_case.evidence_json, '{}'),
        '$.period_market.source_policy_version')), '') <> '${PERIOD_MARKET_SOURCE_POLICY_VERSION}'
      AND policy_outcome.status = 'closed' AND policy_outcome.review_eligible_at IS NOT NULL
      AND ((policy_snapshot.strategy_scope = 'private' AND NOT ${platformAiContentManagerSql('policy_user')})
        OR (policy_snapshot.strategy_scope = 'platform' AND ${platformAiContentManagerSql('policy_user')}))
      AND NOT EXISTS (SELECT 1 FROM period_review_jobs candidate_active_job
        WHERE candidate_active_job.period_case_id = policy_case.id
          AND candidate_active_job.job_type = 'daily_review' AND candidate_active_job.job_slot = 0
          AND candidate_active_job.status IN ('leased','status_unknown'))
    GROUP BY policy_case.id, policy_case.updated_at
    HAVING COUNT(policy_source.outcome_id) <= ?
    ORDER BY policy_case.updated_at ASC, policy_case.id ASC LIMIT ?`, [backlogLimit, policyUpgradeLimit]) : []
  const selectedPolicyCaseIds = selectWholePolicyUpgradeCaseIds(policyCandidateRows, backlogLimit, policyUpgradeLimit)
  // Historical recovery continues to use ORDER BY so.review_eligible_at ASC, so.id ASC;
  // policy candidates above are selected with the same oldest-first ordering.
  const policyUpgradeCondition = selectedPolicyCaseIds.length ? `EXISTS (SELECT 1 FROM period_review_sources policy_source
      JOIN period_review_cases policy_case ON policy_case.id = policy_source.period_case_id
      WHERE policy_source.outcome_id = so.id AND policy_case.period_type = 'daily'
        AND policy_case.status <> 'superseded' AND policy_case.current_version_id IS NULL
        AND policy_case.id IN (${selectedPolicyCaseIds.join(',')})
        AND NOT EXISTS (SELECT 1 FROM period_review_jobs active_policy_job
          WHERE active_policy_job.period_case_id = policy_case.id AND active_policy_job.job_type = 'daily_review'
            AND active_policy_job.job_slot = 0 AND active_policy_job.status IN ('leased','status_unknown')))` : 'FALSE'
  const [backlog, recent, recovery] = await Promise.all([
    // Only associated, incomplete evidence belongs to the maintenance lane.
    // Unassociated historical outcomes are intentionally excluded here: the
    // recent lane below gives new source rows a bounded, deterministic path to
    // first creation without allowing an old backlog to occupy every batch.
    backlogLimit > 0 ? queryAll(`${select} WHERE ${eligible} AND (${policyUpgradeCondition} OR EXISTS (SELECT 1 FROM period_review_sources prs
        JOIN period_review_cases cases ON cases.id = prs.period_case_id
        WHERE prs.outcome_id = so.id AND cases.period_type = 'daily' AND cases.evidence_status <> 'complete'
          AND NOT EXISTS (SELECT 1 FROM period_review_jobs active_backlog_job
            WHERE active_backlog_job.period_case_id = cases.id AND active_backlog_job.job_type = 'daily_review'
              AND active_backlog_job.job_slot = 0 AND active_backlog_job.status IN ('leased','status_unknown'))
          AND (EXISTS (SELECT 1 FROM period_review_jobs evidence_retry_job
                WHERE evidence_retry_job.period_case_id = cases.id
                  AND evidence_retry_job.job_type = 'daily_review' AND evidence_retry_job.job_slot = 0
                  AND evidence_retry_job.status = 'queued'
                  AND (evidence_retry_job.next_attempt_at IS NULL OR evidence_retry_job.next_attempt_at <= NOW())
                  AND evidence_retry_job.last_error_code = '${DAILY_EVIDENCE_RETRY_ERROR}'
              )
            OR (EXISTS (SELECT 1 FROM period_review_jobs legacy_evidence_job
                WHERE legacy_evidence_job.period_case_id = cases.id
                  AND legacy_evidence_job.job_type = 'daily_review' AND legacy_evidence_job.job_slot = 0
                  AND legacy_evidence_job.status = 'skipped'
                  AND legacy_evidence_job.lease_token IS NULL
                  AND (legacy_evidence_job.last_error_code IS NULL
                    OR legacy_evidence_job.last_error_code IN (${DAILY_EVIDENCE_RETRY_SQL_ALLOWLIST}))
              ) AND cases.evidence_reason IN (${DAILY_EVIDENCE_RETRY_SQL_ALLOWLIST}))
            OR cases.updated_at <= DATE_SUB(NOW(), INTERVAL 1 HOUR)
            OR EXISTS (SELECT 1 FROM period_review_sources upgrade_source
              JOIN trade_review_cases upgrade_trade ON upgrade_trade.id = upgrade_source.trade_review_case_id
              WHERE upgrade_source.period_case_id = cases.id
                AND upgrade_trade.path_evidence_reason = 'holding_path_bar_boundary_insufficient'))
          AND COALESCE(cases.evidence_reason, '') NOT IN ('inference_snapshot_incomplete','historical_prompt_missing')))
      ORDER BY CASE WHEN ${policyUpgradeCondition} THEN 0 ELSE 1 END, so.review_eligible_at ASC, so.id ASC LIMIT ?`, [backlogLimit]) : Promise.resolve([]),
    // Live lane stays newest-first so an opt-in historical recovery cannot
    // starve the current creation window.
    queryAll(`${select} WHERE ${eligible} AND ${unassociated}
      ORDER BY so.review_eligible_at DESC, so.id DESC LIMIT ?`, [recentLimit]),
    // Historical fairness is a separate, explicitly enabled lane. It walks
    // oldest-first while the live lane above continues to create today's case.
    includeHistoricalRecovery && recoveryLimit > 0 ? queryAll(`${select} WHERE ${eligible} AND ${unassociated}
      ORDER BY so.review_eligible_at ASC, so.id ASC LIMIT ?`, [recoveryLimit]) : Promise.resolve([]),
  ])
  const merged = new Map()
  for (const row of [...(backlog || []), ...(recent || []), ...(recovery || [])]) merged.set(Number(row.id), row)
  const observerClock = await getDefaultObserverSourceClock().catch(() => null)
  return [...merged.values()].slice(0, batchLimit).map(row => {
    const clock = applyDefaultObserverClockBootstrap({
      broker_server:row.broker_server,
      timezone_offset_minutes:row.timezone_offset_minutes,
      clock_status:row.clock_status,
    }, observerClock)
    return { ...row, timezone_offset_minutes:clock.timezone_offset_minutes ?? null,
      clock_status:clock.clock_status || 'unknown' }
    })
}

/**
 * Select only complete policy-upgrade cases for one maintenance batch.  The
 * database candidate query is already oldest-first and capped by case count;
 * this final deterministic pass reserves outcome capacity so an oversized
 * case is deferred instead of being returned partially.
 */
export function selectWholePolicyUpgradeCaseIds(rows = [], backlogLimit = 0, maxCases = DAILY_REVIEW_POLICY_UPGRADE_LIMIT) {
  const budget = Math.max(0, Math.trunc(Number(backlogLimit) || 0))
  const caseLimit = Math.max(0, Math.trunc(Number(maxCases) || 0))
  const selected = []
  let used = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (selected.length >= caseLimit) break
    const caseId = Number(row?.period_case_id)
    const outcomeCount = Number(row?.outcome_count)
    if (!Number.isSafeInteger(caseId) || caseId <= 0 || !Number.isSafeInteger(outcomeCount) || outcomeCount <= 0) continue
    if (used + outcomeCount > budget) continue
    selected.push(caseId)
    used += outcomeCount
  }
  return selected
}

async function prepareTradeEvidence(outcome) {
  const reviewCase = await ensureReviewCaseForOutcome(outcome.id, { queueGeneration:false })
  if (reviewCase?.skipped) return { status: 'ineligible', reason: reviewCase.reason, reviewCase: null, evidence: null }
  const loaded = await queryOne('SELECT * FROM trade_review_cases WHERE id = ?', [reviewCase.id])
  return { status: loaded?.evidence_status || 'incomplete', reason: loaded?.evidence_reason || null, reviewCase: loaded, evidence: parse(loaded?.evidence_json, null) }
}

function clipReviewText(value, maxBytes = DAILY_REVIEW_PRE_TRADE_TEXT_MAX_BYTES) {
  const text = String(value ?? '')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const marker = '\n…[中间内容已按复盘输入预算压缩]…\n'
  const available = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  const take = (input, budget, fromEnd = false) => {
    const chars = Array.from(input)
    const selected = []
    let used = 0
    const source = fromEnd ? chars.reverse() : chars
    for (const char of source) {
      const size = Buffer.byteLength(char, 'utf8')
      if (used + size > budget) break
      selected.push(char); used += size
    }
    return fromEnd ? selected.reverse().join('') : selected.join('')
  }
  const headBudget = Math.floor(available * 0.6)
  return `${take(text, headBudget)}${marker}${take(text, available - headBudget, true)}`
}

function compactReviewValue(value, { maxBytes = DAILY_REVIEW_PRE_TRADE_TEXT_MAX_BYTES,
  maxArrayItems = 32, maxDepth = 4 } = {}, depth = 0) {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return clipReviewText(value, maxBytes)
  if (depth >= maxDepth) return typeof value === 'object' ? '[已省略嵌套字段]' : String(value)
  if (Array.isArray(value)) return value.slice(-maxArrayItems).map(item => compactReviewValue(item,
    { maxBytes:Math.max(256, Math.floor(maxBytes / 2)), maxArrayItems:Math.min(16, maxArrayItems), maxDepth }, depth + 1))
  if (typeof value !== 'object') return String(value)
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    // These fields are either full prompt payloads or repeat the candle body
    // that is projected separately. They must never leak into a model chunk.
    if (['system_prompt', 'user_prompt', 'klines', 'market_snapshot', 'market_data_snapshot',
      'full_period_candles', 'post_trade_klines', 'source_identity', 'source_key', 'source_id',
      'account_login', 'account_id', 'trading_account_id', 'broker_server', 'broker_server_name'].includes(String(key))) continue
    result[key] = compactReviewValue(item, {
      maxBytes:Math.max(256, Math.floor(maxBytes / 2)), maxArrayItems, maxDepth,
    }, depth + 1)
  }
  return result
}

function compactReviewOrder(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) return order || null
  const allowed = ['symbol', 'order_type', 'entry_method', 'direction', 'volume', 'price', 'limit_price',
    'stop_limit_price', 'sl', 'tp', 'stop_loss_price', 'take_profit_1_price', 'take_profit_2_price',
    'take_profit_3_price', 'pending_valid_until', 'position_size_tier', 'position_size_factor',
    'risk_amount', 'status', 'reason', 'magic']
  return Object.fromEntries(allowed.filter(key => Object.prototype.hasOwnProperty.call(order, key))
    .map(key => [key, typeof order[key] === 'string' ? clipReviewText(order[key], 2000) : order[key]]))
}

function compactReviewSignal(signal) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return signal || null
  const allowed = ['id', 'signal_id', 'symbol', 'timeframe', 'signal_type', 'direction', 'confidence',
    'analysis', 'reasoning', 'entry_method', 'limit_price', 'stop_limit_price', 'stop_loss_price',
    'take_profit_1_price', 'take_profit_2_price', 'take_profit_3_price', 'recommended_take_profit_tier',
    'recommended_volume', 'position_size_tier', 'position_size_reason', 'created_at', 'created_at_msc', 'created_at_utc_msc',
    'strategy_id', 'strategy_version', 'strategy_scope']
  return Object.fromEntries(allowed.filter(key => Object.prototype.hasOwnProperty.call(signal, key))
    .map(key => [key, typeof signal[key] === 'string' ? clipReviewText(signal[key]) : signal[key]]))
}

function compactLocalReviewKlines(klines, limit = DAILY_REVIEW_LOCAL_KLINE_LIMIT) {
  if (!Array.isArray(klines)) return []
  const allowed = ['time', 'time_msc', 'time_utc_msc', 'time_utc_ms', 'time_server_msc', 'open', 'high', 'low', 'close',
    'volume', 'tick_volume', 'real_volume', 'spread']
  const boundedLimit = Math.max(1, Math.trunc(Number(limit) || DAILY_REVIEW_LOCAL_KLINE_LIMIT))
  return klines.slice(-boundedLimit)
    .map(item => item && typeof item === 'object'
      ? Object.fromEntries(allowed.filter(key => Object.prototype.hasOwnProperty.call(item, key)).map(key => [key, item[key]]))
      : item)
}

function compactReviewMarketSnapshot(snapshot = {}, supplementalKlines = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const context = snapshot.strategy_context && typeof snapshot.strategy_context === 'object'
    ? snapshot.strategy_context : {}
  const sourceFrames = context.timeframes && typeof context.timeframes === 'object' ? context.timeframes : {}
  // Some inference loaders put candles inside market_snapshot while others
  // attach them to the frozen snapshot (or pass them separately).  Merge all
  // three bounded sources so a loader returning an empty supplemental object
  // cannot accidentally hide the candles that were already frozen.
  const embeddedKlines = snapshot.klines && typeof snapshot.klines === 'object' && !Array.isArray(snapshot.klines)
    ? snapshot.klines : {}
  const extraKlines = supplementalKlines && typeof supplementalKlines === 'object' && !Array.isArray(supplementalKlines)
    ? supplementalKlines : {}
  const rawKlines = { ...embeddedKlines, ...extraKlines }
  const timeframes = Object.fromEntries(Object.entries(sourceFrames).map(([timeframe, frame]) => {
    const value = frame && typeof frame === 'object' ? frame : {}
    const summary = value.summary || value.indicators || value.technical_indicators || null
    const localKlines = value.klines || rawKlines[timeframe] || rawKlines[String(timeframe).toUpperCase()]
    return [timeframe, { summary:compactReviewValue(summary, { maxBytes:12000, maxArrayItems:24, maxDepth:4 }),
      structure:compactReviewValue(value.structure || value.chan || null, { maxBytes:8000, maxArrayItems:16, maxDepth:4 }),
      latest_price:value.latest_price ?? value.current_price ?? null,
      closed_bar_time_utc_msc:value.closed_bar_time_utc_msc ?? null,
      local_klines:compactLocalReviewKlines(localKlines) }]
  }))
  return { symbol:snapshot.symbol || null, timeframe:snapshot.timeframe || null,
    latest_price:snapshot.latest_price ?? snapshot.current_price ?? null,
    as_of:snapshot.as_of || snapshot.closed_bar_time_utc_msc || null,
    timeframes }
}

function compactReviewStrategyRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') return runtime || null
  const allowed = ['mode', 'strategy_id', 'strategy_version', 'version', 'policy_version', 'policy_hash',
    'strategy_policy_json', 'policy', 'rules', 'entry_rules', 'risk_rules', 'exit_rules', 'timeframes',
    'indicators', 'use_chan_analysis', 'chan_timeframes']
  const value = Object.fromEntries(allowed.filter(key => Object.prototype.hasOwnProperty.call(runtime, key))
    .map(key => [key, compactReviewValue(runtime[key], { maxBytes:18000, maxArrayItems:32, maxDepth:5 })]))
  return value
}

function compactReviewStrategyMemory(library) {
  if (!library || typeof library !== 'object') return library || null
  return { version_no:Number(library.version_no || 0), content_hash:library.content_hash || null,
    char_count:Number(library.char_count || 0), estimated_token_count:Number(library.estimated_token_count || 0),
    content_text:clipReviewText(library.content_text || '', DAILY_REVIEW_MEMORY_TEXT_MAX_BYTES) }
}

function compactReviewDeals(deals) {
  if (!Array.isArray(deals)) return []
  const allowed = ['deal_id', 'ticket', 'order_ticket', 'position_ticket', 'type', 'entry', 'price', 'volume',
    'profit', 'commission', 'swap', 'time', 'time_msc', 'time_utc_msc', 'reason']
  return deals.slice(-100).map(deal => deal && typeof deal === 'object'
    ? Object.fromEntries(allowed.filter(key => Object.prototype.hasOwnProperty.call(deal, key)).map(key => [key, deal[key]]))
    : deal)
}

function compactReviewPostTrade(postTrade = {}) {
  if (!postTrade || typeof postTrade !== 'object') return {}
  return { outcome:compactReviewValue(postTrade.outcome, { maxBytes:16000, maxArrayItems:32, maxDepth:4 }),
    execution:compactReviewValue(postTrade.execution, { maxBytes:12000, maxArrayItems:32, maxDepth:4 }),
    deals:compactReviewDeals(postTrade.deals),
    path_metrics:compactReviewValue(postTrade.path_metrics, { maxBytes:10000, maxArrayItems:24, maxDepth:4 }),
    post_trade_structure:compactReviewValue(postTrade.post_trade_structure, { maxBytes:16000, maxArrayItems:24, maxDepth:4 }),
    path_evidence:compactReviewValue(postTrade.path_evidence, { maxBytes:12000, maxArrayItems:24, maxDepth:4 }) }
}

function compactReviewEvidenceRefs(refs) {
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return {}
  return Object.fromEntries(Object.entries(refs).slice(0, 24).map(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [key, typeof value === 'string' ? clipReviewText(value, 512) : value]
    return [key, Object.fromEntries(['id', 'hash', 'outcome_id', 'case_id', 'version_id']
      .filter(field => Object.prototype.hasOwnProperty.call(value, field))
      .map(field => [field, value[field]]))]
  }))
}

function isCompactPeriodTradeEvidence(evidence) {
  return Boolean(evidence && typeof evidence === 'object'
    && evidence.inference_time && typeof evidence.inference_time === 'object'
    && evidence.inference_time.pre_trade_frozen
    && !evidence.inference_time.snapshot)
}

/**
 * Build the bounded pre-trade projection sent to the daily review model.
 * Full prompts, runtime snapshots and all raw candles remain in the frozen
 * inference snapshot; this projection keeps only the signal rationale,
 * strategy rules/version, indicator summaries, local candles and order/risk
 * facts needed to assess the original decision.
 */
export function compactPreTradeReviewEvidence(inference = {}) {
  const snapshot = inference?.snapshot || {}
  const snapshotRef = { id:snapshot.id || null, strategy_id:snapshot.strategy_id || null,
    strategy_version:snapshot.strategy_version || null, strategy_scope:snapshot.strategy_scope || null,
    prompt_hash:snapshot.prompt_hash || null, model_profile_id:snapshot.model_profile_id || null,
    provider:snapshot.provider || null, model_name:snapshot.model_name || null,
    content_hash:snapshot.content_hash || null }
  const signal = compactReviewSignal(inference.signal)
  const snapshotKlines = {
    ...(snapshot.klines && typeof snapshot.klines === 'object' && !Array.isArray(snapshot.klines) ? snapshot.klines : {}),
    ...(inference.klines && typeof inference.klines === 'object' && !Array.isArray(inference.klines) ? inference.klines : {}),
  }
  return { signal, snapshot_ref:snapshotRef,
    strategy_runtime:compactReviewStrategyRuntime(snapshot.strategy_runtime),
    market_snapshot:compactReviewMarketSnapshot(snapshot.market_snapshot || {}, snapshotKlines),
    risk_decision:compactReviewValue(inference.risk_decision, { maxBytes:12000, maxArrayItems:32, maxDepth:4 }),
    original_order:compactReviewOrder(inference.original_order),
    approved_order:compactReviewOrder(inference.approved_order),
    cutoff_utc_msc:Number(inference.signal?.created_at_utc_msc || inference.signal?.created_at_msc || 0) || null }
}

export function compactPeriodTradeEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  if (isCompactPeriodTradeEvidence(evidence)) return evidence
  const inference = evidence.inference_time || {}
  const snapshotRef = compactPreTradeReviewEvidence(inference).snapshot_ref
  const postTrade = evidence.post_trade || {}
  const preTradeFrozen = compactPreTradeReviewEvidence(inference)
  let compact = {
    schema_version:evidence.schema_version,
    inference_time:{
      signal:preTradeFrozen.signal,
      snapshot_ref:snapshotRef,
      pre_trade_frozen:preTradeFrozen,
      risk_decision:preTradeFrozen.risk_decision, original_order:preTradeFrozen.original_order,
      approved_order:preTradeFrozen.approved_order,
    },
    post_trade:compactReviewPostTrade(postTrade),
    evidence_refs:compactReviewEvidenceRefs(evidence.evidence_refs),
  }
  const compactBytes = () => Buffer.byteLength(JSON.stringify(compact), 'utf8')
  if (compactBytes() <= DAILY_REVIEW_CHUNK_MAX_BYTES) return compact

  // A malformed/legacy trade can still contain many individually valid but
  // collectively oversized fields.  Compress the lower-priority narrative
  // again before chunk planning; the original frozen evidence remains in the
  // database for audit and can be retried after an explicit failure.
  const reducedPreTrade = {
    signal:compactReviewValue(preTradeFrozen.signal, { maxBytes:4000, maxArrayItems:8, maxDepth:3 }),
    snapshot_ref:snapshotRef,
    strategy_runtime:compactReviewValue(preTradeFrozen.strategy_runtime, { maxBytes:5000, maxArrayItems:8, maxDepth:3 }),
    market_snapshot:compactReviewValue(preTradeFrozen.market_snapshot, { maxBytes:5000, maxArrayItems:8, maxDepth:3 }),
    risk_decision:compactReviewValue(preTradeFrozen.risk_decision, { maxBytes:4000, maxArrayItems:8, maxDepth:3 }),
    original_order:compactReviewOrder(preTradeFrozen.original_order),
    approved_order:compactReviewOrder(preTradeFrozen.approved_order),
    cutoff_utc_msc:preTradeFrozen.cutoff_utc_msc || null,
  }
  compact = {
    schema_version:evidence.schema_version,
    inference_time:{ signal:reducedPreTrade.signal, snapshot_ref:snapshotRef,
      pre_trade_frozen:reducedPreTrade, risk_decision:reducedPreTrade.risk_decision,
      original_order:reducedPreTrade.original_order, approved_order:reducedPreTrade.approved_order },
    post_trade:{ outcome:compactReviewValue(postTrade.outcome, { maxBytes:6000, maxArrayItems:12, maxDepth:3 }),
      execution:compactReviewValue(postTrade.execution, { maxBytes:4000, maxArrayItems:12, maxDepth:3 }),
      deals:compactReviewDeals(postTrade.deals).slice(-24),
      path_metrics:compactReviewValue(postTrade.path_metrics, { maxBytes:5000, maxArrayItems:12, maxDepth:3 }),
      post_trade_structure:compactReviewValue(postTrade.post_trade_structure, { maxBytes:5000, maxArrayItems:12, maxDepth:3 }),
      path_evidence:compactReviewValue(postTrade.path_evidence, { maxBytes:4000, maxArrayItems:12, maxDepth:3 }) },
    evidence_refs:compactReviewEvidenceRefs(evidence.evidence_refs),
  }
  if (compactBytes() > DAILY_REVIEW_CHUNK_MAX_BYTES) {
    const error = new Error('period_review_input_budget_exceeded')
    error.code = error.message
    error.reason = 'period_review_trade_evidence_too_large'
    error.requestBytes = compactBytes()
    error.maxBytes = DAILY_REVIEW_CHUNK_MAX_BYTES
    throw error
  }
  return compact
}

async function upsertDailyGroup(group, clock, asOfUtcMs = Date.now(), {
  allowMissedWindowRecovery = false,
  recoveryGraceMinutes = DAILY_MISSED_WINDOW_RECOVERY_GRACE_MINUTES,
} = {}) {
  const existingCase = await queryOne(`SELECT * FROM period_review_cases WHERE period_type = 'daily' AND period_key = ?
    AND user_id = ? AND trading_account_id = ? AND strategy_id = ?
    ORDER BY CASE WHEN status = 'approved' THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT 1`,
  [group.periodKey, group.userId, group.tradingAccountId, group.strategyId])
  const creationWindow = periodReviewCreationWindowState('daily', group.endUtcMs, asOfUtcMs)
  // Look up the case first so an existing review can always be maintained;
  // only a genuinely new case is subject to the first-creation window.
  const recoveryGraceUtcMs = Math.max(0, Number(recoveryGraceMinutes) || 0) * 60000
  const recoveryAllowed = !existingCase && allowMissedWindowRecovery && creationWindow.state === 'after'
    && Number(asOfUtcMs) >= creationWindow.windowEndUtcMs + recoveryGraceUtcMs
  if (!existingCase && creationWindow.state !== 'within' && !recoveryAllowed) {
    return { id:null, periodKey:group.periodKey, complete:false, sourceCount:0,
      evidenceHash:null, skippedCreationWindow:true, creationWindowState:creationWindow.state,
      missedWindowRecoveryEligible:creationWindow.state === 'after' }
  }
  const existingMaintainedResult = value => ({ complete:existingCase?.evidence_status === 'complete', ...value,
    existingMaintained:true, creationWindowState:creationWindow.state })
  let existingSources = []
  let existingJob = null
  let needsPeriodMarketUpgrade = false
  if (existingCase) {
    group.strategyVersion = Number(existingCase.strategy_version || group.strategyVersion || 1)
    existingSources = await queryAll(`SELECT source.outcome_id, source.source_hash,
      review_case.evidence_hash AS current_evidence_hash, review_case.updated_at AS current_evidence_updated_at
      FROM period_review_sources source
      LEFT JOIN trade_review_cases review_case ON review_case.id = source.trade_review_case_id
      WHERE source.period_case_id = ? ORDER BY source.outcome_id`, [existingCase.id])
    existingJob = await queryOne(`SELECT id, status, idempotency_key, attempt_count, max_attempts, last_error_code,
        next_attempt_at, evidence_retry_count, evidence_last_checked_at, completed_at FROM period_review_jobs
      WHERE period_case_id = ? AND job_type = 'daily_review' AND job_slot = 0 LIMIT 1`, [existingCase.id])
    // Never rewrite evidence or rotate the identity of a live provider task.
    // The candidate query also excludes these statuses, but this second guard
    // is required for a race between candidate selection and maintenance.
    if (existingJob && ['leased', 'status_unknown'].includes(String(existingJob.status || ''))) {
      return existingMaintainedResult({ id:Number(existingCase.id), periodKey:group.periodKey,
        complete:existingCase.evidence_status === 'complete', sourceCount:Number(existingCase.source_count || 0),
        evidenceHash:existingCase.evidence_hash, reused:true, refreshReason:'generation_in_progress' })
    }
    const activeRegeneration = existingCase.current_version_id
      ? await queryOne(`SELECT id, status FROM period_review_jobs
        WHERE period_case_id = ? AND job_type = 'daily_review' AND job_slot > 0
          AND status IN ('queued', 'leased', 'status_unknown') ORDER BY id DESC LIMIT 1`, [existingCase.id])
      : null
    if (activeRegeneration) return existingMaintainedResult({ id:Number(existingCase.id), periodKey:group.periodKey,
      complete:existingCase.evidence_status === 'complete', sourceCount:Number(existingCase.source_count || 0),
      evidenceHash:existingCase.evidence_hash, reused:true, refreshReason:'regeneration_in_progress' })
    await reconcilePersistedPeriodReviewState(existingCase, existingJob)
    const existingEvidence = parse(existingCase.evidence_json, {}) || {}
    needsPeriodMarketUpgrade = shouldUpgradePeriodMarketEvidence(existingCase, existingEvidence, asOfUtcMs)
    let refresh = shouldRefreshDailyReviewCase(existingCase, group, existingSources, asOfUtcMs, existingJob)
    const legacyRecoverableSkipped = existingJob?.status === 'skipped'
      && !existingCase.current_version_id && existingCase.evidence_status !== 'complete'
      && isRecoverableDailyEvidenceReason([existingCase.evidence_reason, existingJob.last_error_code].filter(Boolean).join(','))
      && String(existingJob.last_error_code || '').toLowerCase() !== DAILY_EVIDENCE_RETRY_DISABLED_ERROR
    if (legacyRecoverableSkipped) {
      // Older releases represented a temporary market gap as a completed
      // skipped job. Restore only that narrow, versionless state; do not touch
      // disabled/status-unknown/provider-owned jobs.
      const now = beijingNow()
      await queryRun(`UPDATE period_review_jobs SET status = 'queued', progress_stage = ?, stage_updated_at = ?,
          last_error_code = ?, model_task_id = NULL, lease_token = NULL, lease_expires_at = NULL,
          next_attempt_at = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'skipped' AND lease_token IS NULL`,
      [DAILY_EVIDENCE_RETRY_STAGE, now, DAILY_EVIDENCE_RETRY_ERROR, now, existingJob.id])
      existingJob.status = 'queued'
      existingJob.progress_stage = DAILY_EVIDENCE_RETRY_STAGE
      existingJob.last_error_code = DAILY_EVIDENCE_RETRY_ERROR
      existingJob.next_attempt_at = null
      refresh = { refresh:true, reason:'legacy_evidence_skipped_recovery' }
    }
    if (!refresh.refresh && !needsPeriodMarketUpgrade) {
      if (await recoverDailyQuotaFailure(existingCase, existingJob)) {
        return existingMaintainedResult({ id:Number(existingCase.id), periodKey:group.periodKey,
          complete:true, sourceCount:Number(existingCase.source_count || 0), evidenceHash:existingCase.evidence_hash,
          requeued:true, refreshReason:'provider_quota_recovery' })
      }
      return existingMaintainedResult({ id: Number(existingCase.id), periodKey: group.periodKey,
        complete: existingCase.evidence_status === 'complete', sourceCount: Number(existingCase.source_count || 0),
        evidenceHash: existingCase.evidence_hash, reused:true, refreshReason:refresh.reason })
    }
    if (existingJob?.status === 'skipped'
      && String(existingJob.last_error_code || '').toLowerCase() === DAILY_EVIDENCE_RETRY_DISABLED_ERROR) {
      return existingMaintainedResult({ id:Number(existingCase.id), periodKey:group.periodKey,
        complete:existingCase.evidence_status === 'complete', sourceCount:Number(existingCase.source_count || 0),
        evidenceHash:existingCase.evidence_hash, reused:true, refreshReason:'review_generation_disabled' })
    }
    if (existingJob && !existingCase.current_version_id && !needsPeriodMarketUpgrade && !refresh.refresh) return existingMaintainedResult({ id: Number(existingCase.id), periodKey: group.periodKey,
      complete: existingCase.evidence_status === 'complete', sourceCount: Number(existingCase.source_count || 0), evidenceHash: existingCase.evidence_hash })
    if (!existingJob && existingCase.evidence_status === 'incomplete' && isTerminalTradeEvidenceReason(existingCase.evidence_reason) && !refresh.refresh) {
      return existingMaintainedResult({ id: Number(existingCase.id), periodKey: group.periodKey,
        complete: false, sourceCount: Number(existingCase.source_count || 0), evidenceHash: existingCase.evidence_hash, terminal: true, reused: true })
    }
  }
  const policyUpgradeInProgress = Boolean(existingCase && needsPeriodMarketUpgrade && !existingCase.current_version_id)
  if (policyUpgradeInProgress) {
    await setPeriodReviewJobStage(existingJob, 'evidence_upgrade_started', 'info', 'evidence_upgrade_started', {
      source_policy_version:PERIOD_MARKET_SOURCE_POLICY_VERSION,
    })
  }
  const prepared = []
  for (const outcome of group.outcomes) prepared.push({ outcome, ...(await prepareTradeEvidence(outcome)) })
  const tradeEvidenceComplete = prepared.every(item => item.status === 'complete' && item.evidence)
  const reasons = [...new Set(prepared.flatMap(item => String(item.reason || '').split(',')).filter(Boolean))]
  const rawSources = prepared.map(item => ({ outcome_id: Number(item.outcome.id), trade_review_case_id: Number(item.reviewCase?.id || 0) || null,
    evidence_hash: item.reviewCase?.evidence_hash || null, evidence: item.evidence }))
  // Keep the full frozen trade snapshot available to the deterministic period
  // market collector (Chan requirement and source candidates are audit facts),
  // but persist only the compact projection in the period-case model input.
  const sources = rawSources.map(source => ({ ...source, evidence:compactPeriodTradeEvidence(source.evidence) }))
  const sourceIds = sources.map(item => item.outcome_id).sort((a, b) => a - b)
  const sourceHash = sha256(JSON.stringify(sources.map(item => [item.outcome_id, item.evidence_hash])))
  const evidence = {
    schema_version: 3,
    period: { type:'daily', key:group.periodKey, aggregation_basis:'fully_closed_at',
      timezone_offset_minutes:group.offsetMinutes, clock_status:clock.status,
      start_utc_msc:group.startUtcMs, end_utc_msc:group.endUtcMs },
    strategy: { id: group.strategyId, version: group.strategyVersion, versions:group.strategyVersions, scope: group.strategyScope,
      inference_system_prompt:prepared.find(item => item.evidence?.inference_time?.snapshot?.system_prompt)?.evidence?.inference_time?.snapshot?.system_prompt || null,
      prompt_hashes:[...new Set(prepared.map(item => item.evidence?.inference_time?.snapshot?.prompt_hash).filter(Boolean))] },
    statistics: dailyReviewStatistics(group.outcomes),
    sources,
  }
  try {
    evidence.period_market = await buildDailyPeriodMarketEvidence({ userId:group.userId, strategyId:group.strategyId,
      strategyScope:group.strategyScope, tradingAccountId:group.tradingAccountId,
      symbols:group.outcomes.map(item => item.symbol), startUtcMs:group.startUtcMs, endUtcMs:group.endUtcMs, sources:rawSources })
  } catch (error) {
    if (policyUpgradeInProgress) await setPeriodReviewJobStage(existingJob, 'evidence_upgrade_failed', 'error', 'evidence_upgrade_failed', {
      error:safeError(error), source_policy_version:PERIOD_MARKET_SOURCE_POLICY_VERSION,
    })
    throw error
  }
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
  let requeued = false
  let refreshedJob = null
  if (!periodCase.current_version_id) {
    if (complete) {
      await queryRun(`INSERT IGNORE INTO period_review_jobs
        (period_case_id, job_type, job_slot, idempotency_key, status, progress_stage, attempt_count, max_attempts,
         evidence_retry_count, created_at, updated_at)
        VALUES (?, 'daily_review', 0, ?, 'queued', 'queued', 0, 3, 0, ?, ?)`,
      [periodCase.id, `daily:${periodCase.id}:${evidenceHash}`, now, now])
      // For an existing draft, persist the new evidence first, then rotate the
      // business identity. The old task/checkpoint key can no longer be found
      // by dailyReviewTaskIdentity, so a later quota recovery cannot reuse it.
      if (existingCase && existingJob && String(existingCase.evidence_hash || '') !== String(evidenceHash || '')) {
        await refreshPeriodReviewJobForEvidence(queryRun, { periodType:'daily', periodCaseId:periodCase.id,
          evidenceHash, now, preserveQuotaFailure:isRecoverableDailyQuotaFailure(existingJob) })
        refreshedJob = await queryOne(`SELECT id, status, idempotency_key, attempt_count, max_attempts,
            last_error_code, next_attempt_at, evidence_retry_count, evidence_last_checked_at
          FROM period_review_jobs WHERE period_case_id = ? AND job_type = 'daily_review' AND job_slot = 0 LIMIT 1`, [periodCase.id])
        if (await recoverDailyQuotaFailure(periodCase, refreshedJob)) requeued = true
      }
    } else if (isRecoverableDailyEvidenceReason(reasons.join(','))) {
      // A recoverable market gap owns a durable queued job even before the
      // first model request. The daily worker's evidence_status=complete guard
      // keeps this job out of the provider path until the next preparation.
      const retry = await queueDailyEvidenceRetry(queryRun, { periodCaseId:periodCase.id,
        evidenceHash, existingJob, now })
      refreshedJob = { ...(existingJob || {}), id:retry.id, status:'queued', idempotency_key:retry.idempotencyKey,
        last_error_code:DAILY_EVIDENCE_RETRY_ERROR, next_attempt_at:retry.retryAt,
        evidence_retry_count:retry.retryCount }
    }
  }
  if (policyUpgradeInProgress) await setPeriodReviewJobStage(refreshedJob || existingJob, 'evidence_upgrade_succeeded', 'success', 'evidence_upgrade_succeeded', {
    source_policy_version:PERIOD_MARKET_SOURCE_POLICY_VERSION, evidence_hash:evidenceHash, complete,
  })
  return { id: Number(periodCase.id), periodKey: group.periodKey, complete, sourceCount: sourceIds.length, evidenceHash,
    ...(existingCase ? { existingMaintained:true } : { created:true,
      missedWindowRecovery:recoveryAllowed }), ...(requeued ? { requeued:true, refreshReason:'provider_quota_recovery' } : {}),
    creationWindowState:creationWindow.state }
}

export async function prepareEligibleDailyReviews({ limit = 500, asOfUtcMs = Date.now(),
  missedWindowRecovery = false,
  recoveryLimit = 0,
  recoveryGraceMinutes = DAILY_MISSED_WINDOW_RECOVERY_GRACE_MINUTES,
} = {}) {
  const boundedRecoveryLimit = Math.max(0, Math.min(DAILY_RECOVERY_LIMIT_MAX, Math.trunc(Number(recoveryLimit) || 0)))
  const boundedRecoveryGraceMinutes = Math.max(0, Math.min(DAILY_RECOVERY_GRACE_MAX_MINUTES,
    Math.trunc(Number(recoveryGraceMinutes) || DAILY_MISSED_WINDOW_RECOVERY_GRACE_MINUTES)))
  const recoveryEnabled = Boolean(missedWindowRecovery) && boundedRecoveryLimit > 0
  const rows = await eligibleOutcomeRows(limit, { includeHistoricalRecovery:recoveryEnabled })
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
    recoveryEnabled, recoveryRequested:boundedRecoveryLimit,
    recoveryCreated:0, recoverySkipped:0, clock:{ status:'per_account' } }
  const boundedGroupRecoveryLimit = Math.min(groups.length, boundedRecoveryLimit)
  let recoveryUsed = 0
  for (const group of groups) {
    const creationState = periodReviewCreationWindowState('daily', group.endUtcMs, asOfUtcMs).state
    const allowRecoveryForGroup = recoveryEnabled && creationState === 'after' && recoveryUsed < boundedGroupRecoveryLimit
    const prepared = await upsertDailyGroup(group, { status:group.clockStatus || 'account_terminal' }, asOfUtcMs, {
      allowMissedWindowRecovery:allowRecoveryForGroup, recoveryGraceMinutes:boundedRecoveryGraceMinutes,
    })
    if (prepared.skippedCreationWindow && prepared.creationWindowState === 'before') result.beforeCreationWindow += 1
    if (prepared.skippedCreationWindow && prepared.creationWindowState === 'after') result.outsideCreationWindow += 1
    if (prepared.created) result.created += 1
    if (prepared.missedWindowRecovery) { result.recoveryCreated += 1; recoveryUsed += 1 }
    if (prepared.missedWindowRecoveryEligible && !prepared.missedWindowRecovery) result.recoverySkipped += 1
    if (prepared.existingMaintained) result.existingMaintained += 1
    if (!prepared.skippedCreationWindow) result[prepared.complete ? 'ready' : 'incomplete'] += 1
  }
  result.recoveryUsed = recoveryUsed
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
    const activeRegeneration = existingCase.current_version_id
      ? await queryOne(`SELECT id, status FROM period_review_jobs
        WHERE period_case_id = ? AND job_type = 'monthly_review' AND job_slot > 0
          AND status IN ('queued', 'leased', 'status_unknown') ORDER BY id DESC LIMIT 1`, [existingCase.id])
      : null
    if (activeRegeneration) return existingMaintainedResult({ id:Number(existingCase.id), periodKey:group.periodKey,
      sourceCount:Number(existingCase.source_count || 0), evidenceHash:existingCase.evidence_hash,
      reused:true, refreshReason:'regeneration_in_progress' })
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
  const dailyCheckpointTask = ['daily_review_chunk', 'daily_review_merge'].includes(String(task?.task_kind || ''))
    let job = await queryOne(`SELECT jobs.id, jobs.status, jobs.job_slot, jobs.idempotency_key, jobs.period_case_id,
      cases.current_version_id, versions.content_hash AS result_hash
    FROM period_review_jobs jobs
    LEFT JOIN period_review_cases cases ON cases.id = jobs.period_case_id
    LEFT JOIN period_review_versions versions ON versions.id = cases.current_version_id
    WHERE jobs.model_task_id = ? LIMIT 1`, [task.task_id])
  // Daily v3 chunks and the final merge each have their own model task. Only
  // the first task is linked into the single legacy job.model_task_id column;
  // the generic task envelope's domain identity associates the remaining
  // tasks with the same durable review job without a schema change.
  if (!job && dailyCheckpointTask
    && task?.domain_type === 'period_review_job' && task?.domain_id != null) {
      job = await queryOne(`SELECT jobs.id, jobs.status, jobs.job_slot, jobs.idempotency_key, jobs.period_case_id,
        cases.current_version_id, versions.content_hash AS result_hash
      FROM period_review_jobs jobs
      LEFT JOIN period_review_cases cases ON cases.id = jobs.period_case_id
      LEFT JOIN period_review_versions versions ON versions.id = cases.current_version_id
      WHERE jobs.id = ? LIMIT 1`, [Number(task.domain_id)])
  }
  if (job) {
    if (dailyCheckpointTask) {
      const event = await queryOne(`SELECT payload_json FROM ai_model_task_events
        WHERE task_id = ? AND event_type = 'daily_review_checkpoint' ORDER BY id DESC LIMIT 1`, [task.task_id])
      const payload = parse(event?.payload_json, null)
      if (payload) {
        const content = payload.content
        const contentHash = content && typeof content === 'object' && !Array.isArray(content)
          ? sha256(JSON.stringify(content)) : null
        if (!contentHash || String(payload.content_hash || '') !== contentHash) {
          throw new Error('daily_review_checkpoint_content_hash_conflict')
        }
        const role = String(payload.role || '')
        const resultRef = role === 'chunk'
          ? `period_review_chunk:${job.period_case_id}:${Number(payload.chunk_index)}`
          : role === 'merge' ? `period_review_merge:${job.period_case_id}` : null
        if (!resultRef) throw new Error('daily_review_checkpoint_role_invalid')
        return { kind:'period_review_daily_checkpoint', job, succeeded:true,
          resultRef, resultHash:contentHash }
      }
    }
    const succeeded = job.status === 'succeeded' && Number(job.current_version_id) > 0 && Boolean(job.result_hash)
    return { kind:'period_review', job, succeeded, resultRef:succeeded ? `period_review_case:${job.period_case_id}` : null,
      resultHash:succeeded ? job.result_hash : null }
  }
    const checkpoint = await queryOne(`SELECT checkpoints.*, jobs.status AS parent_status, jobs.job_slot,
      jobs.idempotency_key, jobs.period_case_id, jobs.id AS period_review_job_id
    FROM period_review_monthly_checkpoints checkpoints
    JOIN period_review_jobs jobs ON jobs.id = checkpoints.period_review_job_id
    WHERE checkpoints.model_task_id = ? LIMIT 1`, [task.task_id])
  if (!checkpoint) return null
  const content = parseCheckpointContent(checkpoint)
  const succeeded = checkpoint.status === MONTHLY_REVIEW_CHECKPOINT_STATUSES.SUCCEEDED
    && Boolean(content) && Boolean(checkpoint.content_hash)
  return { kind:'monthly_review_chunk', checkpoint,
      job:{ id:Number(checkpoint.period_review_job_id), status:checkpoint.parent_status, job_slot:checkpoint.job_slot,
        idempotency_key:checkpoint.idempotency_key, period_case_id:Number(checkpoint.period_case_id) }, succeeded,
    resultRef:succeeded ? `period_review_monthly_checkpoint:${checkpoint.id}` : null,
    resultHash:succeeded ? checkpoint.content_hash : null }
}

async function transitionPeriodReviewModelBusiness({ action, task, business, reason }) {
  const jobId = Number(business?.job?.id || 0)
  if (!jobId) return
  const now = beijingNow()
  const regeneration = isPeriodReviewRegenerationJob(business?.job)
  const markRegenerationNeedsRevision = async () => {
    if (!regeneration) return
    await queryRun(`UPDATE period_review_cases SET status = 'needs_revision', updated_at = ?
      WHERE id = ? AND current_version_id IS NOT NULL`, [now, business.job.period_case_id])
  }
  const dailyTaskUsesDomainIdentity = ['daily_review_chunk', 'daily_review_merge'].includes(String(task?.task_kind || ''))
  const dailyJobWhere = dailyTaskUsesDomainIdentity ? 'id = ?' : 'id = ? AND model_task_id = ?'
  const dailyJobParams = dailyTaskUsesDomainIdentity ? [jobId] : [jobId, task.task_id]
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
      await markRegenerationNeedsRevision()
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
      await markRegenerationNeedsRevision()
    }
    return
  }
  if (action === 'requeued') {
    await queryRun(`UPDATE period_review_jobs SET status = 'queued', progress_stage = 'queued', stage_updated_at = ?,
      last_error_code = NULL, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE ${dailyJobWhere} AND status NOT IN ('succeeded','failed','skipped')`,
    [now, now, ...dailyJobParams])
    return
  }
  if (action === 'status_unknown') {
    await queryRun(`UPDATE period_review_jobs SET status = 'status_unknown', progress_stage = 'status_unknown', stage_updated_at = ?,
      last_error_code = 'provider_status_unknown', lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE ${dailyJobWhere} AND status NOT IN ('succeeded','failed','skipped')`,
    [now, now, ...dailyJobParams])
    await markRegenerationNeedsRevision()
    return
  }
  if (action === 'stale') {
    await queryRun(`UPDATE period_review_jobs SET status = 'failed', progress_stage = 'failed', stage_updated_at = ?,
      last_error_code = ?, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
      completed_at = ?, updated_at = ? WHERE ${dailyJobWhere}
      AND status NOT IN ('succeeded','failed','skipped')`,
    [now, String(reason || 'model_task_recovery_stale').slice(0, 128), now, now, ...dailyJobParams])
    await markRegenerationNeedsRevision()
  }
}

export async function recoverAbandonedPeriodReviewModelTasks({ nowUtcMs = Date.now(), limit = 100 } = {}) {
  return recoverAbandonedBusinessModelTasks({
    taskKinds:['daily_review', 'daily_review_chunk', 'daily_review_merge', 'monthly_review_chunk', 'monthly_review_merge'], nowUtcMs, limit,
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

async function startPeriodReviewModelTask(job, resolved, endpoint, evidence, taskKind, taskExtras = {}, {
  taskDeadlineAtUtcMs = null,
} = {}) {
  const modelTaskKind = String(taskExtras.model_task_kind || taskKind)
  const taskKeySuffix = String(taskExtras.task_key_suffix || '').trim()
  const idempotencyKey = periodReviewModelTaskIdempotencyKey({
    jobId:job.id, jobIdempotencyKey:job.idempotency_key, modelTaskKind, taskKeySuffix,
  })
  const tracker = await createModelTaskTracker({
    taskKind:modelTaskKind,
    queueClass:'background',
    ownerUserId:job.user_id,
    strategyId:job.strategy_id,
    domainType:'period_review_job',
    domainId:job.id,
    idempotencyKey,
    snapshotHash:job.evidence_hash || sha256(JSON.stringify(evidence)),
    inputHash:sha256(JSON.stringify({ evidence, task_extras:taskExtras })),
    provider:resolved.model.provider,
    model:resolved.model.model_name,
    modelProfileId:resolved.model_profile_id,
    protocol:endpoint.protocol,
    credentialSource:resolved.credential_source,
    frozenContext:buildPeriodReviewModelTaskFrozenContext(job, {
      period_case_id:Number(job.period_case_id), evidence_hash:job.evidence_hash,
      ...taskExtras,
    }),
    // Provider-capacity retries are tracked independently from the three
    // business generation attempts. A quota circuit normally prevents these
    // extra task attempts from reaching the provider at all.
    maxAttempts:['daily_review_chunk', 'daily_review_merge'].includes(modelTaskKind)
      ? Math.max(DAILY_REVIEW_MODEL_TASK_MAX_ATTEMPTS, Number(job.max_attempts) || 3)
      : Number(job.max_attempts) || 3,
    taskDeadlineAtUtcMs:taskDeadlineAtUtcMs || job._deadlineAtMs,
  }, {
    workerId:`period-review:${process.pid}`,
    linkTask:async taskId => {
      const result = await queryRun(`UPDATE period_review_jobs SET model_task_id = COALESCE(model_task_id, ?)
        WHERE id = ?`, [taskId, job.id])
      const affected = Number(result?.affectedRows ?? result?.changes)
      if (Number.isFinite(affected) && affected < 1) {
        const linked = await queryOne('SELECT model_task_id FROM period_review_jobs WHERE id = ? LIMIT 1', [job.id])
        const linkedTaskId = String(linked?.model_task_id || '')
        const independentDailyTask = ['daily_review_chunk', 'daily_review_merge'].includes(modelTaskKind)
        if (!linkedTaskId || (!independentDailyTask && linkedTaskId !== String(taskId))) {
          throw new Error('model_task_link_failed')
        }
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
    if (isPeriodReviewRegenerationJob(job)) await markPeriodReviewRegenerationNeedsRevision(job)
    return { status:'status_unknown', error:safeError(failure), modelTask }
  }
  const released = await releaseMonthlyReviewCheckpoint({ checkpointId:checkpoint.id, leaseToken:checkpoint.lease_token,
    fencingToken:checkpoint.fencing_token, status:MONTHLY_REVIEW_CHECKPOINT_STATUSES.FAILED,
    errorCode:safeError(failure), errorMessage:safeError(failure) })
  const parentStatus = released.retryable ? 'queued' : 'failed'
  await releaseMonthlyReviewParentAfterChunk(job, checkpoint, {
    status:parentStatus, nextAttemptAtUtcMs:released.nextAttemptAtUtcMs, errorCode:safeError(failure),
  })
  if (isPeriodReviewRegenerationJob(job)) await markPeriodReviewRegenerationNeedsRevision(job)
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
  const retryRawKey = [
    'monthly_review_chunk', Number(job.id), String(chunkEvidence.evidence_hash || job.evidence_hash || ''),
    Number(chunkEvidence.chunk_index), String(chunkEvidence.source_hash || ''),
    String(chunk.expected_ids_hash || chunk.expectedIdHash || ''), attemptNo,
  ].join(':')
  const retryIdempotencyKey = periodReviewModelTaskIdempotencyKey({
    rawKey:retryRawKey, jobId:job.id, modelTaskKind:'monthly_review_chunk',
  })
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
        AND ((jobs.status = 'queued' AND (jobs.next_attempt_at IS NULL OR jobs.next_attempt_at <= ?))
          OR (jobs.status = 'leased' AND jobs.lease_expires_at < ?))
        AND jobs.attempt_count < jobs.max_attempts AND cases.period_type = 'daily'
        AND cases.strategy_compatibility_hash IS NOT NULL AND cases.evidence_status = 'complete'
        AND ((jobs.job_slot = 0 AND cases.current_version_id IS NULL)
          OR (jobs.job_slot > 0 AND cases.current_version_id IS NOT NULL
            AND cases.status IN ('generating', 'needs_revision')))
      ORDER BY jobs.updated_at, jobs.id LIMIT 1 FOR UPDATE`, [beijingNow(), beijingNow()])
    if (!rows[0]) return null
    const token = crypto.randomUUID()
    await run(`UPDATE period_review_jobs SET status = 'leased', progress_stage = 'preparing', stage_updated_at = ?, lease_token = ?, lease_expires_at = ?, next_attempt_at = NULL,
      updated_at = ? WHERE id = ?`, [beijingNow(), token, afterSeconds(120), beijingNow(), rows[0].id])
    await run(`UPDATE period_review_cases SET status = 'generating', updated_at = ?
      WHERE id = ? AND ((? = 0 AND current_version_id IS NULL)
        OR (? > 0 AND current_version_id IS NOT NULL AND status IN ('generating', 'needs_revision')))`,
    [beijingNow(), rows[0].period_case_id, Number(rows[0].job_slot || 0), Number(rows[0].job_slot || 0)])
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
        estimated_token_count:strategyMemoryEstimatedTokenCount(job.memory_library_snapshot_text),
      },
    }
    return job._strategyMemorySnapshot
  }
  const snapshot = await getStrategyMemoryLibraryForRuntime({
    strategyId:job.strategy_id,
    actor:{ userId:job.user_id, role:job.user_role || 'user' },
  })
  const frozenSnapshot = {
    ...snapshot,
    library:{
      ...snapshot.library,
      estimated_token_count:strategyMemoryEstimatedTokenCount(snapshot.library?.content_text),
    },
  }
  const result = await queryRun(`UPDATE period_review_jobs
      SET memory_library_version_no = ?, memory_library_content_hash = ?,
          memory_library_snapshot_text = ?, memory_strategy_snapshot_text = ?, updated_at = ?
    WHERE id = ? AND memory_library_version_no IS NULL`,
  [frozenSnapshot.library.version_no, frozenSnapshot.library.content_hash, frozenSnapshot.library.content_text,
    frozenSnapshot.strategy_text || '', beijingNow(), job.id])
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
  job.memory_library_version_no = frozenSnapshot.library.version_no
  job.memory_library_content_hash = frozenSnapshot.library.content_hash
  job.memory_library_snapshot_text = frozenSnapshot.library.content_text
  job.memory_strategy_snapshot_text = frozenSnapshot.strategy_text || ''
  job._strategyMemorySnapshot = frozenSnapshot
  return frozenSnapshot
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
export const __testGetReviewStrategyMemorySnapshot = getReviewStrategyMemorySnapshot

function dailyOutcomeEvidenceLimitations(postTrade = {}) {
  const metrics = postTrade?.path_metrics && typeof postTrade.path_metrics === 'object'
    ? postTrade.path_metrics : {}
  if (String(metrics.status || '') !== 'not_observable'
    && String(metrics.metric_precision || '') !== 'not_observable') return []
  return [{
    scope:'holding_path',
    description:'持仓时间较短，没有完整闭合 K 线完全落在开仓和平仓之间，无法精确判断持仓内最大有利波动、最大不利波动及止盈止损触达。',
    unavailable_capabilities:['mfe_mae', 'target_touch', 'intrabar_sequence'],
  }]
}

/**
 * Preserve the deterministic market conclusions and provenance needed by the
 * model without replaying a full trading day's candle arrays in every chunk.
 * Raw candles remain frozen in period_review_cases.evidence_json for audit and
 * deterministic rebuilds; this is only the model-facing projection.
 */
export function compactDailyReviewPeriodMarket(periodMarket) {
  if (!periodMarket || typeof periodMarket !== 'object' || Array.isArray(periodMarket)) return periodMarket || null
  const symbols = periodMarket.symbols && typeof periodMarket.symbols === 'object'
    ? Object.fromEntries(Object.entries(periodMarket.symbols).map(([symbol, frames]) => [symbol,
      Object.fromEntries(Object.entries(frames || {}).map(([timeframe, frame]) => {
        const value = frame && typeof frame === 'object' ? frame : {}
        const coverage = value.coverage && typeof value.coverage === 'object' ? value.coverage : {}
        return [timeframe, {
          status:value.status || 'unavailable', reason:value.reason || null,
          candle_count:Number(value.candle_count || 0), expected_candle_count:Number(value.expected_candle_count || 0),
          first_time_utc_msc:value.first_time_utc_msc ?? null, last_time_utc_msc:value.last_time_utc_msc ?? null,
          summary:compactReviewValue(value.summary, { maxBytes:12000, maxArrayItems:24, maxDepth:4 }),
          coverage:{ endpoint_complete:coverage.endpoint_complete ?? null,
            internal_gap_count:Number(coverage.internal_gap_count || 0), max_gap_ms:Number(coverage.max_gap_ms || 0),
            continuity_status:coverage.continuity_status || null, continuity_reason:coverage.continuity_reason || null,
            continuity_policy_id:coverage.continuity_policy_id || null,
            continuity_policy_version:coverage.continuity_policy_version ?? null,
            continuity_policy_hash:coverage.continuity_policy_hash || null },
          source_provenance:(() => {
            const provenance = value.source_provenance || value.source_selection || {}
            return { policy_version:provenance.policy_version || value.source_policy_version || periodMarket.source_policy_version || null,
              selection_mode:provenance.selection_mode || value.source_selection_mode || null,
              selection_reason:provenance.selection_reason || value.source_selection_reason || null,
              source_changed:Boolean(provenance.source_changed ?? value.source_selection_changed) }
          })(),
        }]
      }))]))
    : {}
  return {
    schema_version:periodMarket.schema_version || null,
    digest_version:DAILY_REVIEW_MARKET_DIGEST_VERSION,
    source_policy_version:periodMarket.source_policy_version || null,
    status:periodMarket.status || 'unavailable', reason:periodMarket.reason || null,
    window_policy_version:periodMarket.window_policy_version || null,
    chan_requirement:compactReviewValue(periodMarket.chan_requirement, { maxBytes:4000, maxArrayItems:16, maxDepth:3 }),
    chan_evidence_status:periodMarket.chan_evidence_status || null,
    timeframes:compactReviewValue(periodMarket.timeframes, { maxBytes:6000, maxArrayItems:32, maxDepth:3 }),
    timeframes_by_outcome:compactReviewValue(periodMarket.timeframes_by_outcome, { maxBytes:8000, maxArrayItems:32, maxDepth:3 }),
    symbols,
  }
}

function buildDailyReviewV3ModelEvidence(evidence, strategyMemorySnapshot, strategyMemoryForPrompt) {
  const sources = Array.isArray(evidence?.sources) ? evidence.sources : []
  const preTradeFrozen = []
  const holdingPath = []
  const evidenceRefsByOutcome = new Map()
  const outcomeFacts = new Map()
  const evidenceLimitationsByOutcome = new Map()
  for (const source of sources) {
    const outcomeId = Number(source?.outcome_id)
    if (!Number.isSafeInteger(outcomeId) || outcomeId <= 0) continue
    // Older cases may still contain a raw frozen inference snapshot.  Apply
    // the same model boundary to those rows as to newly upgraded evidence;
    // a persisted case is an audit artifact, not permission to replay prompts
    // or an unbounded candle array to the provider.
    const tradeEvidence = compactPeriodTradeEvidence(source?.evidence || source) || {}
    const inference = tradeEvidence?.inference_time || {}
    const postTrade = tradeEvidence?.post_trade || {}
    const refs = dailyOutcomeEvidenceRefs(tradeEvidence, outcomeId)
    evidenceRefsByOutcome.set(outcomeId, refs)
    preTradeFrozen.push({ outcome_id:outcomeId,
      signal:inference.signal || null, snapshot_ref:inference.snapshot_ref || null,
      risk_decision:inference.risk_decision || null, original_order:inference.original_order || null,
      approved_order:inference.approved_order || null,
      ...(inference.pre_trade_frozen ? { ...inference.pre_trade_frozen } : {}),
    })
    holdingPath.push({ outcome_id:outcomeId, ...postTrade })
    evidenceLimitationsByOutcome.set(outcomeId, dailyOutcomeEvidenceLimitations(postTrade))
    if (postTrade.outcome && typeof postTrade.outcome === 'object') outcomeFacts.set(outcomeId, postTrade.outcome)
  }
  return {
    system_statistics:evidence?.statistics || {},
    pre_trade_frozen:preTradeFrozen,
    holding_path:holdingPath,
    period_market:compactDailyReviewPeriodMarket(evidence?.period_market),
    current_optimization_context:{
      strategy:clipReviewText(strategyMemorySnapshot?.strategy_text || '', DAILY_REVIEW_STRATEGY_TEXT_MAX_BYTES),
      strategy_memory_library:compactReviewStrategyMemory(strategyMemoryForPrompt),
      strategy_memory_version_no:Number(strategyMemorySnapshot?.library?.version_no || 0),
      strategy_memory_content_hash:strategyMemorySnapshot?.library?.content_hash || null,
    },
    outcomeFacts, evidenceRefsByOutcome, evidenceLimitationsByOutcome,
  }
}

export function buildDailyReviewChunkPlan(evidence, {
  maxOutcomes = DAILY_REVIEW_CHUNK_MAX_OUTCOMES,
  maxBytes = DAILY_REVIEW_CHUNK_MAX_BYTES,
  maxRequestBytes = DAILY_REVIEW_CHUNK_PLAN_MAX_BYTES,
  maxInputTokens = DAILY_REVIEW_CHUNK_PLAN_MAX_INPUT_TOKENS,
  measureChunk = null,
  contextHash = null,
} = {}) {
  const sources = (Array.isArray(evidence?.sources) ? evidence.sources : [])
    .slice().sort((left, right) => Number(left?.outcome_id) - Number(right?.outcome_id))
    .map(source => ({ outcome_id:Number(source?.outcome_id), evidence_hash:source?.evidence_hash || null,
      trade_review_case_id:source?.trade_review_case_id || null,
      evidence:compactPeriodTradeEvidence(source?.evidence || source) }))
  const outcomeIds = sources.map(source => Number(source?.outcome_id))
  if (!outcomeIds.length || outcomeIds.some(id => !Number.isSafeInteger(id) || id <= 0)
    || new Set(outcomeIds).size !== outcomeIds.length) throw new Error('daily_review_chunk_source_set_invalid')
  const outcomeLimit = Math.max(1, Math.trunc(Number(maxOutcomes) || DAILY_REVIEW_CHUNK_MAX_OUTCOMES))
  const byteLimit = Math.max(1024, Math.trunc(Number(maxBytes) || DAILY_REVIEW_CHUNK_MAX_BYTES))
  const requestByteLimit = Math.max(1024, Math.trunc(Number(maxRequestBytes) || DAILY_REVIEW_CHUNK_PLAN_MAX_BYTES))
  const tokenLimit = Math.max(1000, Math.trunc(Number(maxInputTokens) || DAILY_REVIEW_CHUNK_PLAN_MAX_INPUT_TOKENS))
  const chunks = []
  let current = []
  let currentBytes = 0
  let currentBudget = null
  const flush = () => {
    if (!current.length) return
    const ids = current.map(source => Number(source.outcome_id))
    const sourceHash = sha256(JSON.stringify(current.map(source => [Number(source.outcome_id), source.evidence_hash || null])))
    chunks.push({ chunk_index:chunks.length, outcome_ids:ids, sources:current,
      source_hash:sourceHash, expected_outcome_ids:ids,
      planned_request_bytes:Number(currentBudget?.requestBytes || 0) || null,
      planned_input_tokens:Number(currentBudget?.estimatedInputTokens || 0) || null })
    current = []
    currentBytes = 0
    currentBudget = null
  }
  for (const source of sources) {
    const sourceBytes = Buffer.byteLength(JSON.stringify(source), 'utf8')
    let candidate = [...current, source]
    let candidateBudget = typeof measureChunk === 'function' ? measureChunk(candidate) : null
    const candidateOverBudget = Boolean(candidateBudget && (Number(candidateBudget.requestBytes) > requestByteLimit
      || Number(candidateBudget.estimatedInputTokens) > tokenLimit))
    if (current.length && (current.length >= outcomeLimit || currentBytes + sourceBytes > byteLimit || candidateOverBudget)) {
      flush()
      candidate = [source]
      candidateBudget = typeof measureChunk === 'function' ? measureChunk(candidate) : null
    }
    if (!current.length && candidateBudget && (Number(candidateBudget.requestBytes) > DAILY_REVIEW_MODEL_MAX_BYTES
      || Number(candidateBudget.estimatedInputTokens) > DAILY_REVIEW_MODEL_MAX_INPUT_TOKENS)) {
      const error = new Error('period_review_input_budget_exceeded')
      error.code = error.message
      error.reason = 'period_review_single_trade_request_too_large'
      error.requestBytes = Number(candidateBudget.requestBytes || 0)
      error.estimatedInputTokens = Number(candidateBudget.estimatedInputTokens || 0)
      throw error
    }
    current.push(source)
    currentBytes += sourceBytes
    currentBudget = candidateBudget
  }
  flush()
  const expectedOutcomeIds = chunks.flatMap(chunk => chunk.outcome_ids)
  const sourceHash = sha256(JSON.stringify(expectedOutcomeIds))
  const planHash = sha256(JSON.stringify({ planning_version:DAILY_REVIEW_CHUNK_PLAN_VERSION,
    context_hash:contextHash || null, source_hash:sourceHash,
    chunks:chunks.map(chunk => ({ chunk_index:chunk.chunk_index, source_hash:chunk.source_hash, outcome_ids:chunk.outcome_ids })) }))
  return { source_hash:sourceHash, plan_hash:planHash, expected_outcome_ids:expectedOutcomeIds,
    planning_version:DAILY_REVIEW_CHUNK_PLAN_VERSION, context_hash:contextHash || null,
    chunk_count:chunks.length, chunks:chunks.map(chunk => ({ ...chunk, chunk_count:chunks.length,
      plan_hash:planHash })) }
}

function dailyReviewModelEvidenceForChunk(modelEvidence, chunk) {
  const ids = new Set((chunk?.outcome_ids || []).map(Number))
  return {
    system_statistics:modelEvidence.system_statistics || {},
    pre_trade_frozen:(modelEvidence.pre_trade_frozen || []).filter(item => ids.has(Number(item.outcome_id))),
    holding_path:(modelEvidence.holding_path || []).filter(item => ids.has(Number(item.outcome_id))),
    period_market:modelEvidence.period_market || null,
    outcomeFacts:new Map([...modelEvidence.outcomeFacts.entries()].filter(([id]) => ids.has(Number(id)))),
    evidenceRefsByOutcome:new Map([...modelEvidence.evidenceRefsByOutcome.entries()].filter(([id]) => ids.has(Number(id)))),
    evidenceLimitationsByOutcome:new Map([...modelEvidence.evidenceLimitationsByOutcome.entries()]
      .filter(([id]) => ids.has(Number(id)))),
  }
}

function dailyReviewDecisionQualityForChunks(contents) {
  // Any unresolvable source gap must remain visible at the day level instead
  // of being hidden behind a mixed aggregate from other trades.
  const rank = { good:0, mixed:1, poor:2, insufficient_evidence:3 }
  return contents.reduce((selected, content) => rank[content.decision_quality] > rank[selected]
    ? content.decision_quality : selected, 'good')
}

function mergeDailyReviewV3ChunkContents(contents, outcomeIds) {
  const assessments = contents.flatMap(content => content.trade_assessments || [])
  const byOutcome = new Map()
  for (const item of assessments) {
    const id = Number(item?.outcome_id)
    if (byOutcome.has(id)) throw new Error('daily_review_chunk_trade_duplicate')
    byOutcome.set(id, item)
  }
  const expected = new Set(outcomeIds.map(Number))
  if (byOutcome.size !== expected.size || [...expected].some(id => !byOutcome.has(id))) {
    throw new Error('daily_review_chunk_trade_coverage_incomplete')
  }
  const dedupe = values => {
    const seen = new Set()
    return values.filter(item => {
      const key = JSON.stringify(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const merged = {
    output_contract_version:DAILY_REVIEW_V3_CONTRACT,
    period_summary:contents.map((content, index) => `第${index + 1}分块：${content.period_summary}`).join('\n'),
    decision_quality:dailyReviewDecisionQualityForChunks(contents),
    trade_assessments:outcomeIds.map(id => byOutcome.get(Number(id))),
    repeated_issues:dedupe(contents.flatMap(content => content.repeated_issues || [])),
    strengths:dedupe(contents.flatMap(content => content.strengths || [])),
    risk_observations:dedupe(contents.flatMap(content => content.risk_observations || [])),
    next_day_actions:dedupe(contents.flatMap(content => content.next_day_actions || [])),
    experience_rules:dedupe(contents.flatMap(content => content.experience_rules || [])),
    strategy_conflicts:dedupe(contents.flatMap(content => content.strategy_conflicts || [])),
    confidence:Math.min(...contents.map(content => Number(content.confidence))),
  }
  const firstWithChan = contents.find(content => Array.isArray(content.chan_diagnoses))
  if (firstWithChan) {
    merged.chan_diagnoses = contents.flatMap(content => content.chan_diagnoses || [])
    const periodAssessments = contents.map(content => content.period_chan_assessment).filter(Boolean)
    const statusRank = { normal:0, insufficient_evidence:1, suspected_issue:2, confirmed_issue:3 }
    const representative = periodAssessments.reduce((selected, item) =>
      (statusRank[item.status] ?? -1) > (statusRank[selected.status] ?? -1) ? item : selected,
    firstWithChan.period_chan_assessment)
    merged.period_chan_assessment = {
      ...representative,
      explanation:[...new Set(periodAssessments.map(item => String(item.explanation || '').trim()).filter(Boolean))].join('；'),
      affected_outcome_ids:[...new Set(periodAssessments.flatMap(item => item.affected_outcome_ids || []).map(Number))],
      confidence:Math.min(...periodAssessments.map(item => Number(item.confidence))),
    }
  }
  return merged
}

function dailyReviewTaskIdentity(job, role, planHash, chunkIndex = null) {
  const normalizedRole = String(role || '').trim()
  if (!['chunk', 'merge'].includes(normalizedRole)) throw new Error('daily_review_task_role_invalid')
  const suffix = normalizedRole === 'chunk'
    ? `daily_review_chunk:${Number(chunkIndex)}:${String(planHash || '')}`
    : `daily_review_merge:${String(planHash || '')}`
  const taskKind = normalizedRole === 'chunk' ? 'daily_review_chunk' : 'daily_review_merge'
  return {
    taskKind,
    jobId:job.id,
    jobIdempotencyKey:job.idempotency_key,
    idempotencyKey:periodReviewModelTaskIdempotencyKey({
      jobId:job.id, jobIdempotencyKey:job.idempotency_key, modelTaskKind:taskKind, taskKeySuffix:suffix,
    }),
    taskKeySuffix:suffix,
  }
}

async function loadDailyReviewCheckpoint(taskIdentity, expectedPlanHash, expectedChunkIndex = null) {
  const idempotencyKey = taskIdentity?.jobId != null && Object.prototype.hasOwnProperty.call(taskIdentity, 'jobIdempotencyKey')
    ? periodReviewModelTaskIdempotencyKey({
      jobId:taskIdentity.jobId, jobIdempotencyKey:taskIdentity.jobIdempotencyKey,
      modelTaskKind:taskIdentity.taskKind, taskKeySuffix:taskIdentity.taskKeySuffix,
    })
    : taskIdentity?.idempotencyKey
  const task = await queryOne('SELECT task_id, status, result_hash FROM ai_model_tasks WHERE task_kind = ? AND idempotency_key = ? LIMIT 1',
    [taskIdentity.taskKind, idempotencyKey])
  if (!task || String(task.status) !== 'succeeded') return null
  const event = await queryOne(`SELECT payload_json FROM ai_model_task_events
    WHERE task_id = ? AND event_type = 'daily_review_checkpoint' ORDER BY id DESC LIMIT 1`, [task.task_id])
  const payload = parse(event?.payload_json, null)
  if (!payload || String(payload.plan_hash || '') !== String(expectedPlanHash || '')
    || (expectedChunkIndex != null && Number(payload.chunk_index) !== Number(expectedChunkIndex))) {
    throw new Error('daily_review_checkpoint_identity_conflict')
  }
  const content = payload.content
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('daily_review_checkpoint_content_missing')
  if (payload.content_hash && String(payload.content_hash) !== sha256(JSON.stringify(content))) {
    throw new Error('daily_review_checkpoint_content_hash_conflict')
  }
  if (task.result_hash && String(task.result_hash) !== String(payload.content_hash || '')) {
    throw new Error('daily_review_checkpoint_result_hash_conflict')
  }
  return { task, content }
}

async function persistDailyReviewCheckpoint(tracker, {
  role, planHash, chunkIndex = null, sourceHash = null, content,
}) {
  tracker.assertOwned()
  const contentHash = sha256(JSON.stringify(content))
  await appendModelTaskEvent(tracker.taskId, 'daily_review_checkpoint', {
    role, plan_hash:planHash, chunk_index:chunkIndex, source_hash:sourceHash,
    content_hash:contentHash, content,
  })
  return contentHash
}

async function persistPeriodReviewInputBudget(tracker, budget, metadata = {}) {
  if (!tracker?.taskId || !budget) return
  await appendModelTaskEvent(tracker.taskId, 'period_review_input_budget', {
    request_bytes:Number(budget.requestBytes || 0),
    estimated_input_tokens:Number(budget.estimatedInputTokens || 0),
    max_request_bytes:DAILY_REVIEW_MODEL_MAX_BYTES,
    max_input_tokens:DAILY_REVIEW_MODEL_MAX_INPUT_TOKENS,
    ...metadata,
  })
}

function normalizeDailyReviewMergeContent(input, outcomeIds, chanContext, conflictContext = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_daily_review_merge_content')
  if (input.output_contract_version !== DAILY_REVIEW_V3_CONTRACT) throw new Error('invalid_daily_v3_contract_version')
  const known = new Set(outcomeIds.map(Number))
  for (const key of ['repeated_issues', 'strengths', 'risk_observations', 'next_day_actions', 'experience_rules', 'strategy_conflicts']) {
    if (!Array.isArray(input[key])) throw new Error(`invalid_daily_review_merge_${key}`)
  }
  const periodSummary = boundedReviewText(input.period_summary, 'daily_review_merge_summary')
  const normalizedChanContext = normalizeReviewChanContext(chanContext)
  const chanAllowed = normalizedChanContext.mode === 'enabled_complete'
  const normalizedRules = normalizeExperienceRules(input.experience_rules, {
    allowedSourceRefs:new Set([...known].map(id => `outcome:${id}`)), chanMemoryAllowed:chanAllowed, knownOutcomeIds:known,
  })
  const strategyConflicts = normalizeStrategyConflicts(input, {
    allowedSourceRefs:new Set([...known].map(id => `outcome:${id}`)), requireSourceRefs:true,
    strategyText:conflictContext.strategyText, memoryText:conflictContext.memoryText,
    proposedExperiences:normalizedRules.map(rule => [rule.condition, rule.action, rule.prohibited_action].join('；')),
    requireExactProposedExcerpt:true,
  })
  return {
    output_contract_version:DAILY_REVIEW_V3_CONTRACT,
    period_summary:periodSummary,
    repeated_issues:normalizeV3ObservationArray(input.repeated_issues, 'repeated_issues', known, { requireTwoSources:true }),
    strengths:normalizeV3ObservationArray(input.strengths, 'strengths', known),
    risk_observations:normalizeV3TextArray(input.risk_observations, 'merge_risk_observations'),
    next_day_actions:normalizeV3TextArray(input.next_day_actions, 'merge_next_day_actions'),
    experience_rules:normalizedRules, strategy_conflicts:strategyConflicts,
    confidence:normalizeConfidence(input.confidence, 'daily_review_merge_confidence'),
  }
}

function normalizeDailyReviewV3MergeContent(input, outcomeIds, chanContext, conflictContext = {}) {
  const value = unwrapReviewContent(input, ['daily_review', 'review'])
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_daily_v3_contract_version')
  const declared = String(value.output_contract_version || value.contract_version || '').trim()
  if (declared && declared !== DAILY_REVIEW_V3_CONTRACT) throw new Error('invalid_daily_v3_contract_version')
  if (!declared && (Object.prototype.hasOwnProperty.call(value, 'daily_lessons')
    || Object.prototype.hasOwnProperty.call(value, 'memory_updates')
    || (!Object.prototype.hasOwnProperty.call(value, 'experience_rules')
      && !Object.prototype.hasOwnProperty.call(value, 'repeated_issues')))) {
    throw new Error('invalid_daily_v3_contract_version')
  }
  return normalizeDailyReviewMergeContent({ ...value, output_contract_version:DAILY_REVIEW_V3_CONTRACT }, outcomeIds,
    chanContext, conflictContext)
}

function dailyReviewChunkShape(baseShape, outcomeIds, chanAllowed) {
  const ids = outcomeIds.map(Number)
  const shape = {
    ...baseShape,
    trade_assessments:ids.map(outcomeId => ({ ...baseShape.trade_assessments[0], outcome_id:outcomeId })),
    // Current strategy optimization is a period-level responsibility. Keeping
    // these arrays empty prevents each independent trade request from needing
    // the same full strategy and memory library.
    experience_rules:[],
    strategy_conflicts:[],
  }
  if (chanAllowed) {
    shape.chan_diagnoses = ids.map(outcomeId => ({ ...baseShape.chan_diagnoses[0], outcome_id:outcomeId }))
    shape.period_chan_assessment = { ...baseShape.period_chan_assessment, affected_outcome_ids:ids }
  }
  return shape
}

function dailyReviewChunkMessages({ systemMessage, baseShape, chanAllowed, modelEvidence, chunk }) {
  const chunkIds = chunk.outcome_ids.map(Number)
  const chunkEvidence = dailyReviewModelEvidenceForChunk(modelEvidence, chunk)
  const chunkShape = dailyReviewChunkShape(baseShape, chunkIds, chanAllowed)
  return {
    chunkIds,
    chunkEvidence,
    chunkShape,
    messages:[systemMessage, { role:'user', content:JSON.stringify({
      required_output:chunkShape, outcome_ids:chunkIds,
      chunk:{ chunk_index:chunk.chunk_index, chunk_count:chunk.chunk_count,
        expected_outcome_ids:chunk.expected_outcome_ids, source_hash:chunk.source_hash, plan_hash:chunk.plan_hash },
      review_context:stripHistoricalConditionFields({
        system_statistics:chunkEvidence.system_statistics,
        pre_trade_frozen:chunkEvidence.pre_trade_frozen,
        holding_path:chunkEvidence.holding_path,
        period_market:chunkEvidence.period_market,
      }),
      evidence_refs_by_outcome:Object.fromEntries([...chunkEvidence.evidenceRefsByOutcome.entries()]
        .map(([id, refs]) => [String(id), [...refs]])),
      evidence_limitations_by_outcome:Object.fromEntries([...chunkEvidence.evidenceLimitationsByOutcome.entries()]
        .map(([id, limitations]) => [String(id), limitations])),
    }) }],
  }
}

function validateDailyReviewChunkContent(input, outcomeIds, chanContext, options = {}) {
  const content = validateDailyReviewV3Content(input, outcomeIds, chanContext, options)
  if ((content.experience_rules || []).length || (content.strategy_conflicts || []).length) {
    throw new Error('daily_review_chunk_optimization_scope_invalid')
  }
  return content
}

async function generateDailyReview(job, requestModel) {
  const evidence = parse(job.evidence_json, null)
  if (!evidence || !Array.isArray(evidence.sources) || !evidence.sources.length) throw new Error('daily_review_evidence_invalid')
  const resolved = await resolveAiTaskModel({ userId: job.user_id, strategyId: job.strategy_id, usage: 'review',
    modelPurpose:'daily_review' })
  if (!resolved.model) throw new Error(resolved.error || 'daily_review_model_unavailable')
  const strategyMemorySnapshot = await getReviewStrategyMemorySnapshot(job)
  const strategyMemoryForPrompt = sanitizeStrategyMemoryPrompt(strategyMemorySnapshot.library)
  const modelEvidence = buildDailyReviewV3ModelEvidence(evidence, strategyMemorySnapshot, strategyMemoryForPrompt)
  const endpoint = modelEndpoint(resolved.model)
  const outcomeIds = evidence.sources.map(item => Number(item.outcome_id))
  const chanContext = frozenDailyChanContext(evidence)
  const chanAllowed = chanContext.mode === 'enabled_complete'
  const memoryCategoryEnum = chanAllowed
    ? 'general|market_regime|entry_setup|chan_structure|risk_execution'
    : 'general|market_regime|entry_setup|risk_execution'
  const shape = { output_contract_version:DAILY_REVIEW_V3_CONTRACT, period_summary: 'string', decision_quality: 'good|mixed|poor|insufficient_evidence',
    trade_assessments: [{ outcome_id:outcomeIds[0], decision_quality: 'good|mixed|poor|insufficient_evidence',
      original_signal_logic:'string', technical_basis_assessment:'string', market_alignment:'aligned|partly_aligned|conflict|insufficient_evidence',
      strategy_alignment:'aligned|partly_aligned|conflict|insufficient_evidence', risk_execution_assessment:'string',
      risk_execution_status:'compliant|partly_compliant|violation|insufficient_evidence', missing_evidence:[],
      outcome_attribution:{ result:'profit|loss|breakeven', primary_causes:['string'], explanation:'string',
        avoidability:'avoidable|partly_avoidable|normal_strategy_loss|insufficient_evidence' },
      next_time_rule:{ condition:'string', action:'string', risk_control:'string', invalidation:'string', prohibited_action:'string' },
      issue_codes:['string'], evidence_refs:['outcome:<id> or another server-provided reference'], confidence:0.5 }],
    repeated_issues:[{ text:'string', source_refs:['outcome:<id>'], occurrence_count:2 }],
    strengths:[{ text:'string', source_refs:['outcome:<id>'], occurrence_count:1 }],
    risk_observations: ['string'], next_day_actions:['string'],
    experience_rules:[{ category:memoryCategoryEnum, condition:'string', action:'string', risk_control:'string', invalidation:'string',
      prohibited_action:'string', source_refs:['outcome:<id>'], confidence:0.5 }],
    strategy_conflicts:[{ conflict_target:'existing_memory|proposed_experience', category:memoryCategoryEnum,
      summary:'string', strategy_excerpt:'必须逐字来自 current_optimization_context.strategy',
      memory_excerpt:'existing_memory 时逐字来自 current_optimization_context.strategy_memory_library.content_text；proposed_experience 时严格使用 同一规则 condition；action；prohibited_action',
      suggested_change:'string', source_refs:['string'] }],
    confidence: 0.5 }
  if (chanAllowed) {
    shape.chan_diagnoses = firstChunkOutcomeIds.map(outcomeId => ({ outcome_id: outcomeId, status: 'normal|suspected_issue|confirmed_issue|insufficient_evidence', issue_source: 'data|calculation|confirmation_lag|ai_interpretation|strategy_rule|none|unknown', impact_on_decision: 'none|minor|material|unknown', explanation: 'string', confidence: 0.5 }))
    shape.period_chan_assessment = { status:'normal|suspected_issue|confirmed_issue|insufficient_evidence',
    issue_source:'data|calculation|confirmation_lag|ai_interpretation|strategy_rule|none|unknown',
      explanation:'string', affected_outcome_ids:firstChunkOutcomeIds, confidence:0.5 }
  }
  const tradeCoverageContract = chanAllowed
    ? 'trade_assessments 和 chan_diagnoses 必须各包含 required_output 中列出的分块交易，并且 outcome_id 只能且必须完整覆盖 expected_outcome_ids。'
    : 'trade_assessments 必须包含 required_output 中列出的分块交易，并且 outcome_id 只能且必须完整覆盖 expected_outcome_ids；Chan 未获准时 required_output 不包含 chan_diagnoses。'
  const memoryCategoryContract = chanAllowed
    ? 'experience_rules 的 category 可使用 required_output 中列出的全部类别。'
    : 'experience_rules 的 category 不得使用 chan_structure；Chan 未获准时不得生成 Chan 记忆。'
  const contract = [
    '输出必须是一个 JSON 对象，禁止 Markdown、解释文字和外层包装字段。',
    '必须原样使用 required_output 中的全部字段名；所有字段必填，即使没有内容也必须返回空数组。当前输出版本为 daily-period-review-v3，不能退回旧版 daily_lessons/memory_updates 合同。',
    'period_summary 必须是非空中文总结；decision_quality 只能使用给定枚举；confidence 必须是 0 到 1 的数字。',
    'risk_execution_status 必须明确标记合规、部分合规、违规或证据不足；normal_strategy_loss 仅允许实际亏损、decision_quality=good、market_alignment=aligned、strategy_alignment=aligned 且 risk_execution_status=compliant。missing_evidence 是后端所有字段，模型必须始终返回空数组；只有 review_context 明确提供 evidence_limitations 时才允许使用 insufficient_evidence，后端会写入实际限制。repeated_issues 和 strengths 必须使用 text/source_refs/occurrence_count 结构，repeated_issues 至少引用两个不同 outcome。',
    'holding_path.path_metrics.status=not_observable 表示交易事实和行情覆盖完整，但持仓太短，闭合K线无法精确观察持仓内路径；这不等于整条交易证据不足。此时禁止把边界K线高低价当作持仓期MFE/MAE，禁止判断止盈、止损是否曾触达，也不得据此生成经验规则；仍须使用成交事实、事前快照和交易日行情完成信号逻辑、盈亏原因与改进建议分析。',
    '除 JSON 字段名和规定枚举值外，所有用户可见字符串与数组内容必须使用简体中文；禁止输出内部错误码、英文状态或整句英文。品种代码、周期以及 AI、MT5、MACD、RSI、ATR、KDJ、EMA、SMA 等通用技术缩写可以保留。',
    tradeCoverageContract,
    `不得遗漏、合并或虚构交易；不得修改系统提供的基础统计。当前请求只负责逐笔判断，不提供当前策略优化上下文；experience_rules 和 strategy_conflicts 必须严格返回空数组，由最终合并任务统一生成。每个对象的文本和引用字段必须符合 required_output。source_refs/evidence_refs 只能引用服务器提供的 outcome:<id> 或证据引用，不得编造其他来源。${memoryCategoryContract}`,
    chanAllowed ? '只有冻结证据明确启用缠论且 Chan 证据完整时才可输出缠论诊断；缠论记忆类别必须有可靠结构证据。'
      : '冻结证据未同时满足缠论启用和完整条件；禁止输出任何缠论字段、缠论诊断或 chan_structure 记忆。',
  ].join('\n')
  const chanPrompt = chanAllowed
    ? '冻结证据明确启用了缠论且 period_market 的 Chan 证据完整；请根据能力字段判断可用结构。'
    : '冻结证据未同时满足缠论启用和完整条件；不要输出、推断或评价任何缠论结构，也不要生成 chan_structure 记忆。'
  const systemMessage = { role: 'system', content: `你是严格的交易日复盘分析器。system_statistics 是后端计算的只读事实，必须直接采用且不得自行重算。模型输入已明确分区：pre_trade_frozen 只能评价原始信号当时的判断，holding_path 只能解释持仓路径和成交结果，period_market 只能补充交易日环境和事后解释。当前策略优化上下文只在最终合并任务使用，不能改写历史判断。${chanPrompt} 必须判断问题来自行情数据、结构计算、确认延迟、AI 解读还是策略规则。period_market.status 不完整时必须降低置信度。必须区分推理时结构、同时间点回放结构和事后最终结构；未来数据只能用于事后解释，不能反过来判定当时决策错误。不得把盈利等同于决策正确，也不得把亏损等同于决策错误。\n\n以下输出契约不可违反：\n${contract}` }
  const planContextHash = sha256(JSON.stringify({
    planning_version:DAILY_REVIEW_CHUNK_PLAN_VERSION,
    system_message:systemMessage.content,
    system_statistics:modelEvidence.system_statistics,
    period_market:modelEvidence.period_market,
    optimization_context:modelEvidence.current_optimization_context,
  }))
  const chunkPlan = buildDailyReviewChunkPlan(evidence, {
    maxBytes:DAILY_REVIEW_CHUNK_PLAN_MAX_BYTES,
    contextHash:planContextHash,
    measureChunk:sources => {
      const ids = sources.map(source => Number(source.outcome_id))
      const placeholderHash = '0'.repeat(64)
      const candidate = { chunk_index:0, chunk_count:999, outcome_ids:ids, expected_outcome_ids:ids,
        source_hash:placeholderHash, plan_hash:placeholderHash }
      return periodReviewModelInputBudget(dailyReviewChunkMessages({ systemMessage, baseShape:shape,
        chanAllowed, modelEvidence, chunk:candidate }).messages)
    },
  })
  const chunkContents = []
  for (const chunk of chunkPlan.chunks) {
    const { chunkIds, chunkEvidence, chunkShape, messages:chunkMessages } = dailyReviewChunkMessages({
      systemMessage, baseShape:shape, chanAllowed, modelEvidence, chunk,
    })
    const taskIdentity = dailyReviewTaskIdentity(job, 'chunk', chunkPlan.plan_hash, chunk.chunk_index)
    const checkpoint = await loadDailyReviewCheckpoint(taskIdentity, chunkPlan.plan_hash, chunk.chunk_index)
    if (checkpoint) {
      const restored = validateDailyReviewChunkContent(checkpoint.content, chunkIds, chanContext, {
        strategyText:strategyMemorySnapshot.strategy_text,
        memoryText:strategyMemorySnapshot.library.content_text,
        outcomeFacts:chunkEvidence.outcomeFacts,
        evidenceRefsByOutcome:chunkEvidence.evidenceRefsByOutcome,
        evidenceLimitationsByOutcome:chunkEvidence.evidenceLimitationsByOutcome,
      })
      chunkContents.push(restored)
      job._modelTracker = null
      continue
    }
    // Every provider request gets an independent budget/deadline and durable
    // model-task envelope. The event-table checkpoint is written only after
    // the chunk has passed the full v3 validator; a retry can therefore reuse
    // a completed chunk without replaying a billable request.
    const modelCall = await preparePeriodReviewModelCall('daily_review', resolved, chunkMessages,
      Math.max(3000, Math.ceil(JSON.stringify(chunkShape).length / 2.5)), { nowUtcMs:Date.now() })
    const tracker = await startPeriodReviewModelTask(job, resolved, endpoint, evidence, 'daily_review_chunk', {
      model_task_kind:taskIdentity.taskKind,
      task_key_suffix:taskIdentity.taskKeySuffix,
      daily_review_task_role:'chunk', daily_review_chunk_index:chunk.chunk_index,
      daily_review_chunk_plan_hash:chunkPlan.plan_hash,
      daily_review_chunk_count:chunkPlan.chunk_count,
      daily_review_expected_outcome_ids:chunkPlan.expected_outcome_ids,
    }, { taskDeadlineAtUtcMs:modelCall.taskDeadlineUtcMs })
    job._modelTracker = tracker
    await ensurePeriodReviewStrategyMemoryInjectionLog(job, strategyMemorySnapshot, 'daily_review', tracker.taskId)
    await tracker.persistBudget(modelCall.budget)
    await persistPeriodReviewInputBudget(tracker, modelCall.budget, {
      task_role:'chunk', chunk_index:chunk.chunk_index, chunk_count:chunkPlan.chunk_count,
      outcome_count:chunkIds.length, market_digest_version:DAILY_REVIEW_MARKET_DIGEST_VERSION,
      pre_trade_projection_version:'daily-pre-trade-v2', chunk_planning_version:chunkPlan.planning_version,
      shared_context_hash:chunkPlan.context_hash, planned_request_bytes:chunk.planned_request_bytes,
      planned_input_tokens:chunk.planned_input_tokens,
    })
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
      messages:chunkMessages, modelTaskBudget:modelCall.budget,
      usageContext: { userId: job.user_id, profileId: resolved.model_profile_id, credentialSource: resolved.credential_source, usage: 'review', strategyId: job.strategy_id,
        daily_review_chunk_index:chunk.chunk_index, daily_review_chunk_count:chunkPlan.chunk_count },
      onProviderRequest:periodReviewProviderRequestCallback(job, tracker),
      onProviderUsage:event => tracker.onProviderUsage(event),
      onProviderActivity:event => tracker.onProviderActivity(event),
      onProviderQuiet:event => tracker.onProviderQuiet(event),
      onProgress: stage => setPeriodReviewJobStage(job, `daily_chunk_${chunk.chunk_index}_${stage}`),
      allowFollowupRequests:true,
      repairContext:{ outputFormat:JSON.stringify(chunkShape),
        requiredCoverage:{ contract_version:DAILY_REVIEW_V3_CONTRACT, outcome_ids:chunkIds,
          chunk_index:chunk.chunk_index, chunk_count:chunkPlan.chunk_count } },
      validateObject: value => validateDailyReviewChunkContent(value, chunkIds, chanContext, {
        strategyText:strategyMemorySnapshot.strategy_text,
        memoryText:strategyMemorySnapshot.library.content_text,
        outcomeFacts:chunkEvidence.outcomeFacts,
        evidenceRefsByOutcome:chunkEvidence.evidenceRefsByOutcome,
        evidenceLimitationsByOutcome:chunkEvidence.evidenceLimitationsByOutcome,
      }),
    })
    const normalized = validateDailyReviewChunkContent(output, chunkIds, chanContext, {
      strategyText:strategyMemorySnapshot.strategy_text,
      memoryText:strategyMemorySnapshot.library.content_text,
      outcomeFacts:chunkEvidence.outcomeFacts,
      evidenceRefsByOutcome:chunkEvidence.evidenceRefsByOutcome,
      evidenceLimitationsByOutcome:chunkEvidence.evidenceLimitationsByOutcome,
    })
    const resultHash = await persistDailyReviewCheckpoint(tracker, { role:'chunk', planHash:chunkPlan.plan_hash,
      chunkIndex:chunk.chunk_index, sourceHash:chunk.source_hash, content:normalized })
    await tracker.resultReady({ resultHash, resultRef:`period_review_chunk:${job.period_case_id}:${chunk.chunk_index}` })
    await tracker.applying()
    await tracker.succeeded({ resultRef:`period_review_chunk:${job.period_case_id}:${chunk.chunk_index}`, resultHash })
    await tracker.stop()
    chunkContents.push(normalized)
    job._modelTracker = null
  }
  // Trade chunks never receive the current optimization context. The merge is
  // therefore required even for one chunk so strategy advice and conflicts are
  // produced exactly once from the frozen strategy and memory library.
  const deterministicMerge = mergeDailyReviewV3ChunkContents(chunkContents, outcomeIds)
  const compactChunkResults = chunkContents.map((content, index) => ({
    chunk_index:index, outcome_ids:content.trade_assessments.map(item => Number(item.outcome_id)),
    period_summary:content.period_summary,
    trade_assessments:content.trade_assessments.map(item => ({ outcome_id:item.outcome_id,
      decision_quality:item.decision_quality, market_alignment:item.market_alignment,
      strategy_alignment:item.strategy_alignment, risk_execution_status:item.risk_execution_status,
      outcome_attribution:item.outcome_attribution, next_time_rule:item.next_time_rule,
      issue_codes:item.issue_codes, evidence_refs:item.evidence_refs, confidence:item.confidence })),
    repeated_issues:content.repeated_issues, strengths:content.strengths,
    risk_observations:content.risk_observations, next_day_actions:content.next_day_actions,
    experience_rules:content.experience_rules, strategy_conflicts:content.strategy_conflicts,
    confidence:content.confidence,
  }))
  const mergeShape = { output_contract_version:DAILY_REVIEW_V3_CONTRACT, period_summary:'string',
    repeated_issues:[{ text:'string', source_refs:['outcome:<id>'], occurrence_count:2 }],
    strengths:[{ text:'string', source_refs:['outcome:<id>'], occurrence_count:1 }],
    risk_observations:['string'], next_day_actions:['string'],
    experience_rules:[{ category:memoryCategoryEnum, condition:'string', action:'string', risk_control:'string',
      invalidation:'string', prohibited_action:'string', source_refs:['outcome:<id>'], confidence:0.5 }],
    strategy_conflicts:[{ conflict_target:'existing_memory|proposed_experience', category:memoryCategoryEnum,
      summary:'string', strategy_excerpt:'必须逐字来自 current_optimization_context.strategy',
      memory_excerpt:'existing_memory 时逐字来自 current_optimization_context.strategy_memory_library.content_text；proposed_experience 时严格使用 同一规则 condition；action；prohibited_action',
      suggested_change:'string', source_refs:['outcome:<id>'] }], confidence:0.5 }
  const mergeContract = [
    '输出必须是一个 JSON 对象，禁止 Markdown、解释文字和外层包装字段。',
    '这是日复盘最终合并任务，只允许输出 required_output 中的周期级字段；不要输出或改写任何 trade_assessments，逐笔结论由服务器保留。',
    '必须综合全部 validated_chunk_results，跨分块识别 repeated_issues、strengths、risk_observations、next_day_actions、experience_rules 和 strategy_conflicts；source_refs 必须只引用实际存在的 outcome:<id>，repeated_issues 至少引用两个不同 outcome。',
    'experience_rules 必须是条件—动作—风控—失效—禁止行为的明确规则；不得把盈利等同于决策正确，也不得把亏损等同于决策错误。',
    `current_optimization_context 只在本合并任务提供。strategy_excerpt 必须逐字来自 current_optimization_context.strategy；existing_memory 的 memory_excerpt 必须逐字来自 current_optimization_context.strategy_memory_library.content_text；proposed_experience 的 memory_excerpt 必须严格拼接同一条 experience_rule 的“condition；action；prohibited_action”。${chanAllowed ? '' : '禁止生成缠论经验或冲突。'}${memoryCategoryContract}`,
  ].join('\n')
  const mergeTaskIdentity = dailyReviewTaskIdentity(job, 'merge', chunkPlan.plan_hash)
  const mergeCheckpoint = await loadDailyReviewCheckpoint(mergeTaskIdentity, chunkPlan.plan_hash)
  let mergedOutput
  if (mergeCheckpoint) {
    mergedOutput = normalizeDailyReviewV3MergeContent(mergeCheckpoint.content, outcomeIds, chanContext, {
      strategyText:strategyMemorySnapshot.strategy_text, memoryText:strategyMemorySnapshot.library.content_text,
    })
    job._modelTracker = null
  } else {
    const mergeMessages = [
      { role:'system', content:`你是严格的交易日复盘合并分析器。你只能基于服务器已经校验的分块结论做跨分块归纳，不能修改任何逐笔结论、事实或引用。${mergeContract}` },
      { role:'user', content:JSON.stringify({ required_output:mergeShape, output_contract_version:DAILY_REVIEW_V3_CONTRACT,
        expected_outcome_ids:outcomeIds, plan_hash:chunkPlan.plan_hash,
        current_optimization_context:modelEvidence.current_optimization_context,
        validated_chunk_results:compactChunkResults }) },
    ]
    const mergeCall = await preparePeriodReviewModelCall('daily_review', resolved, mergeMessages,
      Math.max(3000, Math.ceil(JSON.stringify(mergeShape).length / 2.5)), { nowUtcMs:Date.now() })
    const mergeTracker = await startPeriodReviewModelTask(job, resolved, endpoint, evidence, 'daily_review_merge', {
      model_task_kind:mergeTaskIdentity.taskKind, task_key_suffix:mergeTaskIdentity.taskKeySuffix,
      daily_review_task_role:'merge', daily_review_chunk_plan_hash:chunkPlan.plan_hash,
      daily_review_chunk_count:chunkPlan.chunk_count,
      daily_review_expected_outcome_ids:chunkPlan.expected_outcome_ids,
    }, { taskDeadlineAtUtcMs:mergeCall.taskDeadlineUtcMs })
    job._modelTracker = mergeTracker
    await ensurePeriodReviewStrategyMemoryInjectionLog(job, strategyMemorySnapshot, 'daily_review', mergeTracker.taskId)
    await mergeTracker.persistBudget(mergeCall.budget)
    await persistPeriodReviewInputBudget(mergeTracker, mergeCall.budget, {
      task_role:'merge', chunk_count:chunkPlan.chunk_count, outcome_count:outcomeIds.length,
      market_digest_version:DAILY_REVIEW_MARKET_DIGEST_VERSION,
      pre_trade_projection_version:'daily-pre-trade-v2', chunk_planning_version:chunkPlan.planning_version,
      shared_context_hash:chunkPlan.context_hash,
    })
    const mergeSignal = job._abortSignal && mergeTracker.signal
      ? AbortSignal.any([job._abortSignal, mergeTracker.signal])
      : mergeTracker.signal || job._abortSignal || null
    const mergeOutputRaw = await requestModel({ url:endpoint.url, apiKey:resolved.model.api_key_encrypted,
      provider:resolved.model.provider, model:resolved.model.model_name,
      temperature:Math.min(Number(resolved.model.temperature ?? 0.2), 0.3),
      maxTokens:mergeCall.budget.selectedMaxOutputTokens, thinkingEnabled:resolved.model.thinking_enabled,
      reasoningEffort:resolved.model.reasoning_effort, protocol:endpoint.protocol,
      timeout:mergeCall.requestTimeoutMs, deadlineAtMs:mergeCall.attemptSafetyDeadlineUtcMs,
      followupValidUntilMs:mergeCall.attemptSafetyDeadlineUtcMs, signal:mergeSignal,
      messages:mergeMessages, modelTaskBudget:mergeCall.budget,
      usageContext:{ userId:job.user_id, profileId:resolved.model_profile_id, credentialSource:resolved.credential_source,
        usage:'review', strategyId:job.strategy_id, daily_review_merge:true, daily_review_chunk_count:chunkPlan.chunk_count },
      onProviderRequest:periodReviewProviderRequestCallback(job, mergeTracker),
      onProviderUsage:event => mergeTracker.onProviderUsage(event),
      onProviderActivity:event => mergeTracker.onProviderActivity(event),
      onProviderQuiet:event => mergeTracker.onProviderQuiet(event),
      onProgress:stage => setPeriodReviewJobStage(job, `daily_merge_${stage}`),
      allowFollowupRequests:true,
      repairContext:{ outputFormat:JSON.stringify(mergeShape),
        requiredCoverage:{ contract_version:DAILY_REVIEW_V3_CONTRACT, outcome_ids:outcomeIds,
          chunk_count:chunkPlan.chunk_count } },
      validateObject:value => normalizeDailyReviewV3MergeContent(value, outcomeIds, chanContext, {
        strategyText:strategyMemorySnapshot.strategy_text, memoryText:strategyMemorySnapshot.library.content_text,
      }),
    })
    mergedOutput = normalizeDailyReviewV3MergeContent(mergeOutputRaw, outcomeIds, chanContext, {
      strategyText:strategyMemorySnapshot.strategy_text, memoryText:strategyMemorySnapshot.library.content_text,
    })
    const resultHash = await persistDailyReviewCheckpoint(mergeTracker, { role:'merge', planHash:chunkPlan.plan_hash,
      content:mergedOutput })
    await mergeTracker.resultReady({ resultHash, resultRef:`period_review_merge:${job.period_case_id}` })
  }
  const mergedContent = {
    ...deterministicMerge, period_summary:mergedOutput.period_summary,
    repeated_issues:mergedOutput.repeated_issues, strengths:mergedOutput.strengths,
    risk_observations:mergedOutput.risk_observations, next_day_actions:mergedOutput.next_day_actions,
    experience_rules:mergedOutput.experience_rules,
    // Current-strategy conflicts are produced once by the merge task. Keep the
    // deterministic union for checkpoint/backward compatibility.
    strategy_conflicts:[...new Map([
      ...(deterministicMerge.strategy_conflicts || []), ...(mergedOutput.strategy_conflicts || []),
    ].map(item => [JSON.stringify(item), item])).values()],
    confidence:Math.min(Number(deterministicMerge.confidence), Number(mergedOutput.confidence)),
  }
  const content = validateDailyReviewV3Content(mergedContent, outcomeIds, chanContext, {
    strategyText:strategyMemorySnapshot.strategy_text,
    memoryText:strategyMemorySnapshot.library.content_text,
    outcomeFacts:modelEvidence.outcomeFacts,
    evidenceRefsByOutcome:modelEvidence.evidenceRefsByOutcome,
    evidenceLimitationsByOutcome:modelEvidence.evidenceLimitationsByOutcome,
  })
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
    const regenerating = isPeriodReviewRegenerationJob(job)
    const parentVersionId = regenerating ? periodReviewRegenerationParentVersionId(job) : null
    if (regenerating && (!parentVersionId || Number(cases[0].approved_version_id || 0) > 0)) {
      throw new Error('period_review_regeneration_version_conflict')
    }
    if (regenerating && Number(cases[0].current_version_id || 0) !== Number(parentVersionId)) {
      const [existingChildren] = await run(`SELECT id, author_type, parent_version_id, change_note
        FROM period_review_versions WHERE id = ? AND period_case_id = ? FOR UPDATE`, [cases[0].current_version_id, job.period_case_id])
      const existing = existingChildren?.[0]
      const expectedNote = `AI daily review regeneration ${job.idempotency_key}`
      if (!existing || existing.author_type !== 'ai' || Number(existing.parent_version_id || 0) !== Number(parentVersionId)
        || String(existing.change_note || '') !== expectedNote) throw new Error('period_review_regeneration_version_conflict')
    }
    if (!cases[0].current_version_id || (regenerating && Number(cases[0].current_version_id || 0) === Number(parentVersionId))) {
      const [versions] = await run('SELECT id, version_no FROM period_review_versions WHERE period_case_id = ? ORDER BY version_no DESC LIMIT 1 FOR UPDATE', [job.period_case_id])
      const versionParentId = regenerating ? parentVersionId : versions[0]?.id || null
      const nextVersionNo = Number(versions[0]?.version_no || 0) + 1
      const body = JSON.stringify(generated.content)
      const [insert] = await run(`INSERT INTO period_review_versions
        (period_case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
        VALUES (?, ?, ?, 'ai', NULL, ?, ?, ?, ?)`, [job.period_case_id, nextVersionNo, versionParentId, body, sha256(body),
        regenerating ? `AI daily review regeneration ${job.idempotency_key}` : 'AI daily review draft', now])
      const where = regenerating ? `id = ? AND current_version_id = ? AND approved_version_id IS NULL
        AND status IN ('generating', 'needs_revision')` : 'id = ?'
      const [updated] = await run(`UPDATE period_review_cases SET status = 'draft', current_version_id = ?, updated_at = ? WHERE ${where}`,
        regenerating ? [insert.insertId, now, job.period_case_id, parentVersionId] : [insert.insertId, now, job.period_case_id])
      if (regenerating && Number(updated?.affectedRows ?? updated?.changes ?? 0) !== 1) {
        throw new Error('period_review_regeneration_version_conflict')
      }
    }
    await run(`UPDATE period_review_jobs SET status = 'succeeded', progress_stage = 'succeeded', stage_updated_at = ?,
      model_profile_id = ?, credential_source = ?, last_error_code = NULL, evidence_retry_count = 0,
      evidence_last_checked_at = NULL, next_attempt_at = NULL, completed_at = ?,
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

function isPeriodReviewProviderCapacityWait(error, modelTask = null) {
  const values = [error?.code, error?.message, modelTask?.error_code, modelTask?.errorCode]
    .map(value => String(value || '').toLowerCase())
  return Number(error?.providerStatus) === 429 || error?.modelQuotaCircuit === true
    || values.some(value => value.includes('model_quota_exhausted')
      || value.includes('model_quota_probe_in_progress') || value.includes('http 429') || value.includes('rate limit'))
}

function periodReviewCapacityRetryAt(error) {
  const raw = error?.details?.retry_after || error?.retryAfter || error?.retry_after
  const parsed = raw ? Date.parse(String(raw).replace(' ', 'T')) : NaN
  if (Number.isFinite(parsed) && parsed > Date.now()) {
    const date = new Date(parsed + 8 * 3600000)
    return date.toISOString().replace('T', ' ').slice(0, 19)
  }
  const minutes = Math.max(5, Number.parseInt(process.env.AI_MODEL_QUOTA_CIRCUIT_MINUTES || '60') || 60)
  return afterSeconds(minutes * 60)
}

async function restoreQuotaConsumedBusinessAttempt(job) {
  if (!job?._businessAttemptStarted || Number(job.attempt_count || 0) <= 0) return false
  const result = await queryRun(`UPDATE period_review_jobs SET attempt_count = GREATEST(attempt_count - 1, 0), updated_at = ?
    WHERE id = ? AND status = 'leased' AND lease_token = ? AND attempt_count > 0`,
  [beijingNow(), job.id, job.lease_token])
  const affected = Number(result?.affectedRows ?? result?.changes ?? 0)
  if (affected !== 1) return false
  job.attempt_count = Math.max(0, Number(job.attempt_count || 0) - 1)
  job._businessAttemptStarted = false
  return true
}

async function markPeriodReviewRegenerationNeedsRevision(job) {
  if (!isPeriodReviewRegenerationJob(job)) return
  await queryRun(`UPDATE period_review_cases SET status = 'needs_revision', updated_at = ?
    WHERE id = ? AND current_version_id IS NOT NULL AND status IN ('generating', 'needs_revision')`, [beijingNow(), job.period_case_id])
}

async function finishDailyReviewFailure(job, error, modelTask = null) {
  const unknown = providerResultUnknown(job._modelTracker, modelTask)
  const capacityWait = !unknown && isPeriodReviewProviderCapacityWait(error, modelTask)
  const preProviderRetry = capacityWait ? null : await nextPeriodReviewPreProviderRetry(job, error)
  if (capacityWait) await restoreQuotaConsumedBusinessAttempt(job)
  const exhausted = !capacityWait && job.attempt_count >= Number(job.max_attempts)
  const retryAt = unknown || exhausted ? null : preProviderRetry ? preProviderRetry.retryAt
    : capacityWait ? periodReviewCapacityRetryAt(error)
    : afterSeconds(Math.min(900, 60 * (2 ** Math.max(0, Number(job.attempt_count) - 1))))
  const jobStatus = unknown ? 'status_unknown' : exhausted ? 'failed' : 'queued'
  const errorCode = unknown ? 'provider_status_unknown' : capacityWait ? 'model_quota_exhausted'
    : preProviderRetry?.errorCode || safeError(error)
  const jobUpdate = await queryRun(`UPDATE period_review_jobs SET status = ?, last_error_code = ?, lease_token = NULL,
    lease_expires_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?`,
  [jobStatus, errorCode, retryAt, beijingNow(), job.id, job.lease_token])
  if (isPeriodReviewRegenerationJob(job)
    && Number(jobUpdate?.affectedRows ?? jobUpdate?.changes ?? 0) !== 1) return
  // The review case remains generating while the provider outcome is
  // unresolved.  Only the job/status stage is marked unknown; showing a
  // failed case would incorrectly imply that no provider request was made.
  const caseStatus = isPeriodReviewRegenerationJob(job) ? 'needs_revision' : unknown ? 'generating' : exhausted ? 'failed' : 'ready'
  await queryRun(`UPDATE period_review_cases SET status = ?, updated_at = ? WHERE id = ? ${isPeriodReviewRegenerationJob(job)
    ? "AND current_version_id IS NOT NULL AND status IN ('generating', 'needs_revision')" : 'AND current_version_id IS NULL'}`,
    [caseStatus, beijingNow(), job.period_case_id])
  return { jobStatus, retryAt, errorCode, preProviderRetry }
}

async function skipDisabledPeriodReviewJob(job) {
  const now = beijingNow()
  await withTransaction(async run => {
    await run(`UPDATE period_review_jobs SET status = 'skipped', progress_stage = 'skipped', stage_updated_at = ?,
      last_error_code = 'review_generation_disabled', lease_token = NULL, lease_expires_at = NULL,
      next_attempt_at = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?`,
    [now, now, now, job.id, job.lease_token])
    await run(`UPDATE period_review_cases SET status = ?, updated_at = ?
      WHERE id = ? ${isPeriodReviewRegenerationJob(job)
        ? "AND current_version_id IS NOT NULL AND status IN ('generating', 'needs_revision')" : 'AND current_version_id IS NULL'}`,
    [isPeriodReviewRegenerationJob(job) ? 'needs_revision' : 'ready', now, job.period_case_id])
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
    const regenerationEvidenceHash = periodReviewRegenerationEvidenceHash(job)
    if (isPeriodReviewRegenerationJob(job) && regenerationEvidenceHash
      && regenerationEvidenceHash !== String(job.evidence_hash || '').toLowerCase()) {
      throw new Error('period_review_regeneration_evidence_conflict')
    }
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
    const capacityWait = isPeriodReviewProviderCapacityWait(error)
    try {
      modelTask = await job._modelTracker?.failed(error, !capacityWait && job.attempt_count >= Number(job.max_attempts))
    } catch (trackerError) {
      failure = trackerError
      console.error(`[PeriodReview case=${job.period_case_id}] model task failure:`, safeError(trackerError))
    }
    const failureState = await finishDailyReviewFailure(job, failure, modelTask)
    const unknown = providerResultUnknown(job._modelTracker, modelTask)
    const exhausted = !capacityWait && job.attempt_count >= Number(job.max_attempts)
    const preProviderRetry = failureState?.preProviderRetry
    const stage = unknown ? 'status_unknown' : exhausted ? 'failed' : preProviderRetry
      ? PERIOD_REVIEW_PRE_PROVIDER_RETRY_STAGE : 'retry_wait'
    const metadata = unknown || exhausted ? null : preProviderRetry
      ? { retry_count:preProviderRetry.retryCount, retry_at:preProviderRetry.retryAt,
        retry_delay_seconds:Math.round(preProviderRetry.delayMs / 1000), retry_reason:'pre_provider_infrastructure' }
      : capacityWait
        ? { retry_reason:'provider_capacity', retry_at:periodReviewCapacityRetryAt(error) }
        : { retry_delay_seconds:Math.min(900, 60 * (2 ** Math.max(0, Number(job.attempt_count) - 1))) }
    await setPeriodReviewJobStage(job, stage, 'error',
      capacityWait ? 'model_quota_exhausted' : failureState?.errorCode || safeError(error), metadata)
    return { claimed:true, status:unknown ? 'status_unknown' : exhausted ? 'failed' : 'retry_wait',
      periodCaseId:Number(job.period_case_id), error:safeError(failure) }
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
        AND ((jobs.status = 'queued' AND (jobs.next_attempt_at IS NULL OR jobs.next_attempt_at <= ?))
          OR (jobs.status = 'leased' AND jobs.lease_expires_at < ?))
        AND jobs.attempt_count < jobs.max_attempts AND cases.period_type = 'monthly'
        AND cases.strategy_compatibility_hash IS NOT NULL AND cases.evidence_status = 'complete'
        AND ((jobs.job_slot = 0 AND cases.current_version_id IS NULL)
          OR (jobs.job_slot > 0 AND cases.current_version_id IS NOT NULL
            AND cases.status IN ('generating', 'needs_revision')))
      ORDER BY jobs.updated_at, jobs.id LIMIT 1 FOR UPDATE`, [beijingNow(), beijingNow()])
    if (!rows[0]) return null
    const token = crypto.randomUUID()
    await run(`UPDATE period_review_jobs SET status = 'leased', progress_stage = 'preparing', stage_updated_at = ?, lease_token = ?, lease_expires_at = ?, next_attempt_at = NULL,
      updated_at = ? WHERE id = ?`, [beijingNow(), token, afterSeconds(120), beijingNow(), rows[0].id])
    await run(`UPDATE period_review_cases SET status = 'generating', updated_at = ?
      WHERE id = ? AND ((? = 0 AND current_version_id IS NULL)
        OR (? > 0 AND current_version_id IS NOT NULL AND status IN ('generating', 'needs_revision')))`,
    [beijingNow(), rows[0].period_case_id, Number(rows[0].job_slot || 0), Number(rows[0].job_slot || 0)])
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
    const regenerating = isPeriodReviewRegenerationJob(job)
    const parentVersionId = regenerating ? periodReviewRegenerationParentVersionId(job) : null
    if (regenerating && (!parentVersionId || Number(cases[0].approved_version_id || 0) > 0)) {
      throw new Error('period_review_regeneration_version_conflict')
    }
    if (regenerating && Number(cases[0].current_version_id || 0) !== Number(parentVersionId)) {
      const [existingChildren] = await run(`SELECT id, author_type, parent_version_id, change_note
        FROM period_review_versions WHERE id = ? AND period_case_id = ? FOR UPDATE`, [cases[0].current_version_id, job.period_case_id])
      const existing = existingChildren?.[0]
      const expectedNote = `AI monthly review regeneration ${job.idempotency_key}`
      if (!existing || existing.author_type !== 'ai' || Number(existing.parent_version_id || 0) !== Number(parentVersionId)
        || String(existing.change_note || '') !== expectedNote) throw new Error('period_review_regeneration_version_conflict')
    }
    if (!cases[0].current_version_id || (regenerating && Number(cases[0].current_version_id || 0) === Number(parentVersionId))) {
      const [versions] = await run('SELECT id, version_no FROM period_review_versions WHERE period_case_id = ? ORDER BY version_no DESC LIMIT 1 FOR UPDATE', [job.period_case_id])
      const versionParentId = regenerating ? parentVersionId : versions[0]?.id || null
      const nextVersionNo = Number(versions[0]?.version_no || 0) + 1
      const body = JSON.stringify(generated.content)
      const [insert] = await run(`INSERT INTO period_review_versions
        (period_case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
        VALUES (?, ?, ?, 'ai', NULL, ?, ?, ?, ?)`,
      [job.period_case_id, nextVersionNo, versionParentId, body, sha256(body),
        regenerating ? `AI monthly review regeneration ${job.idempotency_key}` : 'AI monthly review draft', now])
      const where = regenerating ? `id = ? AND current_version_id = ? AND approved_version_id IS NULL
        AND status IN ('generating', 'needs_revision')` : 'id = ?'
      const [updated] = await run(`UPDATE period_review_cases SET status = 'draft', current_version_id = ?, updated_at = ? WHERE ${where}`,
        regenerating ? [insert.insertId, now, job.period_case_id, parentVersionId] : [insert.insertId, now, job.period_case_id])
      if (regenerating && Number(updated?.affectedRows ?? updated?.changes ?? 0) !== 1) {
        throw new Error('period_review_regeneration_version_conflict')
      }
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
  const jobUpdate = await queryRun(`UPDATE period_review_jobs SET status = ?, last_error_code = ?, lease_token = NULL,
    lease_expires_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?`,
  [jobStatus, errorCode, retryAt, beijingNow(), job.id, job.lease_token])
  if (isPeriodReviewRegenerationJob(job)
    && Number(jobUpdate?.affectedRows ?? jobUpdate?.changes ?? 0) !== 1) return
  const caseStatus = isPeriodReviewRegenerationJob(job) ? 'needs_revision' : unknown ? 'generating' : exhausted ? 'failed' : 'ready'
  await queryRun(`UPDATE period_review_cases SET status = ?, updated_at = ? WHERE id = ? ${isPeriodReviewRegenerationJob(job)
    ? "AND current_version_id IS NOT NULL AND status IN ('generating', 'needs_revision')" : 'AND current_version_id IS NULL'}`,
  [caseStatus, beijingNow(), job.period_case_id])
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
    const regenerationEvidenceHash = periodReviewRegenerationEvidenceHash(job)
    if (isPeriodReviewRegenerationJob(job) && regenerationEvidenceHash
      && regenerationEvidenceHash !== String(job.evidence_hash || '').toLowerCase()) {
      throw new Error('period_review_regeneration_evidence_conflict')
    }
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
      if (isPeriodReviewRegenerationJob(job)) await markPeriodReviewRegenerationNeedsRevision(job)
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
      if (isPeriodReviewRegenerationJob(job) && terminalFailure) await markPeriodReviewRegenerationNeedsRevision(job)
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

function periodReviewContentForCase(reviewCase, content, conflictContext = {}) {
  const evidence = parse(reviewCase.evidence_json, {})
  if (reviewCase.period_type === 'daily') {
    const outcomeIds = (evidence.sources || []).map(item => Number(item.outcome_id))
    const modelEvidence = buildDailyReviewV3ModelEvidence(evidence, null, '')
    return validateDailyReviewContent(content, outcomeIds, frozenDailyChanContext(evidence), {
      outcomeFacts:modelEvidence.outcomeFacts,
      evidenceRefsByOutcome:modelEvidence.evidenceRefsByOutcome,
      evidenceLimitationsByOutcome:modelEvidence.evidenceLimitationsByOutcome,
      strategyText:conflictContext.strategyText,
      memoryText:conflictContext.memoryText,
    })
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
       jobs.job_slot, jobs.status AS job_status, jobs.progress_stage, jobs.stage_updated_at, jobs.attempt_count, jobs.max_attempts,
       jobs.last_error_code, jobs.next_attempt_at, jobs.evidence_retry_count, jobs.evidence_last_checked_at,
      derivation.status AS derivation_status, derivation.last_error_code AS derivation_error_code,
      ${strategyMemoryStateSelectSql()},
      CASE WHEN cases.current_version_id IS NOT NULL AND (seen.last_seen_version_id IS NULL OR seen.last_seen_version_id <> cases.current_version_id) THEN 1 ELSE 0 END AS is_unread
    FROM period_review_cases cases
    LEFT JOIN auto_prompt_types strategies ON strategies.id = cases.strategy_id
     LEFT JOIN period_review_jobs jobs ON jobs.id = (
       SELECT candidate.id FROM period_review_jobs candidate
       WHERE candidate.period_case_id = cases.id
       ORDER BY CASE WHEN candidate.job_slot > 0 AND candidate.status IN ('queued','leased','status_unknown') THEN 0 ELSE 1 END,
         candidate.id DESC LIMIT 1)
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
       jobs.id AS job_id, jobs.job_slot, jobs.status AS job_status, jobs.progress_stage, jobs.stage_updated_at,
       jobs.attempt_count, jobs.max_attempts, jobs.last_error_code, jobs.next_attempt_at,
       jobs.evidence_retry_count, jobs.evidence_last_checked_at, jobs.completed_at,
      derivation.id AS derivation_job_id, derivation.status AS derivation_status,
      derivation.attempt_count AS derivation_attempt_count, derivation.max_attempts AS derivation_max_attempts,
      derivation.last_error_code AS derivation_error_code, derivation.completed_at AS derivation_completed_at,
      ${strategyMemoryStateSelectSql()},
      CASE WHEN cases.current_version_id IS NOT NULL AND (seen.last_seen_version_id IS NULL OR seen.last_seen_version_id <> cases.current_version_id) THEN 1 ELSE 0 END AS is_unread
    FROM period_review_cases cases
    LEFT JOIN auto_prompt_types strategies ON strategies.id = cases.strategy_id
     LEFT JOIN period_review_jobs jobs ON jobs.id = (
       SELECT candidate.id FROM period_review_jobs candidate
       WHERE candidate.period_case_id = cases.id
       ORDER BY CASE WHEN candidate.job_slot > 0 AND candidate.status IN ('queued','leased','status_unknown') THEN 0 ELSE 1 END,
         candidate.id DESC LIMIT 1)
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
  const detailEvidence = parse(normalizedReviewCase.evidence_json, null)
  if (detailEvidence && Array.isArray(detailEvidence.sources)) {
    detailEvidence.sources = detailEvidence.sources.map(source => {
      const trade = source?.evidence || {}, inference = trade.inference_time || {}, post = trade.post_trade || {}
      const frozen = inference.pre_trade_frozen || {}
      const snapshot = frozen.snapshot || {}
      return { ...source, evidence:{ schema_version:trade.schema_version,
        inference_time:{ signal:inference.signal || frozen.signal || null, snapshot_ref:inference.snapshot_ref || null,
          pre_trade_frozen:{ signal:frozen.signal || null, cutoff_utc_msc:frozen.cutoff_utc_msc || null,
            snapshot:{ id:snapshot.id || null, strategy_id:snapshot.strategy_id || null,
              strategy_version:snapshot.strategy_version || null, content_hash:snapshot.content_hash || null } },
          risk_decision:inference.risk_decision || frozen.risk_decision || null,
          original_order:inference.original_order || frozen.original_order || null,
          approved_order:inference.approved_order || frozen.approved_order || null },
        post_trade:{ outcome:post.outcome || null, execution:post.execution || null,
          deals:(Array.isArray(post.deals) ? post.deals : []).map(deal => ({ deal_ticket:deal.deal_ticket,
            entry_type:deal.entry_type, volume:deal.volume, price:deal.price, profit:deal.profit,
            commission:deal.commission, swap:deal.swap, fee:deal.fee, deal_time:deal.deal_time })),
          path_metrics:post.path_metrics || null }, evidence_refs:trade.evidence_refs || {} } }
    })
  }
  if (detailEvidence?.period_market?.symbols && typeof detailEvidence.period_market.symbols === 'object') {
    detailEvidence.period_market.symbols = Object.fromEntries(Object.entries(detailEvidence.period_market.symbols)
      .map(([symbol, frames]) => [symbol, Object.fromEntries(Object.entries(frames || {}).map(([timeframe, frame]) =>
        [timeframe, { ...frame, full_period_candles:undefined }]))]))
  }
  return { ...normalizedReviewCase, evidence: detailEvidence, evidence_json: undefined, sources,
    job_events: events.map(row => ({ ...row, metadata: parse(row.metadata_json, null), metadata_json: undefined })),
    versions: versions.map(row => ({ ...row, content: parse(row.content_json, {}), content_json: undefined })) }
}

export async function getPeriodReviewSummary(actor) {
  const access = periodReviewAccessScope(actor)
  const rows = await queryAll(`SELECT cases.id, cases.user_id, cases.period_type, cases.period_key, cases.trading_account_id,
      cases.strategy_id, cases.status, cases.current_version_id,
       cases.approved_version_id, seen.last_seen_version_id, jobs.job_slot, jobs.status AS job_status,
      derivation.status AS derivation_status, ${strategyMemoryStateSelectSql()}
    FROM period_review_cases cases
    LEFT JOIN period_review_user_states seen ON seen.period_case_id = cases.id AND seen.user_id = ?
     LEFT JOIN period_review_jobs jobs ON jobs.id = (
       SELECT candidate.id FROM period_review_jobs candidate
       WHERE candidate.period_case_id = cases.id
       ORDER BY CASE WHEN candidate.job_slot > 0 AND candidate.status IN ('queued','leased','status_unknown') THEN 0 ELSE 1 END,
         candidate.id DESC LIMIT 1)
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
       jobs.id AS job_id, jobs.job_slot, jobs.status AS job_status, jobs.progress_stage, jobs.stage_updated_at,
       jobs.attempt_count, jobs.max_attempts, jobs.last_error_code, jobs.next_attempt_at,
       jobs.evidence_retry_count, jobs.evidence_last_checked_at, jobs.completed_at,
      derivation.status AS derivation_status, derivation.attempt_count AS derivation_attempt_count,
      derivation.max_attempts AS derivation_max_attempts, derivation.last_error_code AS derivation_error_code,
      derivation.completed_at AS derivation_completed_at, ${strategyMemoryStateSelectSql()}
    FROM period_review_cases cases
     LEFT JOIN period_review_jobs jobs ON jobs.id = (
       SELECT candidate.id FROM period_review_jobs candidate
       WHERE candidate.period_case_id = cases.id
       ORDER BY CASE WHEN candidate.job_slot > 0 AND candidate.status IN ('queued','leased','status_unknown') THEN 0 ELSE 1 END,
         candidate.id DESC LIMIT 1)
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
    let conflictContext = {}
    if (reviewCase.period_type === 'daily' && Array.isArray(content?.strategy_conflicts)
      && content.strategy_conflicts.length > 0) {
      const [snapshotRows] = await run(`SELECT memory_strategy_snapshot_text, memory_library_snapshot_text
        FROM period_review_jobs WHERE period_case_id = ?
          AND memory_strategy_snapshot_text IS NOT NULL AND memory_library_snapshot_text IS NOT NULL
        ORDER BY id DESC LIMIT 1`, [periodCaseId])
      if (!snapshotRows[0]) throw new Error('strategy_memory_conflict_frozen_snapshot_missing')
      conflictContext = { strategyText:snapshotRows[0].memory_strategy_snapshot_text,
        memoryText:snapshotRows[0].memory_library_snapshot_text }
    }
    const normalized = periodReviewContentForCase(reviewCase, content, conflictContext)
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
    const condition = memoryMarkdownText(entry.condition)
    const action = memoryMarkdownText(entry.action)
    const invalidation = memoryMarkdownText(entry.invalidation)
    const prohibitedAction = memoryMarkdownText(entry.prohibited_action)
    const structuredRisk = memoryMarkdownText(entry.risk_control)
    if (condition && action && invalidation && prohibitedAction && structuredRisk) {
      lines.push(`- 当【${condition}】时，执行【${action}】。`)
      lines.push(`  - 风控：${structuredRisk}`)
      lines.push(`  - 失效：${invalidation}`)
      lines.push(`  - 禁止：${prohibitedAction}`)
      continue
    }
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
    if (String(content?.output_contract_version || '') === DAILY_REVIEW_V3_CONTRACT) {
      const chanContext = frozenDailyChanContext(evidence)
      const knownOutcomeRefs = new Set(canonicalRefs)
      const rules = Array.isArray(content.experience_rules) ? content.experience_rules : []
      return rules.map(rule => {
        const category = [rule?.category, rule?.memory_category].find(value => MEMORY_CATEGORIES.has(value)) || 'general'
        if (category === 'chan_structure' && chanContext.mode !== 'enabled_complete') {
          throw new Error('strategy_memory_chan_evidence_invalid')
        }
        const sourceRefs = [...new Set((Array.isArray(rule?.source_refs) ? rule.source_refs : []).map(ref => String(ref).trim()))]
        if (!sourceRefs.length || sourceRefs.some(ref => !knownOutcomeRefs.has(ref))) {
          throw new Error('daily_experience_rule_source_refs_invalid')
        }
        return { ...rule, category, source_refs:[...sourceRefs, ...currentRefs] }
      })
    }
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
    if (String(content?.output_contract_version || '') === DAILY_REVIEW_V3_CONTRACT) {
      // Keep proposed-conflict matching identical to generation-time
      // validation. A conflict excerpt must match one complete structured
      // rule, not an independently reformatted fragment.
      return derivationMemoryEntries(approved, content)
        .map(item => [item.condition, item.action, item.prohibited_action].map(memoryMarkdownText).filter(Boolean).join('；'))
        .filter(Boolean)
    }
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
      if (jobType === 'daily_review') {
        const [dailyTasks] = await run(`SELECT task_id, status FROM ai_model_tasks
          WHERE domain_type = 'period_review_job' AND domain_id = ?
            AND task_kind IN ('daily_review_chunk','daily_review_merge') FOR UPDATE`, [String(jobs[0].id)])
        if ((dailyTasks || []).some(task => !MODEL_TASK_TERMINAL_STATES.has(String(task.status || '')))) {
          throw new Error('period_review_daily_checkpoint_task_unresolved')
        }
      }
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

const PERIOD_REVIEW_REGENERATION_CASE_STATUSES = new Set(['draft', 'edited', 'needs_revision', 'deferred'])
const PERIOD_REVIEW_REGENERATION_ACTIVE_JOB_STATUSES = new Set(['queued', 'leased', 'status_unknown'])
const PERIOD_REVIEW_REGENERATION_UNRESOLVED_CHECKPOINT_STATUSES = new Set([
  MONTHLY_REVIEW_CHECKPOINT_STATUSES.QUEUED,
  MONTHLY_REVIEW_CHECKPOINT_STATUSES.LEASED,
  MONTHLY_REVIEW_CHECKPOINT_STATUSES.STATUS_UNKNOWN,
])

function isPeriodReviewRegenerationJob(job) {
  return Number(job?.job_slot || 0) > 0 || String(job?.idempotency_key || '').startsWith('regenerate:')
}

function periodReviewRegenerationParentVersionId(job) {
  const explicit = Number(job?.parent_version_id || 0)
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit
  const match = /:v(\d+)(?::|$)/.exec(String(job?.idempotency_key || ''))
  const parsed = Number(match?.[1] || 0)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function periodReviewRegenerationEvidenceHash(job) {
  const match = /:e([a-f0-9]{64}):v\d+(?::|$)/i.exec(String(job?.idempotency_key || ''))
  return match?.[1] ? String(match[1]).toLowerCase() : null
}

function periodReviewRegenerationKey(periodType, periodCaseId, parentVersionId, evidenceHash, requestKey = null) {
  const jobType = periodType === 'daily' ? 'daily_review' : 'monthly_review'
  const suffix = requestKey ? `req:${sha256(requestKey)}` : `run:${crypto.randomUUID()}`
  return `regenerate:${jobType}:${Number(periodCaseId)}:${suffix}:e${String(evidenceHash || '')}:v${Number(parentVersionId)}`
}

function regenerationRequestKeyFromInput(value) {
  const text = String(value || '').trim()
  if (!text) return null
  if (text.length > 191) throw new Error('period_review_regeneration_idempotency_key_invalid')
  return text
}

function insertIdFromResult(result) {
  return Number(result?.insertId || result?.[0]?.insertId || 0)
}

async function assertPeriodReviewRegenerationInputs(run, reviewCase, jobs) {
  const jobIds = (jobs || []).map(job => Number(job.id)).filter(id => Number.isSafeInteger(id) && id > 0)
  const [checkpoints] = await run(`SELECT checkpoints.*
      FROM period_review_monthly_checkpoints checkpoints
      JOIN period_review_jobs jobs ON jobs.id = checkpoints.period_review_job_id
      WHERE jobs.period_case_id = ? ORDER BY checkpoints.id FOR UPDATE`, [reviewCase.id])
  const checkpointRows = Array.isArray(checkpoints) ? checkpoints : []
  const checkpointTaskIds = checkpointRows.map(row => String(row.model_task_id || '')).filter(Boolean)
  const taskConditions = []
  const taskParams = []
  if (jobIds.length) {
    taskConditions.push(`(domain_type = 'period_review_job' AND domain_id IN (${jobIds.map(() => '?').join(',')}))`)
    taskParams.push(...jobIds.map(String))
  }
  if (checkpointTaskIds.length) {
    taskConditions.push(`task_id IN (${checkpointTaskIds.map(() => '?').join(',')})`)
    taskParams.push(...checkpointTaskIds)
  }
  const [tasks] = taskConditions.length
    ? await run(`SELECT task_id, status FROM ai_model_tasks WHERE ${taskConditions.join(' OR ')} FOR UPDATE`, taskParams)
    : [[]]
  const taskRows = Array.isArray(tasks) ? tasks : []
  const taskById = new Map(taskRows.map(task => [String(task.task_id), task]))
  for (const task of taskRows) {
    if (!MODEL_TASK_TERMINAL_STATES.has(String(task.status || ''))) {
      throw new Error('period_review_regeneration_model_task_unresolved')
    }
  }
  for (const job of jobs || []) {
    if (!job.model_task_id) continue
    const task = taskById.get(String(job.model_task_id))
    if (!task) throw new Error('period_review_regeneration_model_task_missing')
  }
  if (reviewCase.period_type === 'monthly') {
    for (const checkpoint of checkpointRows) {
      if (PERIOD_REVIEW_REGENERATION_UNRESOLVED_CHECKPOINT_STATUSES.has(String(checkpoint.status || ''))) {
        throw new Error('period_review_regeneration_chunk_checkpoint_unresolved')
      }
      if (checkpoint.model_task_id && !taskById.has(String(checkpoint.model_task_id))) {
        throw new Error('period_review_regeneration_chunk_model_task_missing')
      }
    }
  }
}

function periodReviewRegenerationResult(job, reviewCase, { queued = false, created = false } = {}) {
  return {
    queued,
    created,
    jobId:Number(job.id),
    period_case_id:Number(reviewCase.id),
    current_version_id:Number(reviewCase.current_version_id),
    evidence_hash:String(reviewCase.evidence_hash || ''),
    parent_version_id:periodReviewRegenerationParentVersionId(job),
    attempt_count:Number(job.attempt_count || 0),
    job_status:String(job.status || ''),
    progress_stage:String(job.progress_stage || (job.status === 'queued' ? 'queued' : '')),
    idempotency_key:String(job.idempotency_key || ''),
  }
}

/**
 * Queue an explicit AI regeneration while preserving the currently visible
 * version. This is intentionally separate from retryPeriodReviewCase(),
 * whose legacy no-version/failed-job semantics remain unchanged.
 */
export async function regeneratePeriodReviewCase(periodCaseId, actor, { requestIdempotencyKey = null } = {}) {
  const access = periodReviewAccessScope(actor)
  const requestedKey = regenerationRequestKeyFromInput(requestIdempotencyKey)
  const result = await withTransaction(async run => {
    const [rows] = await run(`SELECT cases.* FROM period_review_cases cases
      WHERE cases.id = ? AND ${access.sql} AND cases.status <> 'superseded' FOR UPDATE`, [periodCaseId, ...access.params])
    const reviewCase = rows?.[0]
    if (!reviewCase) throw new Error('period_review_not_found')
    const caseStatus = String(reviewCase.status || '')
    if (!PERIOD_REVIEW_REGENERATION_CASE_STATUSES.has(caseStatus) && caseStatus !== 'generating') {
      throw new Error('period_review_regeneration_case_state_invalid')
    }
    if (reviewCase.evidence_status !== 'complete') throw new Error('period_review_regeneration_evidence_incomplete')
    const currentVersionId = Number(reviewCase.current_version_id || 0)
    if (!currentVersionId) throw new Error('period_review_regeneration_version_missing')
    if (reviewCase.approved_version_id) throw new Error('period_review_regeneration_approved')
    const [versions] = await run(`SELECT * FROM period_review_versions
      WHERE id = ? AND period_case_id = ? FOR UPDATE`, [currentVersionId, periodCaseId])
    const currentVersion = versions?.[0]
    if (!currentVersion) throw new Error('period_review_regeneration_version_missing')
    if (!reviewCase.evidence_hash || !reviewCase.evidence_json) throw new Error('period_review_regeneration_evidence_invalid')
    await run(`SELECT id, outcome_id, source_period_case_id, source_hash
      FROM period_review_sources WHERE period_case_id = ? ORDER BY id FOR UPDATE`, [periodCaseId])
    const jobType = reviewCase.period_type === 'daily' ? 'daily_review' : reviewCase.period_type === 'monthly' ? 'monthly_review' : null
    if (!jobType) throw new Error('invalid_review_period_type')
    const [jobs] = await run(`SELECT * FROM period_review_jobs
      WHERE period_case_id = ? AND job_type = ? ORDER BY job_slot, id FOR UPDATE`, [periodCaseId, jobType])
    const lockedJobs = Array.isArray(jobs) ? jobs : []
    const expectedKey = periodReviewRegenerationKey(reviewCase.period_type, periodCaseId, currentVersionId, reviewCase.evidence_hash, requestedKey)
    const sameRequest = lockedJobs.find(job => String(job.idempotency_key || '') === expectedKey)
    if (sameRequest) return periodReviewRegenerationResult(sameRequest, reviewCase, { queued:!['succeeded', 'failed', 'status_unknown'].includes(String(sameRequest.status || '')) })
    await assertPeriodReviewRegenerationInputs(run, reviewCase, lockedJobs)
    const activeJob = lockedJobs.find(job => isPeriodReviewRegenerationJob(job)
      && PERIOD_REVIEW_REGENERATION_ACTIVE_JOB_STATUSES.has(String(job.status || '')))
    if (activeJob) throw new Error('period_review_regeneration_in_progress')
    if (!PERIOD_REVIEW_REGENERATION_CASE_STATUSES.has(caseStatus)) {
      throw new Error('period_review_regeneration_case_state_invalid')
    }
    const maxSlot = lockedJobs.reduce((max, job) => Math.max(max, Number(job.job_slot || 0)), 0)
    const previousJob = lockedJobs.find(job => Number(job.job_slot || 0) === 0) || lockedJobs[lockedJobs.length - 1] || {}
    const now = beijingNow()
    const [insert] = await run(`INSERT INTO period_review_jobs
      (period_case_id, job_type, job_slot, idempotency_key, status, progress_stage, attempt_count, max_attempts,
       model_profile_id, credential_source, memory_library_version_no, memory_library_content_hash,
       memory_library_snapshot_text, memory_strategy_snapshot_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', 'queued', 0, 3, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      periodCaseId, jobType, maxSlot + 1, expectedKey,
      previousJob.model_profile_id ?? null, previousJob.credential_source ?? null,
      previousJob.memory_library_version_no ?? null, previousJob.memory_library_content_hash ?? null,
      previousJob.memory_library_snapshot_text ?? null, previousJob.memory_strategy_snapshot_text ?? null,
      now, now,
    ])
    const jobId = insertIdFromResult(insert)
    if (!jobId) throw new Error('period_review_regeneration_job_create_failed')
    const [updatedCase] = await run(`UPDATE period_review_cases SET status = 'generating', updated_at = ?
      WHERE id = ? AND current_version_id = ? AND approved_version_id IS NULL
        AND status IN ('draft', 'edited', 'needs_revision', 'deferred')`, [now, periodCaseId, currentVersionId])
    const affectedCase = Number(updatedCase?.affectedRows ?? updatedCase?.changes ?? 0)
    if (affectedCase !== 1) throw new Error('period_review_regeneration_version_conflict')
    await run(`INSERT INTO period_review_job_events
      (job_id, period_case_id, attempt_no, stage, event_status, message_code, metadata_json, created_at)
      VALUES (?, ?, 0, 'queued', 'info', 'manual_regeneration_queued', ?, ?)`, [jobId, periodCaseId,
      JSON.stringify({ parent_version_id:currentVersionId, evidence_hash:String(reviewCase.evidence_hash), source_frozen:true }), now])
    return periodReviewRegenerationResult({ id:jobId, job_slot:maxSlot + 1, idempotency_key:expectedKey,
      status:'queued', progress_stage:'queued', attempt_count:0 }, { ...reviewCase, current_version_id:currentVersionId }, { queued:true, created:true })
  })
  if (result.created) {
    await setPeriodReviewJobStage({ id:result.jobId, period_case_id:periodCaseId, attempt_count:0 }, 'queued', 'info', 'manual_regeneration_queued', {
      parent_version_id:result.parent_version_id, evidence_hash:result.evidence_hash || undefined,
    })
    requestPeriodReviewCycle()
  }
  return result
}

export async function recoverExpiredPeriodReviewJobs() {
  const now = beijingNow()
  const expired = await queryAll(`SELECT id, period_case_id, attempt_count, job_slot, idempotency_key
    FROM period_review_jobs
    WHERE status = 'leased' AND lease_expires_at < ? AND attempt_count >= max_attempts`, [now])
  let recovered = 0
  for (const job of expired) {
    const changed = await withTransaction(async run => {
      const [update] = await run(`UPDATE period_review_jobs SET status = 'failed', progress_stage = 'failed', stage_updated_at = ?,
        last_error_code = 'period_review_model_timeout', lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'leased' AND lease_expires_at < ? AND attempt_count >= max_attempts`, [now, now, job.id, now])
      if (!update.affectedRows) return false
      const regeneration = isPeriodReviewRegenerationJob(job)
      await run(`UPDATE period_review_cases SET status = ?, updated_at = ?
        WHERE id = ? ${regeneration
          ? "AND current_version_id IS NOT NULL AND status IN ('generating', 'needs_revision')"
          : 'AND current_version_id IS NULL'}`,
      [regeneration ? 'needs_revision' : 'failed', now, job.period_case_id])
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
  const dailyPreparation = await prepareEligibleDailyReviews(dailyReviewRecoveryRuntimeOptions())
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

// Kept as narrow test seams for the regeneration CAS/failure contract. These
// are not used by the HTTP route or worker runtime.
export const __testFinishDailyReviewSuccess = finishDailyReviewSuccess
export const __testFinishDailyReviewFailure = finishDailyReviewFailure
export const __testRecoverDailyQuotaFailure = recoverDailyQuotaFailure
export const __testFinishMonthlyReviewSuccess = finishMonthlyReviewSuccess
export const __testFinishMonthlyReviewFailure = finishMonthlyReviewFailure
export const __testDailyReviewTaskIdentity = dailyReviewTaskIdentity
export const __testLoadDailyReviewCheckpoint = loadDailyReviewCheckpoint
