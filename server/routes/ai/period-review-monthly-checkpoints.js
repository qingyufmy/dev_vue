import crypto from 'node:crypto'
import { queryAll, queryOne, queryRun, withTransaction } from '../../db.js'

/**
 * Monthly review checkpoints deliberately do not import period-review.js.  The
 * monthly worker can therefore adopt this persistence boundary without making
 * the checkpoint table a second review-version ledger.
 */

export const MONTHLY_REVIEW_CHECKPOINT_TABLE = 'period_review_monthly_checkpoints'
export const DEFAULT_MONTHLY_REVIEW_CHUNK_SIZE = 8
export const MONTHLY_REVIEW_CHECKPOINT_STATUSES = Object.freeze({
  QUEUED: 'queued',
  LEASED: 'leased',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  STATUS_UNKNOWN: 'status_unknown',
  SUPERSEDED: 'superseded',
})

const CHECKPOINT_TERMINAL_STATUSES = new Set([
  MONTHLY_REVIEW_CHECKPOINT_STATUSES.SUCCEEDED,
  MONTHLY_REVIEW_CHECKPOINT_STATUSES.FAILED,
  MONTHLY_REVIEW_CHECKPOINT_STATUSES.STATUS_UNKNOWN,
  MONTHLY_REVIEW_CHECKPOINT_STATUSES.SUPERSEDED,
])

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

/**
 * JSON with object keys sorted recursively.  This is intentionally local to
 * this module: the chunk identity must not depend on insertion order from a
 * caller's parsed evidence object.
 */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? 'null' : encoded
  }
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

export function monthlyReviewHash(value) {
  return sha256(stableJson(value))
}

function sourceId(source) {
  const raw = source?.period_case_id ?? source?.periodCaseId ?? source?.id
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('monthly_review_source_period_case_id_invalid')
  return id
}

function sourcePeriodKey(source) {
  const value = source?.period_key ?? source?.periodKey ?? source?.trade_date ?? source?.date
  const text = String(value || '')
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null
}

/**
 * Normalize sources once at the boundary.  A source is never silently merged
 * with another source: duplicate period_case_id values are rejected before a
 * checkpoint plan can be persisted.
 */
export function normalizeMonthlyReviewSources(evidenceOrSources) {
  const input = Array.isArray(evidenceOrSources)
    ? evidenceOrSources
    : evidenceOrSources?.sources
  if (!Array.isArray(input) || input.length === 0) throw new Error('monthly_review_sources_invalid')

  const normalized = input.map(source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('monthly_review_source_invalid')
    }
    const periodCaseId = sourceId(source)
    return { ...source, period_case_id: periodCaseId }
  })
  normalized.sort((left, right) => {
    const leftDate = sourcePeriodKey(left)
    const rightDate = sourcePeriodKey(right)
    const dateDifference = leftDate && rightDate ? leftDate.localeCompare(rightDate) : 0
    const idDifference = left.period_case_id - right.period_case_id
    return dateDifference || idDifference || stableJson(left).localeCompare(stableJson(right))
  })
  const seen = new Set()
  for (const source of normalized) {
    if (seen.has(source.period_case_id)) throw new Error('monthly_review_source_duplicate_period_case_id')
    seen.add(source.period_case_id)
  }
  return normalized
}

function expectedIdsForSources(sources) {
  return [...new Set(sources.map(source => source.period_case_id))].sort((a, b) => a - b)
}

function sourceHashForSources(sources) {
  return monthlyReviewHash(sources)
}

function expectedIdSetHash(ids) {
  return monthlyReviewHash([...ids].map(Number).sort((a, b) => a - b))
}

function evidenceHashFor(evidence, sources, explicitEvidenceHash = null) {
  const explicit = explicitEvidenceHash || evidence?.evidence_hash || evidence?.evidenceHash
  if (explicit) return String(explicit)
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const copy = { ...evidence, sources }
    delete copy.evidence_hash
    delete copy.evidenceHash
    return monthlyReviewHash(copy)
  }
  return monthlyReviewHash({ sources })
}

/**
 * Build a deterministic map/reduce plan.  `chunk_index` is zero based and
 * source order is always period_case_id ascending, independent of DB order.
 */
