import crypto from 'node:crypto'
import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'

/**
 * Durable checkpoints for one manual-trade-review generation.
 *
 * This module deliberately knows nothing about model providers or the review
 * worker.  It only persists the server-validated runtime envelope and
 * normalized stage results, and fences every mutation with the business job
 * lease and generation.  Provider credentials and raw provider responses must
 * never be passed to this module.
 */

export const MANUAL_TRADE_REVIEW_STAGE_TABLE = 'manual_trade_review_stage_runs'
export const MANUAL_TRADE_REVIEW_STAGES = Object.freeze(['counterfactual', 'outcome_review'])
export const MANUAL_TRADE_REVIEW_STAGE_NAMES = MANUAL_TRADE_REVIEW_STAGES
export const MANUAL_TRADE_REVIEW_STAGE_STATUSES = Object.freeze([
  'pending', 'running', 'status_unknown', 'succeeded', 'failed', 'stale', 'conflict',
])
export const MANUAL_TRADE_REVIEW_BUSINESS_JOB_STATUSES = Object.freeze(['leased', 'generating'])

const STAGE_SET = new Set(MANUAL_TRADE_REVIEW_STAGES)
const STATUS_SET = new Set(MANUAL_TRADE_REVIEW_STAGE_STATUSES)
const JOB_STATUS_SET = new Set(MANUAL_TRADE_REVIEW_BUSINESS_JOB_STATUSES)

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
    if (!Number.isFinite(value)) throw reviewError('manual_trade_review_runtime_value_invalid')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  throw reviewError('manual_trade_review_runtime_value_invalid')
}

export function stableManualTradeReviewJson(value) {
  return stableJson(value)
}

export function hashManualTradeReviewValue(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex')
}

export const hashFrozenRuntime = hashManualTradeReviewValue

function objectValue(source, ...keys) {
  if (!source || typeof source !== 'object') return undefined
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) return source[key]
  }
  return undefined
}

function integer(value, field, { required = true, min = 1 } = {}) {
  if (value == null || value === '') {
    if (!required) return null
    throw reviewError(`manual_trade_review_${field}_required`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min) throw reviewError(`manual_trade_review_${field}_invalid`)
  return parsed
}

function boundedText(value, field, { required = false, max = 255 } = {}) {
  if (value == null || value === '') {
    if (!required) return null
    throw reviewError(`manual_trade_review_${field}_required`)
  }
  if (typeof value !== 'string') throw reviewError(`manual_trade_review_${field}_invalid`)
  const text = value.trim()
  if (!text && required) throw reviewError(`manual_trade_review_${field}_required`)
  if (text.length > max) throw reviewError(`manual_trade_review_${field}_invalid`)
  return text || null
}

function boundedHash(value, field, { required = false } = {}) {
  const hash = boundedText(value, field, { required, max: 128 })
  if (hash && !/^[a-f0-9]{64}$/iu.test(hash)) throw reviewError(`manual_trade_review_${field}_invalid`)
  return hash ? hash.toLowerCase() : null
}

function rejectCredentialFields(value, path = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) rejectCredentialFields(value[i], `${path}[${i}]`)
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (CREDENTIAL_FIELD_RE.test(key)) {
      throw reviewError('manual_trade_review_runtime_credential_field', `manual_trade_review_runtime_credential_field:${path ? `${path}.` : ''}${key}`)
    }
    rejectCredentialFields(nested, `${path ? `${path}.` : ''}${key}`)
  }
}

function rejectRawProviderFields(value, path = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) rejectRawProviderFields(value[i], `${path}[${i}]`)
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (RAW_PROVIDER_FIELD_RE.test(key)) {
      throw reviewError('manual_trade_review_raw_provider_output_forbidden', `manual_trade_review_raw_provider_output_forbidden:${path ? `${path}.` : ''}${key}`)
    }
    rejectRawProviderFields(nested, `${path ? `${path}.` : ''}${key}`)
  }
}

