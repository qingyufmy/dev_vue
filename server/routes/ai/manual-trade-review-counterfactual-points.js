import crypto from 'node:crypto'
import { beijingNow, queryAll, queryOne, withTransaction } from '../../db.js'

/**
 * Durable candidate-point ledger for manual-trade-review v3.
 *
 * This module intentionally does not know about model providers.  The caller
 * gives it already-normalized market evidence and model output; credentials
 * and raw provider envelopes are rejected before anything is persisted.
 * Every mutation is fenced by the business job's current lease and generation.
 */

export const MANUAL_TRADE_REVIEW_COUNTERFACTUAL_TABLE = 'manual_trade_review_counterfactual_points'
export const DEFAULT_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_OFFSETS = Object.freeze([-1, 0, 1])
export const MAX_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINTS = 5
export const MAX_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_OFFSET_BARS = 2
export const MANUAL_TRADE_REVIEW_COUNTERFACTUAL_STATUSES = Object.freeze([
  'pending', 'running', 'status_unknown', 'succeeded', 'failed', 'stale', 'conflict',
])
export const MANUAL_TRADE_REVIEW_COUNTERFACTUAL_WRITE_JOB_STATUSES = Object.freeze(['leased', 'generating'])

const STATUS_SET = new Set(MANUAL_TRADE_REVIEW_COUNTERFACTUAL_STATUSES)
const MUTABLE_STATUSES = Object.freeze(['pending', 'running', 'status_unknown'])
const MUTABLE_STATUS_SET = new Set(MUTABLE_STATUSES)
const JOB_STATUS_SET = new Set(MANUAL_TRADE_REVIEW_COUNTERFACTUAL_WRITE_JOB_STATUSES)
const TIMEFRAME_MS = Object.freeze({
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
})
const CREDENTIAL_FIELD_RE = /^(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|client[_-]?secret|credential|credentials|cookie|set-cookie)$/iu
const RAW_PROVIDER_FIELD_RE = /^(?:raw|raw[_-]?(?:provider[_-]?)?(?:response|stream|body)|provider[_-]?(?:response|stream|body)|stream[_-]?chunks?|chunks|choices|http_response|response_body)$/iu

function reviewError(code, detail = code) {
  const error = new Error(detail)
  error.code = code
  return error
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function stableJson(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw reviewError('manual_trade_review_counterfactual_value_invalid')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  throw reviewError('manual_trade_review_counterfactual_value_invalid')
}

export function stableManualTradeReviewCounterfactualJson(value) {
  return stableJson(value)
}

export function hashManualTradeReviewCounterfactualValue(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex')
}

function objectValue(source, ...keys) {
  if (!source || typeof source !== 'object') return undefined
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) return source[key]
  }
  return undefined
}

function integer(value, field, { required = true, min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') {
    if (!required) return null
    throw reviewError(`manual_trade_review_counterfactual_${field}_required`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw reviewError(`manual_trade_review_counterfactual_${field}_invalid`)
  }
  return parsed
}

function signedInteger(value, field, { required = true, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') {
    if (!required) return null
    throw reviewError(`manual_trade_review_counterfactual_${field}_required`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw reviewError(`manual_trade_review_counterfactual_${field}_invalid`)
  }
  return parsed
}

function boundedText(value, field, { required = false, max = 255 } = {}) {
  if (value == null || value === '') {
    if (!required) return null
    throw reviewError(`manual_trade_review_counterfactual_${field}_required`)
  }
  if (typeof value !== 'string') throw reviewError(`manual_trade_review_counterfactual_${field}_invalid`)
  const text = value.trim()
  if (!text && required) throw reviewError(`manual_trade_review_counterfactual_${field}_required`)
  if (text.length > max) throw reviewError(`manual_trade_review_counterfactual_${field}_invalid`)
  return text || null
}

function hash(value, field, { required = false } = {}) {
  const text = boundedText(value, field, { required, max: 128 })
  if (text && !/^[a-f0-9]{64}$/iu.test(text)) {
    throw reviewError(`manual_trade_review_counterfactual_${field}_invalid`)
  }
  return text ? text.toLowerCase() : null
}

function modelTaskId(value) {
  return boundedText(value, 'model_task_id', { required: true, max: 128 })
}

function leaseToken(value) {
  return boundedText(value, 'lease_token', { required: true, max: 128 })
}

function normalizeStatus(value) {
  const status = boundedText(value, 'status', { required: true, max: 24 })
  if (!STATUS_SET.has(status)) throw reviewError('manual_trade_review_counterfactual_status_invalid')
  return status
}

function normalizeErrorCode(value) {
  const code = boundedText(value, 'error_code', { max: 128 })
  if (code && !/^[a-z0-9_.:-]+$/iu.test(code)) {
    throw reviewError('manual_trade_review_counterfactual_error_code_invalid')
  }
  return code
}

function parseJsonValue(value, field) {
  if (value == null || value === '') return null
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { throw reviewError(`manual_trade_review_counterfactual_${field}_invalid`) }
  }
  return value
}

function rejectForbiddenFields(value, path = '', matcher = CREDENTIAL_FIELD_RE, code = 'manual_trade_review_counterfactual_credential_field') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      rejectForbiddenFields(value[index], `${path}[${index}]`, matcher, code)
    }
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (matcher.test(key)) {
      throw reviewError(code, `${code}:${path ? `${path}.` : ''}${key}`)
    }
    rejectForbiddenFields(nested, `${path ? `${path}.` : ''}${key}`, matcher, code)
  }
}