export function buildMonthlyReviewChunks(evidenceOrSources, {
  maxDays = DEFAULT_MONTHLY_REVIEW_CHUNK_SIZE,
  evidenceHash = null,
} = {}) {
  const sources = normalizeMonthlyReviewSources(evidenceOrSources)
  const chunkSize = Math.max(1, Math.min(365, Number(maxDays) || DEFAULT_MONTHLY_REVIEW_CHUNK_SIZE))
  const expectedPeriodCaseIds = expectedIdsForSources(sources)
  const expectedIdHash = expectedIdSetHash(expectedPeriodCaseIds)
  const sourceHash = sourceHashForSources(sources)
  const resolvedEvidenceHash = evidenceHashFor(evidenceOrSources, sources, evidenceHash)
  const datedSources = sources.every(source => sourcePeriodKey(source) != null)
  const bucketed = new Map()
  if (datedSources) {
    for (const source of sources) {
      const day = Number(sourcePeriodKey(source).slice(8, 10))
      const bucket = Math.floor((day - 1) / chunkSize)
      const group = bucketed.get(bucket) || []
      group.push(source)
      bucketed.set(bucket, group)
    }
  } else {
    for (let offset = 0; offset < sources.length; offset += chunkSize) {
      bucketed.set(bucketed.size, sources.slice(offset, offset + chunkSize))
    }
  }
  const bucketEntries = [...bucketed.entries()].sort(([left], [right]) => left - right)
  const chunks = []
  for (const [bucketIndex, chunkSources] of bucketEntries) {
    const ids = expectedIdsForSources(chunkSources)
    const chunkSourceHash = sourceHashForSources(chunkSources)
    const chunkExpectedIdHash = expectedIdSetHash(ids)
    const chunkIndex = datedSources ? Number(bucketIndex) : chunks.length
    chunks.push({
      chunk_index: chunkIndex,
      chunkIndex,
      chunk_count: Math.ceil(sources.length / chunkSize),
      chunkCount: Math.ceil(sources.length / chunkSize),
      max_days: chunkSize,
      maxDays: chunkSize,
      sources: chunkSources,
      period_case_ids: ids,
      periodCaseIds: ids,
      expected_period_case_ids: ids,
      expectedPeriodCaseIds: ids,
      expected_ids_hash: chunkExpectedIdHash,
      expectedIdHash: chunkExpectedIdHash,
      expected_id_set_hash: chunkExpectedIdHash,
      expectedIdSetHash: chunkExpectedIdHash,
      source_hash: chunkSourceHash,
      sourceHash: chunkSourceHash,
      evidence_hash: resolvedEvidenceHash,
      evidenceHash: resolvedEvidenceHash,
    })
  }
  return {
    evidence_hash: resolvedEvidenceHash,
    evidenceHash: resolvedEvidenceHash,
    source_hash: sourceHash,
    sourceHash,
    expected_period_case_ids: expectedPeriodCaseIds,
    expectedPeriodCaseIds,
    expected_ids_hash: expectedIdHash,
    expectedIdHash,
    expected_id_set_hash: expectedIdHash,
    expectedIdSetHash: expectedIdHash,
    max_days: chunkSize,
    maxDays: chunkSize,
    chunks,
  }
}

export const buildMonthlyReviewChunkPlan = buildMonthlyReviewChunks
export const deterministicMonthlyReviewChunks = buildMonthlyReviewChunks

function checkpointIdFrom(input) {
  return input?.checkpointId ?? input?.checkpoint_id ?? input?.id
}

function jobIdFrom(input) {
  return input?.periodReviewJobId ?? input?.period_review_job_id ?? input?.jobId ?? input?.job_id
}

function leaseTokenFrom(input) {
  return input?.leaseToken ?? input?.lease_token
}

function fencingTokenFrom(input) {
  const value = input?.fencingToken ?? input?.fencing_token
  return value == null ? null : Number(value)
}

function affectedRows(result) {
  const value = Array.isArray(result) ? result[0] : result
  return Number(value?.affectedRows ?? value?.changes ?? 0)
}