function normalizeMemory(input) {
  const memory = isPlainObject(input) ? input : {}
  const content = objectValue(memory, 'content', 'memory_content', 'content_text')
  if (content != null && typeof content !== 'string') throw reviewError('manual_trade_review_memory_content_invalid')
  const contentText = content == null ? null : content
  return {
    library_id: integer(objectValue(memory, 'library_id', 'libraryId', 'id'), 'memory_library_id', { required: false }),
    version_no: integer(objectValue(memory, 'version_no', 'versionNo', 'library_version_no', 'libraryVersionNo'), 'memory_version_no', { required: false }),
    revision_id: integer(objectValue(memory, 'revision_id', 'revisionId'), 'memory_revision_id', { required: false }),
    content_hash: boundedHash(objectValue(memory, 'content_hash', 'contentHash', 'library_content_hash', 'libraryContentHash'), 'memory_content_hash'),
    char_count: integer(objectValue(memory, 'char_count', 'charCount'), 'memory_char_count', { required:false, min:0 })
      ?? (contentText == null ? 0 : Array.from(contentText).length),
    estimated_token_count: integer(objectValue(memory, 'estimated_token_count', 'estimatedTokenCount'), 'memory_estimated_token_count', { required:false, min:0 })
      ?? (contentText == null ? 0 : Math.ceil(Buffer.byteLength(contentText, 'utf8') / 4)),
    content: contentText,
  }
}

function normalizeModel(input) {
  const model = isPlainObject(input) ? input : {}
  return {
    profile_id: integer(objectValue(model, 'profile_id', 'profileId', 'model_profile_id', 'modelProfileId'), 'model_profile_id', { required: false }),
    provider: boundedText(objectValue(model, 'provider', 'api_provider'), 'model_provider', { max: 64 }),
    model: boundedText(objectValue(model, 'model', 'model_name', 'modelName'), 'model_name', { max: 128 }),
    protocol: boundedText(objectValue(model, 'protocol'), 'model_protocol', { max: 64 }),
    credential_source: boundedText(objectValue(model, 'credential_source', 'credentialSource'), 'credential_source', { max: 64 }),
    config_fingerprint: boundedText(objectValue(model, 'config_fingerprint', 'configFingerprint', 'runtime_config_hash', 'runtimeConfigHash'), 'model_config_fingerprint', { max: 128 }),
  }
}

/**
 * Build the only runtime representation accepted by the durable stage table.
 * The projection is intentionally allow-listed: passing a model profile or
 * provider config object cannot accidentally persist an API key or headers.
 */
export function buildFrozenRuntime(input = {}) {
  if (!isPlainObject(input)) throw reviewError('manual_trade_review_frozen_runtime_invalid')
  const source = isPlainObject(input.frozenRuntime)
    ? { ...input.frozenRuntime, ...input }
    : isPlainObject(input.frozen_runtime)
      ? { ...input.frozen_runtime, ...input }
      : input
  const modelSource = objectValue(source, 'model', 'model_runtime', 'modelRuntime') || source
  const memorySource = objectValue(source, 'memory', 'memory_library', 'memoryLibrary') || source
  const runtime = {
    contract: boundedText(objectValue(source, 'contract', 'contract_version', 'contractVersion'), 'runtime_contract', { max: 64 }) || 'manual-trade-review-runtime-v1',
    case_id: integer(objectValue(source, 'case_id', 'caseId'), 'case_id'),
    job_id: integer(objectValue(source, 'job_id', 'jobId'), 'job_id'),
    generation_no: integer(objectValue(source, 'generation_no', 'generationNo'), 'generation_no'),
    task_deadline_at: boundedText(objectValue(source, 'task_deadline_at', 'taskDeadlineAt'), 'task_deadline_at', { max: 32 }),
    parent_version_id: integer(objectValue(source, 'parent_version_id', 'parentVersionId'), 'parent_version_id', { required: false }),
    strategy_snapshot_hash: boundedHash(objectValue(source, 'strategy_snapshot_hash', 'strategySnapshotHash'), 'strategy_snapshot_hash', { required: true }),
    evidence_hash: boundedHash(objectValue(source, 'evidence_hash', 'evidenceHash'), 'evidence_hash', { required: true }),
    memory: normalizeMemory(memorySource),
    model: normalizeModel(modelSource),
    output_contract_hash: boundedHash(objectValue(source, 'output_contract_hash', 'outputContractHash'), 'output_contract_hash', { required: true }),
    selection_contract_version: boundedText(objectValue(source, 'selection_contract_version', 'selectionContractVersion'), 'selection_contract_version', { max: 64 }),
  }
  rejectCredentialFields(runtime)
  rejectRawProviderFields(runtime)
  const frozenRuntimeHash = hashManualTradeReviewValue(runtime)
  return { frozenRuntime: runtime, frozenRuntimeHash, runtime, runtimeHash: frozenRuntimeHash }
}