function normalizeOutput(value) {
  const output = parseJsonValue(value, 'normalized_output')
  if (!isPlainObject(output)) throw reviewError('manual_trade_review_counterfactual_normalized_output_invalid')
  rejectForbiddenFields(output)
  rejectForbiddenFields(output, '', RAW_PROVIDER_FIELD_RE, 'manual_trade_review_counterfactual_raw_provider_output_forbidden')
  const normalizedOutputJson = stableJson(output)
  const normalizedOutputHash = hashManualTradeReviewCounterfactualValue(output)
  return { output, normalizedOutput: output, normalizedOutputJson, normalizedOutputHash, outputHash: normalizedOutputHash }
}

function nowDate(value) {
  if (value == null || value === '') return beijingNow()
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw reviewError('manual_trade_review_counterfactual_time_invalid')
    return new Date(value.getTime() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) throw reviewError('manual_trade_review_counterfactual_time_invalid')
    return new Date(date.getTime() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
  }
  const text = String(value).trim()
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(text)) {
    throw reviewError('manual_trade_review_counterfactual_time_invalid')
  }
  return text.replace('T', ' ').slice(0, 19)
}

function pointCandidateKey(offset) {
  if (offset === 0) return 'anchor'
  return offset < 0 ? `anchor_minus_${Math.abs(offset)}` : `anchor_plus_${offset}`
}

function normalizeCandidateKey(value) {
  const key = boundedText(value, 'candidate_key', { required: true, max: 64 })
  if (!/^anchor(?:_(?:minus|plus)_\d+)?$/iu.test(key)) {
    throw reviewError('manual_trade_review_counterfactual_candidate_key_invalid')
  }
  return key
}

function candleTime(candle) {
  const value = objectValue(candle, 'time_utc_msc', 'open_time_utc_msc', 'timeUtcMsc', 'openTimeUtcMsc')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
}

function candleClosedAt(candle, openTimeUtcMsc, timeframeMs) {
  const explicit = objectValue(candle, 'close_time_utc_msc', 'closed_at_utc_msc', 'closeTimeUtcMsc', 'closedAtUtcMsc')
  if (explicit != null && explicit !== '') {
    const parsed = Number(explicit)
    if (!Number.isSafeInteger(parsed) || parsed <= openTimeUtcMsc) return null
    return parsed
  }
  return Number.isSafeInteger(timeframeMs) && timeframeMs > 0 ? openTimeUtcMsc + timeframeMs : null
}

function assertCandleClosed(candle) {
  const closedFlag = objectValue(candle, 'is_closed', 'isClosed', 'closed')
  const closedText = typeof closedFlag === 'string' ? closedFlag.trim().toLowerCase() : null
  if (closedFlag !== undefined && closedFlag !== null
    && (closedFlag === false || closedFlag === 0 || closedText === 'false' || closedText === '0' || closedText === 'open')) {
    throw reviewError('manual_trade_review_counterfactual_candle_not_closed')
  }
  const status = String(objectValue(candle, 'status', 'candle_status') || '').toLowerCase()
  if (['open', 'forming', 'incomplete'].includes(status)) {
    throw reviewError('manual_trade_review_counterfactual_candle_not_closed')
  }
}