function jsonOrNull(value) {
  return value == null ? null : stableJson(value)
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function checkpointError(code, details = null) {
  const error = new Error(code)
  error.code = code
  if (details && typeof details === 'object') Object.assign(error, details)
  return error
}

function planInput(input, options = {}) {
  if (Array.isArray(input) || input?.sources) {
    return { evidence:input, periodReviewJobId:options.periodReviewJobId ?? options.period_review_job_id ?? options.jobId ?? options.job_id,
      evidenceHash:options.evidenceHash ?? options.evidence_hash, ...options }
  }
  return { ...(input || {}), ...options,
    periodReviewJobId:jobIdFrom({ ...(input || {}), ...options }) }
}

function planForInput(input, options = {}) {
  const resolved = planInput(input, options)
  const periodReviewJobId = Number(resolved.periodReviewJobId)
  if (!Number.isSafeInteger(periodReviewJobId) || periodReviewJobId <= 0) throw new Error('monthly_review_job_id_invalid')
  if (!resolved.evidence) throw new Error('monthly_review_evidence_invalid')
  const plan = buildMonthlyReviewChunks(resolved.evidence, {
    maxDays:resolved.maxDays ?? resolved.max_days ?? DEFAULT_MONTHLY_REVIEW_CHUNK_SIZE,
    evidenceHash:resolved.evidenceHash ?? resolved.evidence_hash,
  })
  return { ...resolved, periodReviewJobId, plan }
}

function rowChunkIndex(row) {
  return Number(row?.chunk_index ?? row?.chunkIndex)
}

function rowExpectedIds(row) {
  const value = parseJson(row?.expected_period_case_ids_json ?? row?.expected_ids_json ?? row?.expected_period_case_ids, [])
  return Array.isArray(value) ? value.map(Number).filter(Number.isSafeInteger).sort((a, b) => a - b) : []
}

function currentChunkByIndex(plan, index) {
  return plan.chunks.find(chunk => chunk.chunk_index === Number(index)) || null
}

function sourceMatchesChunk(row, chunk) {
  return String(row?.source_hash || '') === String(chunk?.source_hash || '')
    && String(row?.expected_ids_hash || row?.expected_id_set_hash || '') === String(chunk?.expected_ids_hash || '')
}

function checkpointRowValues(periodReviewJobId, planChunk, nowUtcMs) {
  return [periodReviewJobId, planChunk.evidence_hash, planChunk.source_hash, planChunk.chunk_index,
    planChunk.chunk_count, planChunk.max_days, jsonOrNull(planChunk.expected_period_case_ids),
    planChunk.expected_ids_hash, jsonOrNull(planChunk.sources), MONTHLY_REVIEW_CHECKPOINT_STATUSES.QUEUED,
    nowUtcMs, nowUtcMs]
}

function checkpointReuseValues(periodReviewJobId, planChunk, previous, nowUtcMs) {
  return [periodReviewJobId, planChunk.evidence_hash, planChunk.source_hash, planChunk.chunk_index,
    planChunk.chunk_count, planChunk.max_days, jsonOrNull(planChunk.expected_period_case_ids),
    planChunk.expected_ids_hash, jsonOrNull(planChunk.sources), MONTHLY_REVIEW_CHECKPOINT_STATUSES.SUCCEEDED,
    previous.model_task_id || null, previous.content_json || null, previous.content_hash || null,
    previous.id, previous.completed_at_utc_msc || nowUtcMs, nowUtcMs, nowUtcMs]
}

/**
 * Idempotently materialize all chunks for a frozen monthly evidence set.
 * Existing succeeded rows whose source/expected hashes are unchanged are not
 * touched. Older evidence revisions remain in the table as superseded rows.
 */
export async function ensureMonthlyReviewCheckpoints(input, options = {}) {
  const { periodReviewJobId, plan } = planForInput(input, options)
  const nowUtcMs = Number((planInput(input, options)).nowUtcMs) || Date.now()
  return withTransaction(async run => {
    const [existingRows] = await run(`SELECT * FROM ${MONTHLY_REVIEW_CHECKPOINT_TABLE}
      WHERE period_review_job_id = ? ORDER BY evidence_hash, chunk_index FOR UPDATE`, [periodReviewJobId])
    const existing = Array.isArray(existingRows) ? existingRows : []
    let superseded = 0
    for (const row of existing) {
      const current = currentChunkByIndex(plan, rowChunkIndex(row))
      // A succeeded checkpoint can be carried into a new frozen evidence
      // revision when the exact source chunk is unchanged.  It remains an
      // immutable row in the old revision; the new row records its lineage.
      if (current && String(row.status) === MONTHLY_REVIEW_CHECKPOINT_STATUSES.SUCCEEDED
        && sourceMatchesChunk(row, current)) continue
      if (String(row.evidence_hash) === String(plan.evidenceHash)
        && current && sourceMatchesChunk(row, current)) continue
      if (String(row.status) === MONTHLY_REVIEW_CHECKPOINT_STATUSES.SUPERSEDED) continue
      const result = await run(`UPDATE ${MONTHLY_REVIEW_CHECKPOINT_TABLE}
        SET status = 'superseded', superseded_reason = ?, lease_token = NULL,
          lease_owner = NULL, lease_expires_at_utc_msc = NULL, fencing_token = fencing_token + 1,
          updated_at_utc_msc = ? WHERE id = ? AND status <> 'superseded'`,
      ['monthly_review_source_changed', nowUtcMs, row.id])
      superseded += affectedRows(result)
    }
    let created = 0
    for (const chunk of plan.chunks) {
      const same = existing.find(row => String(row.evidence_hash) === String(plan.evidenceHash)
        && rowChunkIndex(row) === chunk.chunk_index)
      if (same) {
        // A same-key row can only be reused when its source identity is still
        // the same.  Source revisions normally carry a new evidence_hash. If
        // a caller reuses a key incorrectly, fail closed instead of overwriting
        // a succeeded result in place.
        if (!sourceMatchesChunk(same, chunk)) {
          throw checkpointError('monthly_review_checkpoint_identity_conflict', {
            checkpoint: same, chunk,
          })
        }
        continue
      }
      const reusable = existing.find(row => String(row.status) === MONTHLY_REVIEW_CHECKPOINT_STATUSES.SUCCEEDED
        && rowChunkIndex(row) === chunk.chunk_index && sourceMatchesChunk(row, chunk)
        && row.content_json && row.content_hash)
      if (reusable) {
        const result = await run(`INSERT INTO ${MONTHLY_REVIEW_CHECKPOINT_TABLE}
          (period_review_job_id, evidence_hash, source_hash, chunk_index, chunk_count, max_days,
           expected_period_case_ids_json, expected_ids_hash, sources_json, status, model_task_id,
           content_json, content_hash, reused_from_checkpoint_id, completed_at_utc_msc,
           created_at_utc_msc, updated_at_utc_msc)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE updated_at_utc_msc = updated_at_utc_msc`,
        checkpointReuseValues(periodReviewJobId, chunk, reusable, nowUtcMs))
        created += affectedRows(result)
        continue
      }
      const result = await run(`INSERT INTO ${MONTHLY_REVIEW_CHECKPOINT_TABLE}
        (period_review_job_id, evidence_hash, source_hash, chunk_index, chunk_count, max_days,
         expected_period_case_ids_json, expected_ids_hash, sources_json, status,
         created_at_utc_msc, updated_at_utc_msc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE updated_at_utc_msc = updated_at_utc_msc`,
      checkpointRowValues(periodReviewJobId, chunk, nowUtcMs))
      created += affectedRows(result)
    }
    const [rows] = await run(`SELECT * FROM ${MONTHLY_REVIEW_CHECKPOINT_TABLE}
      WHERE period_review_job_id = ? AND evidence_hash = ? ORDER BY chunk_index`, [periodReviewJobId, plan.evidenceHash])
    return { ...plan, checkpoints:Array.isArray(rows) ? rows : [], created, superseded }
  })
}

export const createMonthlyReviewCheckpoints = ensureMonthlyReviewCheckpoints
export const materializeMonthlyReviewCheckpoints = ensureMonthlyReviewCheckpoints

/** Claim the first queued/expired leased chunk. Explicit failures can return
 * only after their bounded retry time; status-unknown rows are never eligible
 * because the provider outcome still needs reconciliation. */
export async function claimMonthlyReviewCheckpoint(input = {}, options = {}) {
  const resolved = { ...(input || {}), ...options }
  const periodReviewJobId = Number(jobIdFrom(resolved))
  if (!Number.isSafeInteger(periodReviewJobId) || periodReviewJobId <= 0) throw new Error('monthly_review_job_id_invalid')
  const nowUtcMs = Number(resolved.nowUtcMs) || Date.now()
  const leaseMs = Math.max(1_000, Number(resolved.leaseMs ?? resolved.lease_ms) || 120_000)
  const workerId = resolved.workerId ?? resolved.worker_id ?? null
  const evidenceHash = resolved.evidenceHash ?? resolved.evidence_hash ?? null
  return withTransaction(async run => {
    const params = [periodReviewJobId]
    let hashClause = ''
    if (evidenceHash) { hashClause = ' AND evidence_hash = ?'; params.push(String(evidenceHash)) }
    params.push(nowUtcMs, nowUtcMs)
    const [rows] = await run(`SELECT * FROM ${MONTHLY_REVIEW_CHECKPOINT_TABLE}
      WHERE period_review_job_id = ? ${hashClause}
        AND (status = 'queued'
          OR (status = 'failed' AND attempt_count < max_attempts
            AND next_attempt_at_utc_msc IS NOT NULL AND next_attempt_at_utc_msc <= ?)
          OR (status = 'leased' AND lease_expires_at_utc_msc <= ?
            AND (model_task_id IS NULL OR EXISTS (
              SELECT 1 FROM ai_model_tasks task
              WHERE task.task_id = model_task_id AND task.status IN ('queued','retry_wait')
            ))))
      ORDER BY chunk_index, id LIMIT 1 FOR UPDATE`, params)
    const row = rows?.[0]
    if (!row) return null
    const leaseToken = crypto.randomUUID()
    const fencingToken = Number(row.fencing_token || 0) + 1
    const expiresAt = nowUtcMs + leaseMs
    const result = await run(`UPDATE ${MONTHLY_REVIEW_CHECKPOINT_TABLE}
      SET status = 'leased', lease_token = ?, lease_owner = ?, lease_expires_at_utc_msc = ?,
        fencing_token = ?, attempt_count = attempt_count + 1, next_attempt_at_utc_msc = NULL,
        updated_at_utc_msc = ?
      WHERE id = ? AND (status = 'queued'
        OR (status = 'failed' AND attempt_count < max_attempts
          AND next_attempt_at_utc_msc IS NOT NULL AND next_attempt_at_utc_msc <= ?)
        OR (status = 'leased' AND lease_expires_at_utc_msc <= ?
          AND (model_task_id IS NULL OR EXISTS (
            SELECT 1 FROM ai_model_tasks task
            WHERE task.task_id = model_task_id AND task.status IN ('queued','retry_wait')
          ))))`,
    [leaseToken, workerId, expiresAt, fencingToken, nowUtcMs, row.id, nowUtcMs, nowUtcMs])
    if (affectedRows(result) !== 1) return null
    return { ...row, status:'leased', lease_token:leaseToken, lease_owner:workerId,
      lease_expires_at_utc_msc:expiresAt, fencing_token:fencingToken,
      attempt_count:Number(row.attempt_count || 0) + 1 }
  })
}

export const claimNextMonthlyReviewCheckpoint = claimMonthlyReviewCheckpoint

export async function renewMonthlyReviewCheckpointLease(input = {}, options = {}) {
  const resolved = { ...(input || {}), ...options }
  const checkpointId = checkpointIdFrom(resolved)
  const leaseToken = leaseTokenFrom(resolved)
  const fencingToken = fencingTokenFrom(resolved)
  if (!checkpointId || !leaseToken || fencingToken == null) throw new Error('monthly_review_checkpoint_lease_invalid')
  const nowUtcMs = Number(resolved.nowUtcMs) || Date.now()
  const leaseMs = Math.max(1_000, Number(resolved.leaseMs ?? resolved.lease_ms) || 120_000)
  const result = await queryRun(`UPDATE ${MONTHLY_REVIEW_CHECKPOINT_TABLE}
    SET lease_expires_at_utc_msc = ?, updated_at_utc_msc = ?
    WHERE id = ? AND status = 'leased' AND lease_token = ? AND fencing_token = ?`,
  [nowUtcMs + leaseMs, nowUtcMs, checkpointId, leaseToken, fencingToken])
  return affectedRows(result) === 1
}

export const renewMonthlyReviewCheckpoint = renewMonthlyReviewCheckpointLease

export async function linkMonthlyReviewCheckpointModelTask(input = {}, options = {}) {
  const resolved = { ...(input || {}), ...options }
  const checkpointId = checkpointIdFrom(resolved)
  const leaseToken = leaseTokenFrom(resolved)
  const fencingToken = fencingTokenFrom(resolved)
  const modelTaskId = resolved.modelTaskId ?? resolved.model_task_id
  if (!checkpointId || !leaseToken || fencingToken == null || !modelTaskId) {
    throw new Error('monthly_review_checkpoint_model_task_link_invalid')
  }
  const result = await queryRun(`UPDATE ${MONTHLY_REVIEW_CHECKPOINT_TABLE}
    SET model_task_id = ?, updated_at_utc_msc = ?
    WHERE id = ? AND status = 'leased' AND lease_token = ? AND fencing_token = ?`,
  [String(modelTaskId), Number(resolved.nowUtcMs) || Date.now(), checkpointId, leaseToken, fencingToken])
  if (affectedRows(result) !== 1) throw checkpointError('monthly_review_checkpoint_fence_lost')
  return true
}

export const attachMonthlyReviewCheckpointModelTask = linkMonthlyReviewCheckpointModelTask
export const setMonthlyReviewCheckpointModelTask = linkMonthlyReviewCheckpointModelTask

function assessmentItems(content) {
  if (Array.isArray(content)) return content
  if (!content || typeof content !== 'object') return null
  for (const key of ['daily_assessments', 'trade_assessments', 'assessments', 'items', 'outcomes']) {
    if (Array.isArray(content[key])) return content[key]
  }
  if (content.period_case_id != null || content.periodCaseId != null) return [content]
  return null
}

function assessmentPeriodCaseId(item) {
  const value = item?.period_case_id ?? item?.periodCaseId
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** Validate one chunk without merging or repairing model output. */
export function validateMonthlyReviewCheckpointContent(content, expectedPeriodCaseIds, {
  requireAll = true,
} = {}) {
  const expected = [...new Set((expectedPeriodCaseIds || []).map(Number))].sort((a, b) => a - b)
  if (!expected.length) throw checkpointError('monthly_review_checkpoint_expected_ids_invalid')
  const items = assessmentItems(content)
  if (!items) throw checkpointError('monthly_review_checkpoint_content_invalid')
  const ids = items.map(assessmentPeriodCaseId)
  if (ids.some(id => id == null)) throw checkpointError('monthly_review_checkpoint_period_case_id_invalid')
  const expectedSet = new Set(expected)
  const fabricatedIds = [...new Set(ids.filter(id => !expectedSet.has(id)))].sort((a, b) => a - b)
  if (fabricatedIds.length) throw checkpointError('monthly_review_checkpoint_fabricated_period_case_id', { fabricatedIds })
  const occurrences = new Map()
  ids.forEach((id, index) => occurrences.set(id, [...(occurrences.get(id) || []), index]))
  const duplicateIds = [...occurrences.entries()].filter(([, indexes]) => indexes.length > 1).map(([id]) => id).sort((a, b) => a - b)
  if (duplicateIds.length) throw checkpointError('monthly_review_checkpoint_duplicate_period_case_id', { duplicateIds })
  const present = new Set(ids)
  const missingIds = expected.filter(id => !present.has(id))
  if (requireAll && missingIds.length) throw checkpointError('monthly_review_checkpoint_missing_period_case_id', { missingIds })
  return { content, items, ids, expectedPeriodCaseIds:expected, missingIds, duplicateIds, fabricatedIds }
}

export const validateMonthlyReviewChunkContent = validateMonthlyReviewCheckpointContent

export async function persistMonthlyReviewCheckpointContent(input = {}, options = {}) {
  const resolved = { ...(input || {}), ...options }
  const checkpointId = checkpointIdFrom(resolved)
  const leaseToken = leaseTokenFrom(resolved)
  const fencingToken = fencingTokenFrom(resolved)
  if (!checkpointId || !leaseToken || fencingToken == null) throw new Error('monthly_review_checkpoint_lease_invalid')
  const row = resolved.checkpoint || await queryOne(`SELECT * FROM ${MONTHLY_REVIEW_CHECKPOINT_TABLE} WHERE id = ?`, [checkpointId])
  if (!row) throw new Error('monthly_review_checkpoint_missing')
  const expectedIds = resolved.expectedPeriodCaseIds || resolved.expected_period_case_ids || rowExpectedIds(row)
  const validation = validateMonthlyReviewCheckpointContent(resolved.content, expectedIds, resolved.validationOptions || {})
  if (typeof resolved.validateContent === 'function') await resolved.validateContent(resolved.content, expectedIds, row)
  const contentJson = stableJson(resolved.content)
  const contentHash = sha256(contentJson)
  const nowUtcMs = Number(resolved.nowUtcMs) || Date.now()
  const result = await queryRun(`UPDATE ${MONTHLY_REVIEW_CHECKPOINT_TABLE}
    SET status = 'succeeded', content_json = ?, content_hash = ?,
      completed_at_utc_msc = ?, lease_token = NULL, lease_owner = NULL,
      lease_expires_at_utc_msc = NULL, updated_at_utc_msc = ?, error_code = NULL,
      error_message = NULL
    WHERE id = ? AND status = 'leased' AND lease_token = ? AND fencing_token = ?`,
  [contentJson, contentHash, nowUtcMs, nowUtcMs, checkpointId, leaseToken, fencingToken])
  if (affectedRows(result) !== 1) throw checkpointError('monthly_review_checkpoint_fence_lost')
  return { ...row, status:'succeeded', content_json:contentJson, content_hash:contentHash,
    completed_at_utc_msc:nowUtcMs, validation }
}

export const persistValidatedMonthlyReviewCheckpoint = persistMonthlyReviewCheckpointContent
export const completeMonthlyReviewCheckpoint = persistMonthlyReviewCheckpointContent

/** Explicitly terminate a checkpoint. Neither failure mode is requeued here. */
export async function releaseMonthlyReviewCheckpoint(input = {}, options = {}) {
  const resolved = { ...(input || {}), ...options }
  const status = String(resolved.status || resolved.releaseStatus || resolved.release_status || '')
  if (![MONTHLY_REVIEW_CHECKPOINT_STATUSES.FAILED, MONTHLY_REVIEW_CHECKPOINT_STATUSES.STATUS_UNKNOWN].includes(status)) {
    throw new Error('monthly_review_checkpoint_release_status_invalid')
  }
  const checkpointId = checkpointIdFrom(resolved)
  const leaseToken = leaseTokenFrom(resolved)
  const fencingToken = fencingTokenFrom(resolved)
  if (!checkpointId || !leaseToken || fencingToken == null) throw new Error('monthly_review_checkpoint_lease_invalid')
  const nowUtcMs = Number(resolved.nowUtcMs) || Date.now()
  const current = resolved.checkpoint || await queryOne(`SELECT attempt_count, max_attempts
    FROM ${MONTHLY_REVIEW_CHECKPOINT_TABLE} WHERE id = ?`, [checkpointId])
  const attemptCount = Math.max(0, Number(current?.attempt_count ?? resolved.attemptCount ?? resolved.attempt_count ?? 0))
  const maxAttempts = Math.max(1, Number(current?.max_attempts ?? resolved.maxAttempts ?? resolved.max_attempts ?? 3))
  const retryDelayMs = Math.min(15 * 60_000, Math.max(1_000,
    Number(resolved.retryDelayMs ?? resolved.retry_delay_ms) || (60_000 * (2 ** Math.max(0, attemptCount - 1)))))
  const nextAttemptAtUtcMs = status === MONTHLY_REVIEW_CHECKPOINT_STATUSES.FAILED && attemptCount < maxAttempts
    ? nowUtcMs + retryDelayMs : null
  const errorCode = String(resolved.errorCode ?? resolved.error_code ?? (status === 'status_unknown' ? 'provider_status_unknown' : 'monthly_review_checkpoint_failed')).slice(0, 128)
  const errorMessage = String(resolved.errorMessage ?? resolved.error_message ?? errorCode).slice(0, 512)
  const result = await queryRun(`UPDATE ${MONTHLY_REVIEW_CHECKPOINT_TABLE}
    SET status = ?, error_code = ?, error_message = ?, lease_token = NULL, lease_owner = NULL,
      lease_expires_at_utc_msc = NULL, fencing_token = fencing_token + 1,
      next_attempt_at_utc_msc = ?, updated_at_utc_msc = ?
    WHERE id = ? AND status = 'leased' AND lease_token = ? AND fencing_token = ?`,
  [status, errorCode, errorMessage, nextAttemptAtUtcMs, nowUtcMs, checkpointId, leaseToken, fencingToken])
  if (affectedRows(result) !== 1) throw checkpointError('monthly_review_checkpoint_fence_lost')
  return { checkpointId, status, errorCode, errorMessage, attemptCount, maxAttempts,
    nextAttemptAtUtcMs, retryable:nextAttemptAtUtcMs != null }
}

export const failMonthlyReviewCheckpoint = (input, options = {}) => releaseMonthlyReviewCheckpoint(input, { ...options, status:'failed' })
export const markMonthlyReviewCheckpointStatusUnknown = (input, options = {}) => releaseMonthlyReviewCheckpoint(input, { ...options, status:'status_unknown' })

function checkpointContent(row) {
  return parseJson(row?.content_json ?? row?.content, null)
}

function contentRecordEntries(rows) {
  const records = []
  for (const row of rows) {
    const content = checkpointContent(row)
    const items = assessmentItems(content) || []
    items.forEach((item, itemIndex) => records.push({
      period_case_id:assessmentPeriodCaseId(item),
      item,
      item_index:itemIndex,
      chunk_index:rowChunkIndex(row),
      checkpoint_id:row.id,
      row,
    }))
  }
  return records
}

/**
 * Deterministic all-chunk coverage check.  Conflicts are returned as groups of
 * records; no duplicate is selected or merged into a winning assessment.
 */
export function verifyMonthlyReviewCheckpointCoverage(rowsOrContents, expectedPeriodCaseIds, {
  includeRecords = true,
} = {}) {
  const rows = Array.isArray(rowsOrContents) ? rowsOrContents : []
  const expected = [...new Set((expectedPeriodCaseIds || []).map(Number))].sort((a, b) => a - b)
  const records = rows.every(row => row && typeof row === 'object' && ('content_json' in row || 'content' in row || 'id' in row))
    ? contentRecordEntries(rows)
    : contentRecordEntries(rows.map((content, index) => ({ id:index, chunk_index:index, content_json:content })))
  const expectedSet = new Set(expected)
  const byId = new Map()
  const fabricatedIds = new Set()
  const invalidRecordIndexes = []
  for (const record of records) {
    if (!Number.isSafeInteger(record.period_case_id)) {
      invalidRecordIndexes.push(record.item_index)
      continue
    }
    if (!expectedSet.has(record.period_case_id)) {
      if (record.period_case_id != null) fabricatedIds.add(record.period_case_id)
      continue
    }
    const current = byId.get(record.period_case_id) || []
    current.push(record)
    byId.set(record.period_case_id, current)
  }
  const missingIds = expected.filter(id => !byId.has(id))
  const duplicateIds = [...byId.entries()].filter(([, values]) => values.length > 1).map(([id]) => id).sort((a, b) => a - b)
  const conflictGroups = duplicateIds.map(id => ({ period_case_id:id, records:byId.get(id).map(record => ({
    chunk_index:record.chunk_index, checkpoint_id:record.checkpoint_id, item_index:record.item_index, item:record.item,
  })) }))
  const result = {
    ok:missingIds.length === 0 && duplicateIds.length === 0 && fabricatedIds.size === 0 && invalidRecordIndexes.length === 0,
    expectedPeriodCaseIds:expected,
    missingIds,
    duplicateIds,
    fabricatedIds:[...fabricatedIds].sort((a, b) => a - b),
    invalidRecordIndexes,
    conflictGroups,
  }
  if (includeRecords) result.records = records
  if (result.ok) {
    result.assessments = expected.map(id => byId.get(id)[0].item)
  } else {
    // Deliberately do not provide a merged assessment list on a conflict.
    result.assessments = null
  }
  return result
}

export const verifyMonthlyReviewCoverage = verifyMonthlyReviewCheckpointCoverage

export function assertMonthlyReviewCheckpointCoverage(rowsOrContents, expectedPeriodCaseIds, options = {}) {
  const coverage = verifyMonthlyReviewCheckpointCoverage(rowsOrContents, expectedPeriodCaseIds, options)
  if (!coverage.ok) throw checkpointError('monthly_review_checkpoint_coverage_invalid', { coverage, conflictGroups:coverage.conflictGroups })
  return coverage
}

export async function loadSucceededMonthlyReviewCheckpoints(input = {}, options = {}) {
  const resolved = { ...(input || {}), ...options }
  const periodReviewJobId = Number(jobIdFrom(resolved))
  if (!Number.isSafeInteger(periodReviewJobId) || periodReviewJobId <= 0) throw new Error('monthly_review_job_id_invalid')
  const evidenceHash = resolved.evidenceHash ?? resolved.evidence_hash ?? null
  const rows = await queryAll(`SELECT * FROM ${MONTHLY_REVIEW_CHECKPOINT_TABLE}
    WHERE period_review_job_id = ? AND status = 'succeeded'${evidenceHash ? ' AND evidence_hash = ?' : ''}
    ORDER BY chunk_index, id`, evidenceHash ? [periodReviewJobId, String(evidenceHash)] : [periodReviewJobId])
  let expectedIds = resolved.expectedPeriodCaseIds || resolved.expected_period_case_ids
  if (!expectedIds && resolved.evidence) expectedIds = buildMonthlyReviewChunks(resolved.evidence, { evidenceHash }).expectedPeriodCaseIds
  if (!expectedIds) {
    expectedIds = [...new Set(rows.flatMap(row => rowExpectedIds(row)))].sort((a, b) => a - b)
  }
  const coverage = assertMonthlyReviewCheckpointCoverage(rows, expectedIds, { includeRecords:true })
  return { checkpoints:rows, chunks:rows, coverage, conflictGroups:coverage.conflictGroups,
    expectedPeriodCaseIds:coverage.expectedPeriodCaseIds, assessments:coverage.assessments }
}

export const loadSucceededMonthlyReviewChunks = loadSucceededMonthlyReviewCheckpoints
export const loadAndVerifyMonthlyReviewCheckpoints = loadSucceededMonthlyReviewCheckpoints

export const __monthlyReviewCheckpointsTest = Object.freeze({
  sha256,
  expectedIdSetHash,
  sourceHashForSources,
  normalizeMonthlyReviewSources,
  assessmentItems,
  assessmentPeriodCaseId,
  rowExpectedIds,
})