export const createFrozenRuntime = buildFrozenRuntime

function parseJsonValue(value, field) {
  if (value == null || value === '') return null
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { throw reviewError(`manual_trade_review_${field}_invalid`) }
  }
  return value
}

/** Parse and hash-check a persisted runtime before it is used for recovery. */
export function parseAndValidateFrozenRuntime(value, expectedHash = null) {
  const runtime = parseJsonValue(value, 'frozen_runtime')
  if (!isPlainObject(runtime)) throw reviewError('manual_trade_review_frozen_runtime_invalid')
  rejectCredentialFields(runtime)
  rejectRawProviderFields(runtime)
  const actualHash = hashManualTradeReviewValue(runtime)
  if (expectedHash != null && String(expectedHash).toLowerCase() !== actualHash) {
    throw reviewError('manual_trade_review_frozen_runtime_hash_mismatch')
  }
  return { runtime, frozenRuntime: runtime, frozenRuntimeHash: actualHash, runtimeHash: actualHash }
}

export const parseFrozenRuntime = parseAndValidateFrozenRuntime

function normalizedStage(value) {
  const stage = boundedText(value, 'stage', { required: true, max: 24 })
  if (!STAGE_SET.has(stage)) throw reviewError('manual_trade_review_stage_invalid')
  return stage
}

function normalizedStatus(value) {
  const status = boundedText(value, 'stage_status', { required: true, max: 24 })
  if (!STATUS_SET.has(status)) throw reviewError('manual_trade_review_stage_status_invalid')
  return status
}

function normalizedJobStatusList(value = MANUAL_TRADE_REVIEW_BUSINESS_JOB_STATUSES) {
  const list = Array.isArray(value) && value.length ? value : MANUAL_TRADE_REVIEW_BUSINESS_JOB_STATUSES
  const normalized = [...new Set(list.map(status => {
    const text = boundedText(status, 'job_status', { required: true, max: 24 })
    if (!JOB_STATUS_SET.has(text)) throw reviewError('manual_trade_review_job_status_invalid')
    return text
  }))]
  return normalized
}

function normalizedStageStatusList(value = ['pending', 'running', 'status_unknown']) {
  const list = Array.isArray(value) && value.length ? value : ['pending', 'running', 'status_unknown']
  return [...new Set(list.map(normalizedStatus))]
}

function nowDate(value) {
  if (value == null || value === '') return beijingNow()
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw reviewError('manual_trade_review_stage_time_invalid')
    return new Date(value.getTime() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) throw reviewError('manual_trade_review_stage_time_invalid')
    return new Date(date.getTime() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
  }
  const text = String(value).trim()
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(text)) {
    throw reviewError('manual_trade_review_stage_time_invalid')
  }
  return text.replace('T', ' ').slice(0, 19)
}

function normalizedLeaseToken(value) {
  return boundedText(value, 'lease_token', { required: true, max: 128 })
}