function timeframeInterval({ timeframe, timeframeMs } = {}) {
  if (timeframeMs != null && timeframeMs !== '') {
    const interval = integer(timeframeMs, 'timeframe_ms', { min: 1 })
    return interval
  }
  const normalized = String(timeframe || '').trim().toUpperCase()
  if (TIMEFRAME_MS[normalized]) return TIMEFRAME_MS[normalized]
  return null
}

/**
 * Select deterministic points from an already-fetched, ascending sequence of
 * real closed candles.  Offsets are indexes in that sequence, never clock
 * arithmetic; gaps, weekends and DST therefore cannot manufacture a candle.
 */
export function buildManualTradeReviewCounterfactualPoints({
  candles = undefined,
  closedCandles = undefined,
  entryTimeUtcMsc = undefined,
  entryUtcMsc = undefined,
  timeframe = undefined,
  timeframeMs = undefined,
  offsets = DEFAULT_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_OFFSETS,
  maxPoints = MAX_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINTS,
  maxOffsetBars = MAX_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_OFFSET_BARS,
} = {}) {
  const source = candles ?? closedCandles
  if (!Array.isArray(source) || !source.length) {
    throw reviewError('manual_trade_review_counterfactual_candles_required')
  }
  const entry = integer(entryTimeUtcMsc ?? entryUtcMsc, 'entry_time_utc_msc')
  const interval = timeframeInterval({ timeframe, timeframeMs })
  const limit = integer(maxPoints, 'max_points', { min: 1, max: MAX_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINTS })
  const maxOffset = integer(maxOffsetBars, 'max_offset_bars', { min: 0, max: MAX_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINTS - 1 })
  if (!Array.isArray(offsets) || offsets.length === 0 || offsets.length > limit || offsets.length > MAX_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINTS) {
    throw reviewError('manual_trade_review_counterfactual_points_limit')
  }
  const normalizedOffsets = offsets.map(value => signedInteger(value, 'offset_bars', { min: -maxOffset, max: maxOffset }))
  if (new Set(normalizedOffsets).size !== normalizedOffsets.length) {
    throw reviewError('manual_trade_review_counterfactual_offset_duplicate')
  }
  const sequence = source.map((candle, index) => {
    if (!isPlainObject(candle)) throw reviewError('manual_trade_review_counterfactual_candle_invalid')
    assertCandleClosed(candle)
    const open = candleTime(candle)
    if (!open) throw reviewError('manual_trade_review_counterfactual_candle_time_invalid')
    const closed = candleClosedAt(candle, open, interval)
    if (!closed) throw reviewError('manual_trade_review_counterfactual_candle_close_time_invalid')
    return { candle, index, open, closed }
  })
  for (let index = 1; index < sequence.length; index += 1) {
    if (sequence[index].open <= sequence[index - 1].open) {
      throw reviewError('manual_trade_review_counterfactual_candle_sequence_invalid')
    }
    if (sequence[index].closed <= sequence[index - 1].closed) {
      throw reviewError('manual_trade_review_counterfactual_candle_close_sequence_invalid')
    }
  }
  let anchorIndex = -1
  for (let index = 0; index < sequence.length; index += 1) {
    if (sequence[index].closed <= entry) anchorIndex = index
    else break
  }
  if (anchorIndex < 0) throw reviewError('manual_trade_review_counterfactual_anchor_not_found')
  const points = normalizedOffsets.slice().sort((a, b) => a - b).map(offset => {
    const index = anchorIndex + offset
    const item = sequence[index]
    if (!item) throw reviewError('manual_trade_review_counterfactual_candidate_unavailable')
    return {
      candidate_key: pointCandidateKey(offset),
      decision_time_utc_msc: item.closed,
      offset_bars: offset,
    }
  })
  const candidateKeys = new Set()
  const decisionTimes = new Set()
  const offsetsSeen = new Set()
  for (const point of points) {
    if (candidateKeys.has(point.candidate_key)) throw reviewError('manual_trade_review_counterfactual_candidate_duplicate')
    if (decisionTimes.has(point.decision_time_utc_msc)) throw reviewError('manual_trade_review_counterfactual_decision_time_duplicate')
    if (offsetsSeen.has(point.offset_bars)) throw reviewError('manual_trade_review_counterfactual_offset_duplicate')
    candidateKeys.add(point.candidate_key)
    decisionTimes.add(point.decision_time_utc_msc)
    offsetsSeen.add(point.offset_bars)
  }
  return points
}