function normalizedModelTaskId(value) {
  return boundedText(value, 'model_task_id', { required: true, max: 128 })
}

function normalizedOptionalHash(value, field) {
  if (value == null || value === '') return null
  return boundedHash(value, field)
}

function normalizedErrorCode(value) {
  const text = boundedText(value, 'stage_error_code', { max: 128 })
  if (text && !/^[a-z0-9_.:-]+$/iu.test(text)) throw reviewError('manual_trade_review_stage_error_code_invalid')
  return text
}

function outputWithoutCredentials(value) {
  const output = parseJsonValue(value, 'normalized_output')
  if (!isPlainObject(output)) throw reviewError('manual_trade_review_normalized_output_invalid')
  rejectCredentialFields(output)
  rejectRawProviderFields(output)
  // Raw provider envelopes are not accepted even when renamed under a safe
  // parent object.  Normalized review-contract fields are the only payload
  // this table is designed to retain.
  return output
}

export function normalizeManualTradeReviewStageOutput(value) {
  const output = outputWithoutCredentials(value)
  const normalizedOutputJson = stableJson(output)
  const normalizedOutputHash = hashManualTradeReviewValue(output)
  return { output, normalizedOutput: output, normalizedOutputJson, normalizedOutputHash, outputHash: normalizedOutputHash }
}

export function buildManualTradeReviewStageInputHash({ stage, frozenRuntimeHash, messages, outputContractHash = null, parentOutputHash = null } = {}) {
  const stageName = normalizedStage(stage)
  const runtimeHash = boundedHash(frozenRuntimeHash, 'frozen_runtime_hash', { required: true })
  const contractHash = outputContractHash == null ? null : boundedHash(outputContractHash, 'output_contract_hash')
  const parentHash = parentOutputHash == null ? null : boundedHash(parentOutputHash, 'parent_output_hash')
  const safeMessages = messages == null ? null : parseJsonValue(messages, 'stage_messages')
  rejectCredentialFields(safeMessages)
  return hashManualTradeReviewValue({
    stage: stageName,
    frozen_runtime_hash: runtimeHash,
    output_contract_hash: contractHash,
    parent_output_hash: parentHash,
    messages: safeMessages,
  })
}

function rowsFromDb(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0]
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.rows)) return result.rows
  return []
}

async function oneFromRunner(run, sql, params = []) {
  return rowsFromDb(await run(sql, params))[0] || null
}

function changedCount(result) {
  return Number(result?.affectedRows ?? result?.changes ?? result?.[0]?.affectedRows ?? 0)
}

function parseStageRunRow(row) {
  if (!row || typeof row !== 'object') throw reviewError('manual_trade_review_stage_row_invalid')
  const runtime = parseAndValidateFrozenRuntime(row.frozen_runtime_json, row.frozen_runtime_hash)
  const output = row.normalized_output_json == null || row.normalized_output_json === ''
    ? null
    : normalizeManualTradeReviewStageOutput(row.normalized_output_json)
  if (output && row.normalized_output_hash && String(row.normalized_output_hash).toLowerCase() !== output.normalizedOutputHash) {
    throw reviewError('manual_trade_review_normalized_output_hash_mismatch')
  }
  return {
    ...row,
    id: row.id == null ? null : Number(row.id),
    case_id: row.case_id == null ? null : Number(row.case_id),
    job_id: row.job_id == null ? null : Number(row.job_id),
    generation_no: row.generation_no == null ? null : Number(row.generation_no),
    stage: normalizedStage(row.stage),
    status: normalizedStatus(row.status),
    model_task_id: row.model_task_id || null,
    frozen_runtime: runtime.runtime,
    frozenRuntime: runtime.runtime,
    frozen_runtime_hash: runtime.frozenRuntimeHash,
    frozenRuntimeHash: runtime.frozenRuntimeHash,
    normalized_output: output?.output || null,
    normalizedOutput: output?.output || null,
    normalized_output_hash: output?.normalizedOutputHash || row.normalized_output_hash || null,
    normalizedOutputHash: output?.normalizedOutputHash || row.normalized_output_hash || null,
  }
}