export const selectManualTradeReviewCounterfactualPoints = buildManualTradeReviewCounterfactualPoints
export const buildCounterfactualCandidatePoints = buildManualTradeReviewCounterfactualPoints
export const buildManualTradeReviewCounterfactualCandidates = buildManualTradeReviewCounterfactualPoints

function rowsFromDb(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0]
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.rows)) return result.rows
  return []
}

function oneFromRunner(run, sql, params = []) {
  return Promise.resolve(run(sql, params)).then(result => rowsFromDb(result)[0] || null)
}

function changedCount(result) {
  return Number(result?.affectedRows ?? result?.changes ?? result?.[0]?.affectedRows ?? 0)
}

function identity(input = {}, { requireCaseId = true } = {}) {
  return {
    caseId: integer(objectValue(input, 'caseId', 'case_id'), 'case_id', { required: requireCaseId }),
    jobId: integer(objectValue(input, 'jobId', 'job_id'), 'job_id'),
    generationNo: integer(objectValue(input, 'generationNo', 'generation_no'), 'generation_no'),
  }
}

function pointIdentity(input = {}) {
  const base = identity(input, { requireCaseId: false })
  return { ...base, candidateKey: normalizeCandidateKey(objectValue(input, 'candidateKey', 'candidate_key')) }
}

function normalizeCandidateInput(candidate, index) {
  if (!isPlainObject(candidate)) throw reviewError('manual_trade_review_counterfactual_candidate_invalid')
  const candidateKey = normalizeCandidateKey(objectValue(candidate, 'candidateKey', 'candidate_key'))
  const decisionTime = integer(objectValue(candidate, 'decisionTimeUtcMsc', 'decision_time_utc_msc'), 'decision_time_utc_msc')
  const offset = signedInteger(objectValue(candidate, 'offsetBars', 'offset_bars'), 'offset_bars', { min: -MAX_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_OFFSET_BARS, max: MAX_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_OFFSET_BARS })
  if (candidateKey !== pointCandidateKey(offset)) {
    throw reviewError('manual_trade_review_counterfactual_candidate_key_mismatch', `candidate[${index}]`)
  }
  return {
    candidateKey,
    decisionTimeUtcMsc: decisionTime,
    offsetBars: offset,
    marketSnapshotHash: hash(objectValue(candidate, 'marketSnapshotHash', 'market_snapshot_hash'), 'market_snapshot_hash'),
    inputHash: hash(objectValue(candidate, 'inputHash', 'input_hash'), 'input_hash'),
  }
}

function normalizeCandidates(input = {}) {
  const candidates = objectValue(input, 'candidates', 'points', 'counterfactualPoints', 'counterfactual_points')
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > MAX_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINTS) {
    throw reviewError('manual_trade_review_counterfactual_points_limit')
  }
  const normalized = candidates.map(normalizeCandidateInput)
  const keys = new Set()
  const times = new Set()
  const offsets = new Set()
  for (const point of normalized) {
    if (keys.has(point.candidateKey)) throw reviewError('manual_trade_review_counterfactual_candidate_duplicate')
    if (times.has(point.decisionTimeUtcMsc)) throw reviewError('manual_trade_review_counterfactual_decision_time_duplicate')
    if (offsets.has(point.offsetBars)) throw reviewError('manual_trade_review_counterfactual_offset_duplicate')
    keys.add(point.candidateKey)
    times.add(point.decisionTimeUtcMsc)
    offsets.add(point.offsetBars)
  }
  return normalized.slice().sort((left, right) => left.offsetBars - right.offsetBars)
}

function parsePointRow(row) {
  if (!row || typeof row !== 'object') throw reviewError('manual_trade_review_counterfactual_row_invalid')
  const status = normalizeStatus(row.status)
  const candidateKey = normalizeCandidateKey(row.candidate_key)
  const offsetBars = signedInteger(row.offset_bars, 'offset_bars', { min: -MAX_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_OFFSET_BARS, max: MAX_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_OFFSET_BARS })
  if (candidateKey !== pointCandidateKey(offsetBars)) throw reviewError('manual_trade_review_counterfactual_candidate_key_mismatch')
  let output = null
  let outputHash = row.normalized_output_hash ? String(row.normalized_output_hash).toLowerCase() : null
  if (row.normalized_output_json != null && row.normalized_output_json !== '') {
    const normalized = normalizeOutput(row.normalized_output_json)
    if (outputHash && outputHash !== normalized.normalizedOutputHash) {
      throw reviewError('manual_trade_review_counterfactual_output_hash_mismatch')
    }
    output = normalized.output
    outputHash = normalized.normalizedOutputHash
  }
  return {
    ...row,
    id: row.id == null ? null : Number(row.id),
    case_id: row.case_id == null ? null : Number(row.case_id),
    job_id: row.job_id == null ? null : Number(row.job_id),
    generation_no: row.generation_no == null ? null : Number(row.generation_no),
    decision_time_utc_msc: Number(row.decision_time_utc_msc),
    offset_bars: offsetBars,
    candidate_key: candidateKey,
    status,
    model_task_id: row.model_task_id || null,
    market_snapshot_hash: row.market_snapshot_hash || null,
    input_hash: row.input_hash || null,
    normalized_output: output,
    normalized_output_hash: outputHash,
    candidateKey,
    decisionTimeUtcMsc: Number(row.decision_time_utc_msc),
    offsetBars,
    modelTaskId: row.model_task_id || null,
    marketSnapshotHash: row.market_snapshot_hash || null,
    inputHash: row.input_hash || null,
    normalizedOutput: output,
    normalizedOutputHash: outputHash,
  }
}

async function assertJobLease(run, { caseId, jobId, generationNo }, token) {
  const job = await oneFromRunner(run, `SELECT id, case_id, generation_no, lease_token, status
    FROM manual_trade_review_jobs
    WHERE id = ? AND generation_no = ? AND lease_token = ?
      AND status IN ('leased', 'generating')
    LIMIT 1 FOR UPDATE`, [jobId, generationNo, token])
  if (!job || Number(job.generation_no) !== generationNo || String(job.lease_token || '') !== token
    || (caseId != null && Number(job.case_id) !== caseId) || !JOB_STATUS_SET.has(String(job.status))) {
    throw reviewError('manual_trade_review_counterfactual_fence_lost')
  }
  return job
}

async function selectPoints(run, { jobId, generationNo }, { forUpdate = false } = {}) {
  const suffix = forUpdate ? ' FOR UPDATE' : ''
  const rows = await run(`SELECT * FROM manual_trade_review_counterfactual_points
    WHERE job_id = ? AND generation_no = ?
    ORDER BY offset_bars ASC, id ASC${suffix}`, [jobId, generationNo])
  return rowsFromDb(rows).map(parsePointRow)
}