function assertStageIdentity(input = {}) {
  return {
    caseId: integer(objectValue(input, 'caseId', 'case_id'), 'case_id'),
    jobId: integer(objectValue(input, 'jobId', 'job_id'), 'job_id'),
    generationNo: integer(objectValue(input, 'generationNo', 'generation_no'), 'generation_no'),
  }
}

function assertSharedRuntime(stageRuns, expected = {}) {
  if (!Array.isArray(stageRuns) || stageRuns.length !== MANUAL_TRADE_REVIEW_STAGES.length) {
    throw reviewError('manual_trade_review_stage_runs_incomplete')
  }
  const byStage = new Map()
  for (const row of stageRuns) {
    const parsed = row?.frozen_runtime_json != null ? parseStageRunRow(row) : row
    const stage = normalizedStage(parsed.stage)
    if (byStage.has(stage)) throw reviewError('manual_trade_review_stage_duplicate')
    byStage.set(stage, parsed)
  }
  for (const stage of MANUAL_TRADE_REVIEW_STAGES) if (!byStage.has(stage)) throw reviewError('manual_trade_review_stage_runs_incomplete')
  const rows = MANUAL_TRADE_REVIEW_STAGES.map(stage => byStage.get(stage))
  const runtimeHashes = new Set(rows.map(row => String(row.frozen_runtime_hash || row.frozenRuntimeHash || '').toLowerCase()))
  if (runtimeHashes.size !== 1 || !runtimeHashes.values().next().value) throw reviewError('manual_trade_review_shared_runtime_hash_mismatch')
  const identity = assertStageIdentity({
    caseId: expected.caseId ?? rows[0].case_id,
    jobId: expected.jobId ?? rows[0].job_id,
    generationNo: expected.generationNo ?? rows[0].generation_no,
  })
  for (const row of rows) {
    if (Number(row.case_id) !== identity.caseId || Number(row.job_id) !== identity.jobId || Number(row.generation_no) !== identity.generationNo) {
      throw reviewError('manual_trade_review_stage_identity_mismatch')
    }
  }
  const runtime = parseAndValidateFrozenRuntime(rows[0].frozen_runtime || rows[0].frozen_runtime_json, rows[0].frozen_runtime_hash || rows[0].frozenRuntimeHash)
  if (Number(runtime.runtime.case_id) !== identity.caseId || Number(runtime.runtime.job_id) !== identity.jobId || Number(runtime.runtime.generation_no) !== identity.generationNo) {
    throw reviewError('manual_trade_review_frozen_runtime_identity_mismatch')
  }
  for (const row of rows.slice(1)) {
    const other = parseAndValidateFrozenRuntime(row.frozen_runtime || row.frozen_runtime_json, row.frozen_runtime_hash || row.frozenRuntimeHash)
    if (other.frozenRuntimeHash !== runtime.frozenRuntimeHash) throw reviewError('manual_trade_review_shared_runtime_hash_mismatch')
  }
  return { stageRuns: rows, stages: rows, runtime: runtime.runtime, frozenRuntime: runtime.runtime, runtimeHash: runtime.frozenRuntimeHash, frozenRuntimeHash: runtime.frozenRuntimeHash }
}

export function validateManualTradeReviewStageRuns(stageRuns, expected = {}) {
  return assertSharedRuntime(stageRuns, expected)
}

export const validateSharedFrozenRuntimeHash = validateManualTradeReviewStageRuns

async function selectStageRuns(run, { jobId, generationNo, forUpdate = false } = {}) {
  const suffix = forUpdate ? ' FOR UPDATE' : ''
  const rows = rowsFromDb(await run(`SELECT * FROM manual_trade_review_stage_runs
    WHERE job_id = ? AND generation_no = ?
    ORDER BY FIELD(stage, 'counterfactual', 'outcome_review'), id${suffix}`, [jobId, generationNo]))
  return rows.map(parseStageRunRow)
}