/** Atomically create the frozen candidate set for one leased generation. */
export async function ensureManualTradeReviewCounterfactualPoints(input = {}, options = {}) {
  const id = identity(input)
  const token = leaseToken(objectValue(input, 'leaseToken', 'lease_token'))
  const candidates = normalizeCandidates(input)
  const now = nowDate(input.now)
  const runner = options.run || options.runner || input.run || input.runner
  const ensure = async run => {
    await assertJobLease(run, id, token)
    const existing = await selectPoints(run, id, { forUpdate: true })
    const byKey = new Map(existing.map(point => [point.candidate_key, point]))
    if (existing.some(point => Number(point.case_id) !== id.caseId)) {
      throw reviewError('manual_trade_review_counterfactual_identity_mismatch')
    }
    if (existing.length && (existing.length !== candidates.length || candidates.some(point => {
      const current = byKey.get(point.candidateKey)
      return !current || Number(current.decision_time_utc_msc) !== point.decisionTimeUtcMsc || Number(current.offset_bars) !== point.offsetBars
        || String(current.market_snapshot_hash || '') !== String(point.marketSnapshotHash || '')
        || String(current.input_hash || '') !== String(point.inputHash || '')
    }))) {
      throw reviewError('manual_trade_review_counterfactual_set_conflict')
    }
    for (const point of candidates) {
      if (byKey.has(point.candidateKey)) continue
      await run(`INSERT INTO manual_trade_review_counterfactual_points
        (case_id, job_id, generation_no, candidate_key, decision_time_utc_msc, offset_bars,
         status, model_task_id, market_snapshot_hash, input_hash, normalized_output_json,
         normalized_output_hash, last_error_code, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`, [
        id.caseId, id.jobId, id.generationNo, point.candidateKey, point.decisionTimeUtcMsc, point.offsetBars,
        point.marketSnapshotHash, point.inputHash, now, now,
      ])
    }
    return selectPoints(run, id, { forUpdate: true })
  }
  return runner ? ensure(runner) : withTransaction(ensure)
}

export const ensureCounterfactualPoints = ensureManualTradeReviewCounterfactualPoints
export const ensureManualTradeReviewCounterfactualCandidates = ensureManualTradeReviewCounterfactualPoints

export async function readManualTradeReviewCounterfactualPoints(input = {}) {
  const id = identity(input, { requireCaseId: false })
  const rows = await queryAll(`SELECT * FROM manual_trade_review_counterfactual_points
    WHERE job_id = ? AND generation_no = ?
    ORDER BY offset_bars ASC, id ASC`, [id.jobId, id.generationNo])
  const points = rowsFromDb(rows).map(parsePointRow)
  if (id.caseId != null && points.some(point => Number(point.case_id) !== id.caseId)) {
    throw reviewError('manual_trade_review_counterfactual_identity_mismatch')
  }
  return points
}

export const getManualTradeReviewCounterfactualPoints = readManualTradeReviewCounterfactualPoints
export const readCounterfactualPoints = readManualTradeReviewCounterfactualPoints

async function readPointForMutation(run, id, { forUpdate = false } = {}) {
  const suffix = forUpdate ? ' FOR UPDATE' : ''
  return oneFromRunner(run, `SELECT points.*, jobs.case_id AS business_case_id,
      jobs.generation_no AS business_generation_no, jobs.lease_token AS business_lease_token,
      jobs.status AS business_job_status
    FROM manual_trade_review_counterfactual_points points
    JOIN manual_trade_review_jobs jobs ON jobs.id = points.job_id
    WHERE points.job_id = ? AND points.generation_no = ? AND points.candidate_key = ?
    LIMIT 1${suffix}`, [id.jobId, id.generationNo, id.candidateKey])
}

function assertMutationRow(row, id, token) {
  if (!row || Number(row.business_generation_no) !== id.generationNo
    || Number(row.business_case_id) !== id.caseId
    || String(row.business_lease_token || '') !== token
    || !JOB_STATUS_SET.has(String(row.business_job_status))) {
    throw reviewError('manual_trade_review_counterfactual_fence_lost')
  }
}

function mutationStatuses(input, fallback = MUTABLE_STATUSES) {
  const supplied = objectValue(input, 'expectedStatuses', 'expected_statuses')
  const statuses = supplied == null ? fallback : supplied
  if (!Array.isArray(statuses) || !statuses.length) throw reviewError('manual_trade_review_counterfactual_status_invalid')
  const normalized = [...new Set(statuses.map(normalizeStatus))]
  if (normalized.some(status => !MUTABLE_STATUS_SET.has(status))) {
    throw reviewError('manual_trade_review_counterfactual_status_immutable')
  }
  return normalized
}

function placeholders(values) {
  return values.map(() => '?').join(', ')
}

/** Link one point to one provider-neutral model task under the live lease. */
export async function linkManualTradeReviewCounterfactualPointModelTask(input = {}) {
  const id = pointIdentity(input)
  const task = modelTaskId(objectValue(input, 'modelTaskId', 'model_task_id'))
  const inputHash = hash(objectValue(input, 'inputHash', 'input_hash'), 'input_hash')
  const token = leaseToken(objectValue(input, 'leaseToken', 'lease_token'))
  const now = nowDate(input.now)
  const statuses = mutationStatuses(input)
  const runner = input.run || input.runner
  const update = async run => {
    const result = await run(`UPDATE manual_trade_review_counterfactual_points points
      JOIN manual_trade_review_jobs jobs ON jobs.id = points.job_id
      SET points.model_task_id = ?, points.input_hash = COALESCE(points.input_hash, ?),
        points.status = 'running', points.updated_at = ?, points.last_error_code = NULL
      WHERE points.job_id = ? AND points.generation_no = ? AND points.candidate_key = ?
        AND jobs.id = points.job_id AND jobs.generation_no = points.generation_no
        AND jobs.lease_token = ? AND jobs.status IN ('leased', 'generating')
        AND points.status IN (${placeholders(statuses)})
        AND (points.model_task_id IS NULL OR points.model_task_id = ?)
        AND (points.input_hash IS NULL OR points.input_hash = ?)`, [
      task, inputHash, now, id.jobId, id.generationNo, id.candidateKey, token,
      ...statuses, task, inputHash,
    ])
    if (changedCount(result) === 1) return { linked: true, modelTaskId: task, inputHash }
    const current = await readPointForMutation(run, id, { forUpdate: true })
    assertMutationRow(current, id, token)
    if (current.model_task_id === task && (!inputHash || current.input_hash === inputHash)) {
      if (current.status === 'succeeded') return { linked: true, idempotent: true, alreadySucceeded: true, modelTaskId: task, inputHash: current.input_hash || inputHash }
      if (statuses.includes(String(current.status))) return { linked: true, idempotent: true, modelTaskId: task, inputHash: current.input_hash || inputHash }
    }
    if (current.model_task_id && current.model_task_id !== task) {
      throw reviewError('manual_trade_review_counterfactual_model_task_conflict')
    }
    throw reviewError('manual_trade_review_counterfactual_fence_lost')
  }
  try {
    return await (runner ? update(runner) : withTransaction(update))
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062 || /duplicate entry/i.test(String(error?.message || ''))) {
      throw reviewError('manual_trade_review_counterfactual_model_task_conflict')
    }
    throw error
  }
}

export const linkCounterfactualPointModelTask = linkManualTradeReviewCounterfactualPointModelTask
export const linkManualTradeReviewCounterfactualModelTask = linkManualTradeReviewCounterfactualPointModelTask

/** Persist a normalized point result exactly once under the live lease. */
export async function saveManualTradeReviewCounterfactualPointOutput(input = {}) {
  const id = pointIdentity(input)
  const token = leaseToken(objectValue(input, 'leaseToken', 'lease_token'))
  const normalized = normalizeOutput(objectValue(input, 'normalizedOutput', 'normalized_output', 'output'))
  if (normalized.output.candidate_key != null && normalizeCandidateKey(normalized.output.candidate_key) !== id.candidateKey) {
    throw reviewError('manual_trade_review_counterfactual_output_candidate_mismatch')
  }
  const task = objectValue(input, 'modelTaskId', 'model_task_id') == null ? null : modelTaskId(objectValue(input, 'modelTaskId', 'model_task_id'))
  const now = nowDate(input.now)
  const completedAt = nowDate(objectValue(input, 'completedAt', 'completed_at') ?? now)
  const statuses = mutationStatuses(input)
  const runner = input.run || input.runner
  const update = async run => {
    const taskPredicate = task ? ' AND points.model_task_id = ?' : ' AND points.model_task_id IS NOT NULL'
    const params = [normalized.normalizedOutputJson, normalized.normalizedOutputHash, completedAt, now,
      id.jobId, id.generationNo, id.candidateKey, token, ...statuses]
    if (task) params.push(task)
    const result = await run(`UPDATE manual_trade_review_counterfactual_points points
      JOIN manual_trade_review_jobs jobs ON jobs.id = points.job_id
      SET points.status = 'succeeded', points.normalized_output_json = ?,
        points.normalized_output_hash = ?, points.last_error_code = NULL,
        points.completed_at = ?, points.updated_at = ?
      WHERE points.job_id = ? AND points.generation_no = ? AND points.candidate_key = ?
        AND jobs.id = points.job_id AND jobs.generation_no = points.generation_no
        AND jobs.lease_token = ? AND jobs.status IN ('leased', 'generating')
        AND points.status IN (${placeholders(statuses)})
        ${taskPredicate}`, params)
    if (changedCount(result) === 1) return { saved: true, status: 'succeeded', ...normalized }
    const current = await readPointForMutation(run, id, { forUpdate: true })
    assertMutationRow(current, id, token)
    if (current.status === 'succeeded') {
      if (String(current.normalized_output_hash || '').toLowerCase() === normalized.normalizedOutputHash) {
        return { saved: true, idempotent: true, status: 'succeeded', ...normalized }
      }
      throw reviewError('manual_trade_review_counterfactual_output_conflict')
    }
    throw reviewError('manual_trade_review_counterfactual_fence_lost')
  }
  return runner ? update(runner) : withTransaction(update)
}