async function ensureStageRunsWithRunner(run, input) {
  const identity = assertStageIdentity(input)
  const built = input.frozenRuntime && input.frozenRuntimeHash
    ? parseAndValidateFrozenRuntime(input.frozenRuntime, input.frozenRuntimeHash)
    : buildFrozenRuntime(input)
  const now = nowDate(input.now)
  const existing = await selectStageRuns(run, { jobId: identity.jobId, generationNo: identity.generationNo, forUpdate: true })
  for (const row of existing) {
    if (Number(row.case_id) !== identity.caseId) throw reviewError('manual_trade_review_stage_identity_mismatch')
    if (row.frozenRuntimeHash !== built.frozenRuntimeHash) throw reviewError('manual_trade_review_frozen_runtime_conflict')
  }
  const byStage = new Map(existing.map(row => [row.stage, row]))
  for (const stage of MANUAL_TRADE_REVIEW_STAGES) {
    if (byStage.has(stage)) continue
    await run(`INSERT INTO manual_trade_review_stage_runs
      (case_id, job_id, generation_no, stage, status, model_task_id,
       frozen_runtime_json, frozen_runtime_hash, input_hash, normalized_output_json,
       normalized_output_hash, last_error_code, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
    [identity.caseId, identity.jobId, identity.generationNo, stage,
      stableJson(built.runtime), built.frozenRuntimeHash, now, now])
  }
  const rows = await selectStageRuns(run, { jobId: identity.jobId, generationNo: identity.generationNo, forUpdate: true })
  return assertSharedRuntime(rows, identity)
}

/** Atomically create both stage rows without changing an existing generation. */
export async function ensureManualTradeReviewStageRuns(input = {}, options = {}) {
  const runner = options.run || options.runner || input.run || input.runner
  if (runner) return ensureStageRunsWithRunner(runner, input)
  return withTransaction(run => ensureStageRunsWithRunner(run, input))
}

export const ensureStageRuns = ensureManualTradeReviewStageRuns

export async function readManualTradeReviewStageRuns(input = {}) {
  const identity = assertStageIdentity(input)
  const rows = (await queryAll(`SELECT * FROM manual_trade_review_stage_runs
    WHERE job_id = ? AND generation_no = ?
    ORDER BY FIELD(stage, 'counterfactual', 'outcome_review'), id`, [identity.jobId, identity.generationNo])) || []
  return rows.map(parseStageRunRow)
}

export const getManualTradeReviewStageRuns = readManualTradeReviewStageRuns

export async function loadManualTradeReviewStageRuntime(input = {}) {
  const rows = await readManualTradeReviewStageRuns(input)
  return assertSharedRuntime(rows, input)
}

export const readSharedFrozenRuntime = loadManualTradeReviewStageRuntime

function stageLookupWhere(input) {
  const identity = assertStageIdentity(input)
  const stage = normalizedStage(input.stage)
  return { ...identity, stage }
}

async function readStageForMutation(input, run = null) {
  const { jobId, generationNo, stage } = stageLookupWhere(input)
  const sql = `SELECT stages.*, jobs.status AS business_job_status, jobs.lease_token AS business_lease_token,
      jobs.generation_no AS business_generation_no
    FROM manual_trade_review_stage_runs stages
    JOIN manual_trade_review_jobs jobs ON jobs.id = stages.job_id
    WHERE stages.job_id = ? AND stages.generation_no = ? AND stages.stage = ?
    LIMIT 1${run ? ' FOR UPDATE' : ''}`
  return run ? oneFromRunner(run, sql, [jobId, generationNo, stage]) : queryOne(sql, [jobId, generationNo, stage])
}

function mutationResultOrFence(result, code = 'manual_trade_review_stage_fence_lost') {
  if (changedCount(result) !== 1) throw reviewError(code)
  return true
}

function buildStatusPlaceholders(statuses) {
  return statuses.map(() => '?').join(', ')
}

/** Link a durable stage to exactly one model task under the current business lease. */
export async function linkManualTradeReviewStageModelTask(input = {}) {
  const identity = stageLookupWhere(input)
  const modelTaskId = normalizedModelTaskId(input.modelTaskId ?? input.model_task_id)
  const inputHash = normalizedOptionalHash(input.inputHash ?? input.input_hash, 'input_hash')
  const leaseToken = normalizedLeaseToken(input.leaseToken ?? input.lease_token)
  const jobStatuses = normalizedJobStatusList(input.expectedJobStatuses || input.expected_job_statuses)
  const stageStatuses = normalizedStageStatusList(input.expectedStageStatuses || input.expected_stage_statuses)
  const now = nowDate(input.now)
  const run = input.run || input.runner
  const update = async runner => {
    try {
      const result = await runner(`UPDATE manual_trade_review_stage_runs stages
        JOIN manual_trade_review_jobs jobs ON jobs.id = stages.job_id
        SET stages.model_task_id = ?, stages.input_hash = COALESCE(stages.input_hash, ?),
          stages.status = 'running', stages.updated_at = ?, stages.last_error_code = NULL
        WHERE stages.job_id = ? AND stages.generation_no = ? AND stages.stage = ?
          AND jobs.id = stages.job_id AND jobs.generation_no = stages.generation_no
          AND jobs.lease_token = ? AND jobs.status IN (${buildStatusPlaceholders(jobStatuses)})
          AND stages.status IN (${buildStatusPlaceholders(stageStatuses)})
          AND (stages.model_task_id IS NULL OR stages.model_task_id = ?)
          AND (stages.input_hash IS NULL OR stages.input_hash = ?)`,
      [modelTaskId, inputHash, now, identity.jobId, identity.generationNo, identity.stage, leaseToken, ...jobStatuses, ...stageStatuses, modelTaskId, inputHash])
      if (changedCount(result) === 1) return { linked: true, modelTaskId, inputHash }
      const current = await readStageForMutation({ ...input, jobId:identity.jobId, generationNo:identity.generationNo, stage:identity.stage }, runner)
      if (current && current.model_task_id === modelTaskId && (!inputHash || current.input_hash === inputHash)
        && jobStatuses.includes(String(current.business_job_status)) && current.business_lease_token === leaseToken && stageStatuses.includes(String(current.status))) {
        return { linked: true, idempotent: true, modelTaskId, inputHash:current.input_hash || inputHash }
      }
      if (current?.model_task_id && current.model_task_id !== modelTaskId) throw reviewError('manual_trade_review_stage_model_task_conflict')
      throw reviewError('manual_trade_review_stage_fence_lost')
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062 || /duplicate entry/i.test(String(error?.message || ''))) {
        throw reviewError('manual_trade_review_stage_model_task_conflict')
      }
      throw error
    }
  }
  if (run) return update(run)
  return withTransaction(update)
}

export const linkStageModelTask = linkManualTradeReviewStageModelTask

/**
 * Persist a contract-validated result.  The UPDATE joins the business job so
 * an expired/replaced lease or another generation cannot write this row.
 */
export async function saveManualTradeReviewStageOutput(input = {}) {
  const identity = stageLookupWhere(input)
  const leaseToken = normalizedLeaseToken(input.leaseToken ?? input.lease_token)
  const jobStatuses = normalizedJobStatusList(input.expectedJobStatuses || input.expected_job_statuses)
  const stageStatuses = normalizedStageStatusList(input.expectedStageStatuses || input.expected_stage_statuses)
  const normalized = normalizeManualTradeReviewStageOutput(input.normalizedOutput ?? input.normalized_output)
  const now = nowDate(input.now)
  const completedAt = nowDate(input.completedAt ?? input.completed_at ?? now)
  const run = input.run || input.runner
  const update = async runner => {
    const result = await runner(`UPDATE manual_trade_review_stage_runs stages
      JOIN manual_trade_review_jobs jobs ON jobs.id = stages.job_id
      SET stages.status = 'succeeded', stages.normalized_output_json = ?,
        stages.normalized_output_hash = ?, stages.last_error_code = NULL,
        stages.completed_at = ?, stages.updated_at = ?
      WHERE stages.job_id = ? AND stages.generation_no = ? AND stages.stage = ?
        AND jobs.id = stages.job_id AND jobs.generation_no = stages.generation_no
        AND jobs.lease_token = ? AND jobs.status IN (${buildStatusPlaceholders(jobStatuses)})
        AND stages.status IN (${buildStatusPlaceholders(stageStatuses)})
        AND stages.model_task_id IS NOT NULL`,
    [normalized.normalizedOutputJson, normalized.normalizedOutputHash, completedAt, now,
      identity.jobId, identity.generationNo, identity.stage, leaseToken, ...jobStatuses, ...stageStatuses])
    if (changedCount(result) === 1) return { saved: true, status: 'succeeded', ...normalized }
    const current = await readStageForMutation({ ...input, jobId:identity.jobId, generationNo:identity.generationNo, stage:identity.stage }, runner)
    if (current?.status === 'succeeded' && current.normalized_output_hash === normalized.normalizedOutputHash && current.business_lease_token === leaseToken) {
      return { saved: true, idempotent: true, status: 'succeeded', ...normalized }
    }
    throw reviewError('manual_trade_review_stage_fence_lost')
  }
  if (run) return update(run)
  return withTransaction(update)
}

export const saveStageOutput = saveManualTradeReviewStageOutput

async function updateStageStatus(input = {}, targetStatus) {
  const identity = stageLookupWhere(input)
  const status = normalizedStatus(targetStatus || input.status)
  if (status === 'succeeded') throw reviewError('manual_trade_review_stage_status_use_output')
  const leaseToken = normalizedLeaseToken(input.leaseToken ?? input.lease_token)
  const jobStatuses = normalizedJobStatusList(input.expectedJobStatuses || input.expected_job_statuses)
  const stageStatuses = normalizedStageStatusList(input.expectedStageStatuses || input.expected_stage_statuses)
  const errorCode = normalizedErrorCode(input.errorCode ?? input.error_code)
  const now = nowDate(input.now)
  const completed = ['failed', 'stale', 'conflict'].includes(status) ? now : null
  const run = input.run || input.runner
  const update = async runner => {
    const result = await runner(`UPDATE manual_trade_review_stage_runs stages
      JOIN manual_trade_review_jobs jobs ON jobs.id = stages.job_id
      SET stages.status = ?, stages.last_error_code = ?, stages.completed_at = ?, stages.updated_at = ?
      WHERE stages.job_id = ? AND stages.generation_no = ? AND stages.stage = ?
        AND jobs.id = stages.job_id AND jobs.generation_no = stages.generation_no
        AND jobs.lease_token = ? AND jobs.status IN (${buildStatusPlaceholders(jobStatuses)})
        AND stages.status IN (${buildStatusPlaceholders(stageStatuses)})`,
    [status, errorCode, completed, now, identity.jobId, identity.generationNo, identity.stage,
      leaseToken, ...jobStatuses, ...stageStatuses])
    mutationResultOrFence(result)
    return { updated: true, status, errorCode }
  }
  if (run) return update(run)
  return withTransaction(update)
}

export async function markManualTradeReviewStageStatus(input = {}) {
  return updateStageStatus(input, input.status)
}

export const setStageStatus = markManualTradeReviewStageStatus

export async function markManualTradeReviewStageFailed(input = {}) {
  return updateStageStatus(input, 'failed')
}

export async function markManualTradeReviewStageUnknown(input = {}) {
  return updateStageStatus(input, 'status_unknown')
}