export const saveCounterfactualPointOutput = saveManualTradeReviewCounterfactualPointOutput
export const markManualTradeReviewCounterfactualPointOutput = saveManualTradeReviewCounterfactualPointOutput

async function updatePointStatus(input = {}, targetStatus) {
  const id = pointIdentity(input)
  const token = leaseToken(objectValue(input, 'leaseToken', 'lease_token'))
  const status = normalizeStatus(targetStatus ?? input.status)
  if (!['status_unknown', 'failed', 'stale', 'conflict'].includes(status)) {
    throw reviewError('manual_trade_review_counterfactual_status_transition_invalid')
  }
  const errorCode = normalizeErrorCode(objectValue(input, 'errorCode', 'error_code'))
  const now = nowDate(input.now)
  const completedAt = ['failed', 'stale', 'conflict'].includes(status) ? now : null
  const statuses = mutationStatuses(input)
  const task = objectValue(input, 'modelTaskId', 'model_task_id') == null ? null : modelTaskId(objectValue(input, 'modelTaskId', 'model_task_id'))
  const runner = input.run || input.runner
  const update = async run => {
    const taskPredicate = task ? ' AND points.model_task_id = ?' : ''
    const params = [status, errorCode, completedAt, now, id.jobId, id.generationNo, id.candidateKey, token, ...statuses]
    if (task) params.push(task)
    const result = await run(`UPDATE manual_trade_review_counterfactual_points points
      JOIN manual_trade_review_jobs jobs ON jobs.id = points.job_id
      SET points.status = ?, points.last_error_code = ?, points.completed_at = ?, points.updated_at = ?
      WHERE points.job_id = ? AND points.generation_no = ? AND points.candidate_key = ?
        AND jobs.id = points.job_id AND jobs.generation_no = points.generation_no
        AND jobs.lease_token = ? AND jobs.status IN ('leased', 'generating')
        AND points.status IN (${placeholders(statuses)})
        AND points.normalized_output_json IS NULL${taskPredicate}`, params)
    if (changedCount(result) === 1) return { updated: true, status, errorCode }
    const current = await readPointForMutation(run, id, { forUpdate: true })
    assertMutationRow(current, id, token)
    if (current.status === status && (current.last_error_code || null) === (errorCode || null)) {
      return { updated: true, idempotent: true, status, errorCode }
    }
    if (current.status === 'succeeded' || current.normalized_output_json != null) {
      throw reviewError('manual_trade_review_counterfactual_output_immutable')
    }
    throw reviewError('manual_trade_review_counterfactual_fence_lost')
  }
  return runner ? update(runner) : withTransaction(update)
}

export async function markManualTradeReviewCounterfactualPointStatus(input = {}) {
  return updatePointStatus(input, input.status)
}

export const markCounterfactualPointStatus = markManualTradeReviewCounterfactualPointStatus

export async function markManualTradeReviewCounterfactualPointUnknown(input = {}) {
  return updatePointStatus(input, 'status_unknown')
}

export const markCounterfactualPointUnknown = markManualTradeReviewCounterfactualPointUnknown

export async function markManualTradeReviewCounterfactualPointFailed(input = {}) {
  return updatePointStatus(input, 'failed')
}

export const markCounterfactualPointFailed = markManualTradeReviewCounterfactualPointFailed
