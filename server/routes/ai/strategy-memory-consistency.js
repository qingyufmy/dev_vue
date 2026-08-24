// Durable strategy/memory consistency detection worker.
//
// The worker freezes the complete strategy and unified memory library at queue
// time, lets a model propose candidates, and lets the server validate every
// source excerpt before persisting a result.  It deliberately does not write
// conflict evidence or mutate the memory library; a review-confirmation or a
// later integration callback owns those business decisions.

import crypto from 'node:crypto'
import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { requestJsonObject } from './llm.js'
import { resolveAiTaskModel } from './model-profiles.js'
import { MODEL_PROVIDER_DEFAULTS, modelProviderProtocol } from './model-providers.js'
import { getModelProviderCapabilities } from './model-provider-capabilities.js'
import { createModelTaskTracker } from './model-task-tracker.js'
import { recoverAbandonedBusinessModelTasks } from './model-task-runtime.js'
import { estimateModelInputTokens, modelTaskDeadlines, selectModelTaskBudget } from './model-task-budget.js'
import { buildStrategyMemorySourceManifest } from './strategy-memory-semantics.js'
import { applyStrategyMemoryConsistencyFindings } from './strategy-memory-library.js'

export const STRATEGY_MEMORY_CONSISTENCY_TASK_KIND = 'strategy_memory_consistency'
export const STRATEGY_MEMORY_CONSISTENCY_DETECTOR_CONTRACT_VERSION = 'strategy-memory-consistency-v1'
export const STRATEGY_MEMORY_CONSISTENCY_LEASE_MS = 15 * 60_000
export const STRATEGY_MEMORY_CONSISTENCY_HEARTBEAT_MS = 30_000
export const STRATEGY_MEMORY_CONSISTENCY_DEFAULT_INTERVAL_MS = 60_000

async function consistencyFeatureEnabled() {
  try {
    const row = await queryOne("SELECT strategy_memory_consistency_checks_enabled AS enabled FROM ai_feature_flags WHERE scope = 'global' AND user_id = 0 LIMIT 1")
    return row?.enabled == null ? true : Boolean(Number(row.enabled))
  } catch {
    return true
  }
}

const TERMINAL_MODEL_TASK_STATES = new Set([
  'cancelled', 'failed_terminal', 'succeeded', 'completed_stale', 'completed_rejected',
])
const JOB_TERMINAL_STATES = new Set(['succeeded', 'succeeded_noop', 'failed', 'stale', 'status_unknown'])
const RETRYABLE_JOB_STATES = new Set(['queued', 'failed'])

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

function safeError(error) {
  return String(error?.message || error || 'strategy_memory_consistency_failed')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .slice(0, 512)
}

function errorWithCode(code, detail = '') {
  const error = new Error(detail ? `${code}:${detail}` : code)
  error.code = code
  return error
}

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n')
}

function beijingAfter(milliseconds) {
  const d = new Date(Date.now() + 8 * 60 * 60_000 + Math.max(0, Number(milliseconds) || 0))
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

function cleanPlainText(value, maxLength = 4096) {
  // Model fields are stored only after this boundary.  HTML, markdown tags
  // and control characters are not a source of truth for a conflict result.
  return normalizeText(value)
    .replace(/<[^>]*>/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .trim()
    .slice(0, maxLength)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function affectedRows(result) {
  const value = Array.isArray(result) && result[0] && !Array.isArray(result[0]) ? result[0] : result
  return Number(value?.affectedRows ?? value?.changes ?? 0)
}

function firstRow(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0][0] || null
  return Array.isArray(result) ? (result[0] || null) : (result || null)
}

function strategyTextFromRow(row) {
  return normalizeText(row?.system_prompt || row?.description || '')
}

function modelEndpoint(model) {
  const provider = model?.provider || model?.api_provider
  const protocol = modelProviderProtocol(provider)
  const base = String(model?.api_base_url || MODEL_PROVIDER_DEFAULTS[provider] || '').replace(/\/+$/u, '')
  if (!base) throw errorWithCode('unsupported_consistency_model_provider')
  return { protocol, url:`${base}/${protocol === 'responses' ? 'responses' : 'chat/completions'}` }
}

function requestTimeoutMs(deadlines, nowUtcMs = Date.now()) {
  return Math.max(1, Math.trunc(Math.min(deadlines.attemptSafetyDeadlineUtcMs, deadlines.taskDeadlineUtcMs) - nowUtcMs))
}

function candidateText(value, field) {
  if (typeof value !== 'string') throw errorWithCode(`strategy_memory_consistency_${field}_invalid`)
  const text = cleanPlainText(value)
  if (!text) throw errorWithCode(`strategy_memory_consistency_${field}_missing`)
  return text
}

function candidateExcerpt(value, field) {
  if (typeof value !== 'string') throw errorWithCode(`strategy_memory_consistency_${field}_invalid`)
  const raw = normalizeText(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .trim()
  if (!raw) throw errorWithCode(`strategy_memory_consistency_${field}_missing`)
  // Do not strip markup from an excerpt before source matching: doing so could
  // turn an untrusted paraphrase into a valid source substring.  A literal
  // '<' or '>' in a trading rule remains valid; only tag-shaped input fails.
  if (/<\/?[A-Za-z][^>]*>/u.test(raw)) throw errorWithCode('strategy_memory_consistency_html_rejected')
  return raw.slice(0, 4096)
}

function findExactExcerpt(source, excerpt) {
  const normalizedSource = normalizeText(source)
  const normalizedExcerpt = normalizeText(excerpt)
  const index = normalizedSource.indexOf(normalizedExcerpt)
  if (index < 0) return null
  if (normalizedSource.indexOf(normalizedExcerpt, index + normalizedExcerpt.length) >= 0) return null
  return { index, end:index + normalizedExcerpt.length, excerpt:normalizedExcerpt }
}

function findMemoryBlock(manifest, excerpt) {
  const blocks = Array.isArray(manifest?.source_blocks) ? manifest.source_blocks : []
  const matches = blocks.filter(block => findExactExcerpt(block?.text || '', excerpt))
  return matches.length === 1 ? matches[0] : null
}

/**
 * Validate the narrow provider contract.  The returned object contains only
 * server-derived identities and exact source excerpts; arbitrary provider
 * keys (especially conflict_key, positions and HTML) are discarded.
 */
export function validateStrategyMemoryConsistencyOutput({
  output, strategyText, memoryText, sourceManifest = null,
} = {}) {
  if (!isPlainObject(output)) throw errorWithCode('strategy_memory_consistency_output_invalid')
  const candidates = Array.isArray(output.candidates) ? output.candidates : output.conflicts
  if (!Array.isArray(candidates)) throw errorWithCode('strategy_memory_consistency_candidates_missing')
  const normalizedStrategy = normalizeText(strategyText)
  const normalizedMemory = normalizeText(memoryText)
  const manifest = sourceManifest || buildStrategyMemorySourceManifest({ content_text:normalizedMemory })
  const seen = new Set()
  const validated = []
  for (const raw of candidates) {
    if (!isPlainObject(raw)) throw errorWithCode('strategy_memory_consistency_candidate_invalid')
    const category = candidateText(raw.category, 'category').slice(0, 32).toLowerCase()
    if (!['general', 'market_regime', 'entry_setup', 'chan_structure', 'risk_execution'].includes(category)) {
      throw errorWithCode('strategy_memory_consistency_category_invalid')
    }
    const strategyExcerpt = candidateExcerpt(raw.strategy_excerpt, 'strategy_excerpt')
    const memoryExcerpt = candidateExcerpt(raw.memory_excerpt, 'memory_excerpt')
    const summary = candidateText(raw.summary, 'summary')
    const suggestedChange = candidateText(raw.suggested_change, 'suggested_change')
    const strategyMatch = findExactExcerpt(normalizedStrategy, strategyExcerpt)
    if (!strategyMatch) throw errorWithCode('strategy_memory_consistency_strategy_excerpt_not_found')
    const memoryMatch = findExactExcerpt(normalizedMemory, memoryExcerpt)
    if (!memoryMatch) throw errorWithCode('strategy_memory_consistency_memory_excerpt_not_found')
    const block = findMemoryBlock(manifest, memoryExcerpt)
    if (!block) throw errorWithCode('strategy_memory_consistency_memory_block_not_found')
    const identity = sha256(JSON.stringify({ category, strategy_excerpt:strategyExcerpt,
      memory_excerpt:memoryExcerpt }))
    if (seen.has(identity)) continue
    seen.add(identity)
    validated.push({
      conflict_kind:'existing_memory_vs_strategy',
      category, strategy_excerpt:strategyExcerpt, memory_excerpt:memoryExcerpt,
      summary, suggested_change:suggestedChange,
      memory_block_id:String(block.id || block.source_block_id),
      memory_block_hash:sha256(normalizeText(block.text || '')),
      memory_claim_hash:sha256(memoryExcerpt),
      strategy_rule_hash:sha256(strategyExcerpt),
      conflict_identity:identity,
    })
  }
  const result = {
    contract_version:STRATEGY_MEMORY_CONSISTENCY_DETECTOR_CONTRACT_VERSION,
    candidates:validated,
    conflict_count:validated.length,
    matched_count:validated.length,
    stale_count:0,
  }
  return { candidates:validated, result, resultHash:sha256(JSON.stringify(result)) }
}

export function buildStrategyMemoryConsistencyMessages({
  strategy, strategyText, library, memoryText, sourceManifest = null,
} = {}) {
  const frozenStrategyText = normalizeText(strategyText ?? strategy?.text ?? '')
  const frozenMemoryText = normalizeText(memoryText ?? library?.content_text ?? '')
  const manifest = sourceManifest || buildStrategyMemorySourceManifest({ content_text:frozenMemoryText })
  const system = [
    '你是策略与统一记忆库一致性检查器。只返回一个 JSON 对象。',
    'candidates 必须是数组；每项只能包含 category、strategy_excerpt、memory_excerpt、summary、suggested_change。',
    'strategy_excerpt 和 memory_excerpt 必须逐字复制输入中的连续原文，不能改写、截断或凭空生成。',
    '只提出候选，不计算复盘证据次数，不生成 ID、HTML、颜色、位置或自动修改指令。',
    '没有明确冲突时返回 {"candidates":[]}。不要输出 Markdown、解释文字或其他字段。',
  ].join('\n')
  const user = JSON.stringify({
    contract_version:STRATEGY_MEMORY_CONSISTENCY_DETECTOR_CONTRACT_VERSION,
    strategy:{ id:Number(strategy?.id || 0), version:strategy?.version ?? null, text:frozenStrategyText },
    memory_library:{ version_no:Number(library?.version_no || 0), content_hash:library?.content_hash || null,
      content_text:frozenMemoryText, source_manifest:manifest },
    output_contract:{ candidates:[{ category:'string', strategy_excerpt:'exact source substring',
      memory_excerpt:'exact source substring', summary:'string', suggested_change:'string' }] },
  })
  return [{ role:'system', content:system }, { role:'user', content:user }]
}

export async function prepareStrategyMemoryConsistencyModelCall(resolved, messages, {
  nowUtcMs = Date.now(), businessDeadlineUtcMs = null, capabilities = null,
} = {}) {
  const providerCapabilities = capabilities || await getModelProviderCapabilities(resolved?.model_profile_id)
  const budget = selectModelTaskBudget({
    taskKind:STRATEGY_MEMORY_CONSISTENCY_TASK_KIND,
    providerOutputCap:providerCapabilities?.max_output_tokens,
    contextWindowTokens:providerCapabilities?.context_window_tokens,
    maxInputTokens:providerCapabilities?.max_input_tokens ?? providerCapabilities?.provider_max_input_tokens,
    contextLimitSemantics:providerCapabilities?.context_limit_semantics,
    capabilities:providerCapabilities,
    // max_tokens in a profile is not a physical provider limit.
    profile:null,
    estimatedInputTokens:estimateModelInputTokens(messages),
    schemaNeedTokens:Math.max(800, Math.ceil(JSON.stringify({ candidates:[] }).length / 2)),
  })
  if (budget.reason === 'model_token_limits_unconfirmed' || budget.reason === 'model_token_limits_stale') {
    throw errorWithCode(budget.reason)
  }
  if (budget.reason === 'model_input_limit_exceeded' || budget.inputLimitExceeded) {
    throw errorWithCode('model_input_limit_exceeded')
  }
  if (!budget.sufficient || budget.selectedMaxOutputTokens <= 0) throw errorWithCode('output_budget_insufficient')
  const deadlines = modelTaskDeadlines(STRATEGY_MEMORY_CONSISTENCY_TASK_KIND, { nowUtcMs, businessDeadlineUtcMs })
  return { budget, ...deadlines, requestTimeoutMs:requestTimeoutMs(deadlines, nowUtcMs), capabilities:providerCapabilities }
}

function inputHashFor({ strategyId, strategyVersion, strategyContentHash, libraryVersionNo,
  libraryContentHash, strategyText, memoryContent, detectorContractVersion }) {
  return sha256(JSON.stringify({ strategy_id:Number(strategyId), strategy_version:Number(strategyVersion),
    strategy_content_hash:strategyContentHash, library_version_no:Number(libraryVersionNo),
    library_content_hash:libraryContentHash, strategy_text:strategyText, memory_content:memoryContent,
    detector_contract_version:detectorContractVersion }))
}

async function loadCurrentConsistencyInputs(input = {}) {
  const strategyId = Number(input.strategyId ?? input.strategy_id)
  if (!Number.isInteger(strategyId) || strategyId <= 0) throw errorWithCode('strategy_memory_consistency_strategy_required')
  const strategy = input.strategy || await queryOne(`SELECT id, scope, owner_user_id, title, version,
      system_prompt, description FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [strategyId])
  if (!strategy) throw errorWithCode('strategy_memory_consistency_strategy_not_found')
  const library = input.library || await queryOne(
    'SELECT * FROM strategy_memory_libraries WHERE strategy_id = ? LIMIT 1', [strategyId]
  )
  if (!library) throw errorWithCode('strategy_memory_consistency_library_not_found')
  const canonicalStrategyText = normalizeText(strategyTextFromRow(strategy))
  const canonicalMemoryContent = normalizeText(library.content_text ?? '')
  const hasSuppliedStrategyText = input.strategyText !== undefined || input.strategy_text !== undefined
  const hasSuppliedMemoryContent = input.memoryContent !== undefined || input.memory_content !== undefined
  const strategyText = normalizeText(input.strategyText ?? input.strategy_text ?? canonicalStrategyText)
  const memoryContent = normalizeText(input.memoryContent ?? input.memory_content ?? canonicalMemoryContent)
  if (!strategyText) throw errorWithCode('strategy_memory_consistency_strategy_snapshot_empty')
  const strategyVersion = Number(input.strategyVersion ?? input.strategy_version ?? strategy.version ?? 0)
  const libraryVersionNo = Number(input.libraryVersionNo ?? input.library_version_no ?? library.version_no)
  const libraryContentHash = String(input.libraryContentHash ?? input.library_content_hash ?? library.content_hash ?? '')
  if (hasSuppliedStrategyText && strategyText !== canonicalStrategyText) {
    throw errorWithCode('strategy_memory_consistency_strategy_snapshot_stale')
  }
  if (hasSuppliedMemoryContent && memoryContent !== canonicalMemoryContent) {
    throw errorWithCode('strategy_memory_consistency_memory_snapshot_stale')
  }
  if (input.strategyVersion != null || input.strategy_version != null) {
    if (strategyVersion !== Number(strategy.version || 0)) throw errorWithCode('strategy_memory_consistency_strategy_version_stale')
  }
  if (input.libraryVersionNo != null || input.library_version_no != null) {
    if (libraryVersionNo !== Number(library.version_no || 0)) throw errorWithCode('strategy_memory_consistency_library_version_stale')
  }
  if (input.libraryContentHash != null || input.library_content_hash != null) {
    if (libraryContentHash !== String(library.content_hash || '')) throw errorWithCode('strategy_memory_consistency_library_hash_stale')
  }
  const strategyContentHash = sha256(strategyText)
  if (!/^[a-f0-9]{64}$/iu.test(libraryContentHash) || sha256(memoryContent) !== libraryContentHash) {
    throw errorWithCode('strategy_memory_consistency_memory_snapshot_hash_mismatch')
  }
  return { strategy, library, strategyId, strategyVersion, libraryVersionNo, strategyText,
    memoryContent, strategyContentHash, libraryContentHash }
}

function publicJob(job) {
  if (!job) return null
  const parsedResult = parseJson(job.result_json, null)
  const {
    strategy_text_snapshot: _strategyTextSnapshot,
    memory_content_snapshot: _memoryContentSnapshot,
    result_json: _resultJson,
    lease_token: _leaseToken,
    model_task_id: _modelTaskId,
    input_set_hash: _inputSetHash,
    ...safeJob
  } = job
  const resultSummary = parsedResult && typeof parsedResult === 'object' ? {
    contract_version:parsedResult.contract_version ?? null,
    conflict_count:Number(job.conflict_count ?? parsedResult.conflict_count ?? 0),
    matched_count:Number(job.matched_count ?? parsedResult.matched_count ?? 0),
    stale_count:Number(job.stale_count ?? parsedResult.stale_count ?? 0),
  } : null
  return { ...safeJob, id:Number(job.id), job_id:Number(job.id), strategy_id:Number(job.strategy_id), strategy_version:Number(job.strategy_version),
    library_version_no:Number(job.library_version_no), result_summary:resultSummary }
}

export async function queueStrategyMemoryConsistencyCheck(input = {}) {
  if (!await consistencyFeatureEnabled()) throw errorWithCode('strategy_memory_consistency_disabled')
  const frozen = await loadCurrentConsistencyInputs(input)
  const triggerType = (String(input.triggerType ?? input.trigger_type ?? input.trigger ?? 'manual_check').trim()
    || 'manual_check').slice(0, 32)
  const detectorContractVersion = String(input.detectorContractVersion ?? input.detector_contract_version
    ?? STRATEGY_MEMORY_CONSISTENCY_DETECTOR_CONTRACT_VERSION).slice(0, 64)
  const sourceManifest = buildStrategyMemorySourceManifest({ content_text:frozen.memoryContent })
  const baseInputSetHash = inputHashFor({ ...frozen, detectorContractVersion })
  // A deliberate manual retry after provider_status_unknown/stale must be a
  // new durable task.  Ordinary duplicate triggers remain idempotent; callers
  // opt into a new identity with forceNew/retryNonce.
  const forceNew = input.forceNew === true || input.force_new === true
  const retryNonce = forceNew ? String(input.retryNonce ?? input.retry_nonce ?? crypto.randomUUID()) : ''
  const inputSetHash = forceNew ? sha256(`${baseInputSetHash}:retry:${retryNonce}`) : baseInputSetHash
  let result = null
  await withTransaction(async run => {
    const existingRows = await run(`SELECT * FROM strategy_memory_consistency_jobs
      WHERE strategy_id = ? AND strategy_version = ? AND library_version_no = ? AND input_set_hash = ?
      LIMIT 1 FOR UPDATE`, [frozen.strategyId, frozen.strategyVersion, frozen.libraryVersionNo, inputSetHash])
    const existing = firstRow(existingRows)
    if (existing) {
      result = { ...publicJob(existing), created:false, replayed:true }
      return
    }
    const now = beijingNow()
    const insert = await run(`INSERT IGNORE INTO strategy_memory_consistency_jobs
      (strategy_id, strategy_version, library_version_no, library_content_hash, strategy_content_hash,
       strategy_text_snapshot, memory_content_snapshot, detector_contract_version, trigger_type,
       input_set_hash, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, ?, ?)`,
    [frozen.strategyId, frozen.strategyVersion, frozen.libraryVersionNo, frozen.libraryContentHash,
      frozen.strategyContentHash, frozen.strategyText, frozen.memoryContent, detectorContractVersion,
      triggerType, inputSetHash, Math.max(1, Number(input.maxAttempts) || 3), now, now])
    const inserted = affectedRows(insert) === 1
    const jobId = Number((Array.isArray(insert) ? insert[0]?.insertId : insert?.insertId) || 0)
    const created = await run(inserted
      ? 'SELECT * FROM strategy_memory_consistency_jobs WHERE id = ? LIMIT 1'
      : `SELECT * FROM strategy_memory_consistency_jobs
        WHERE strategy_id = ? AND strategy_version = ? AND library_version_no = ? AND input_set_hash = ? LIMIT 1`,
    inserted ? [jobId] : [frozen.strategyId, frozen.strategyVersion, frozen.libraryVersionNo, inputSetHash])
    result = { ...publicJob(firstRow(created)), created:inserted, replayed:!inserted,
      source_manifest_hash:sha256(JSON.stringify(sourceManifest)) }
  })
  return result
}

export const enqueueStrategyMemoryConsistencyCheck = queueStrategyMemoryConsistencyCheck
export const createStrategyMemoryConsistencyJob = queueStrategyMemoryConsistencyCheck

export async function getStrategyMemoryConsistencyJob(jobId) {
  const input = jobId && typeof jobId === 'object' ? jobId : { jobId }
  const id = Number(input.jobId ?? input.job_id ?? input.id)
  if (!Number.isInteger(id) || id <= 0) throw errorWithCode('strategy_memory_consistency_job_not_found')
  const strategyId = Number(input.strategyId ?? input.strategy_id ?? 0)
  const row = await queryOne(`SELECT * FROM strategy_memory_consistency_jobs WHERE id = ?${strategyId > 0 ? ' AND strategy_id = ?' : ''} LIMIT 1`,
    strategyId > 0 ? [id, strategyId] : [id])
  if (!row) throw errorWithCode('strategy_memory_consistency_job_not_found')
  return publicJob(row)
}

export async function getLatestStrategyMemoryConsistencyJob(strategyId, input = {}) {
  if (strategyId && typeof strategyId === 'object') {
    input = strategyId
    strategyId = input.strategyId ?? input.strategy_id
  }
  const id = Number(strategyId ?? input.strategyId ?? input.strategy_id)
  if (!Number.isInteger(id) || id <= 0) throw errorWithCode('strategy_memory_consistency_strategy_required')
  const clauses = ['strategy_id = ?']
  const params = [id]
  if (input.strategyVersion ?? input.strategy_version) { clauses.push('strategy_version = ?'); params.push(Number(input.strategyVersion ?? input.strategy_version)) }
  if (input.libraryVersionNo ?? input.library_version_no) { clauses.push('library_version_no = ?'); params.push(Number(input.libraryVersionNo ?? input.library_version_no)) }
  return publicJob(await queryOne(`SELECT * FROM strategy_memory_consistency_jobs
    WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT 1`, params))
}

export const getStrategyMemoryConsistencyJobById = getStrategyMemoryConsistencyJob
export const getLatestStrategyMemoryConsistencyCheck = getLatestStrategyMemoryConsistencyJob

function consistencyJobClaimable(job, now) {
  const status = String(job?.status || '')
  if (status === 'queued') return !job.next_attempt_at || String(job.next_attempt_at) <= String(now)
  if (status === 'failed') return Number(job.attempt_count || 0) < Number(job.max_attempts || 3)
    && (!job.next_attempt_at || String(job.next_attempt_at) <= String(now))
  return status === 'leased' && job.lease_expires_at && String(job.lease_expires_at) <= String(now)
}

export async function claimStrategyMemoryConsistencyJob(input = {}) {
  const workerId = String(input.workerId ?? input.worker_id ?? `strategy-memory-consistency:${process.pid}`).slice(0, 191)
  const leaseMs = Math.min(60 * 60_000, Math.max(5_000,
    Number(input.leaseMs ?? input.lease_ms) || STRATEGY_MEMORY_CONSISTENCY_LEASE_MS))
  const requestedId = input.jobId ?? input.job_id
  let result = null
  await withTransaction(async run => {
    const now = beijingNow()
    const where = requestedId != null
      ? 'id = ?'
      : `((status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (status = 'failed' AND attempt_count < max_attempts
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (status = 'leased' AND lease_expires_at <= ?))`
    const params = requestedId != null ? [Number(requestedId)] : [now, now, now]
    const rows = await run(`SELECT * FROM strategy_memory_consistency_jobs WHERE ${where}
      ORDER BY id ASC LIMIT 1 FOR UPDATE`, params)
    const job = firstRow(rows)
    if (!job || !consistencyJobClaimable(job, now)) return
    const leaseToken = crypto.randomUUID()
    const expires = beijingAfter(leaseMs)
    const updated = await run(`UPDATE strategy_memory_consistency_jobs SET status = 'leased',
      lease_token = ?, lease_expires_at = ?, next_attempt_at = NULL, attempt_count = attempt_count + 1,
      updated_at = ? WHERE id = ? AND status = ?`, [leaseToken, expires, now, job.id, job.status])
    if (affectedRows(updated) !== 1) throw errorWithCode('strategy_memory_consistency_claim_lost')
    result = { ...job, status:'leased', lease_token:leaseToken, lease_expires_at:expires,
      attempt_count:Number(job.attempt_count || 0) + 1, worker_id:workerId }
  })
  return result
}

export async function renewStrategyMemoryConsistencyLease(inputOrJob, tokenArg = null, options = {}) {
  const input = inputOrJob && typeof inputOrJob === 'object' ? inputOrJob
    : { jobId:inputOrJob, leaseToken:tokenArg, ...options }
  const id = Number(input.jobId ?? input.job_id)
  const token = String(input.leaseToken ?? input.lease_token ?? '').trim()
  if (!id || !token) throw errorWithCode('strategy_memory_consistency_lease_required')
  const leaseMs = Math.min(60 * 60_000, Math.max(5_000,
    Number(input.leaseMs ?? input.lease_ms) || STRATEGY_MEMORY_CONSISTENCY_LEASE_MS))
  const expires = beijingAfter(leaseMs)
  const result = await queryRun(`UPDATE strategy_memory_consistency_jobs SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'leased' AND lease_token = ?`, [expires, beijingNow(), id, token])
  if (affectedRows(result) !== 1) throw errorWithCode('strategy_memory_consistency_lease_lost')
  return { id, lease_token:token, lease_expires_at:expires, status:'leased' }
}

function startConsistencyLeaseHeartbeat(job) {
  const controller = new AbortController()
  let stopped = false
  let pending = null
  const renew = async () => {
    if (stopped || pending || controller.signal.aborted) return
    pending = renewStrategyMemoryConsistencyLease({ jobId:job.id, leaseToken:job.lease_token })
      .catch(error => { if (!controller.signal.aborted) controller.abort(error) })
      .finally(() => { pending = null })
    await pending
  }
  const timer = setInterval(() => { void renew() }, STRATEGY_MEMORY_CONSISTENCY_HEARTBEAT_MS)
  timer.unref?.()
  return {
    signal:controller.signal,
    assertOwned:() => controller.signal.throwIfAborted(),
    async stop() { stopped = true; clearInterval(timer); if (pending) await pending },
  }
}

export async function linkStrategyMemoryConsistencyModelTask(job, taskId) {
  const attemptCount = Number(job?.attempt_count || 0)
  const leaseToken = String(job?.lease_token || '').trim()
  if (!Number.isInteger(attemptCount) || attemptCount <= 0 || !job?.id || !leaseToken) {
    throw errorWithCode('strategy_memory_consistency_lease_lost')
  }
  // A job has one current model task per leased attempt.  A later attempt is
  // allowed to replace the previous task, but only while the exact attempt
  // and lease that claimed the job are still current.  This fences a worker
  // whose lease expired while it was creating or linking a task.
  const result = await queryRun(`UPDATE strategy_memory_consistency_jobs SET model_task_id = ?, updated_at = ?
    WHERE id = ? AND attempt_count = ? AND lease_token = ? AND status = 'leased'`,
  [taskId, beijingNow(), job.id, attemptCount, leaseToken])
  if (affectedRows(result) > 0) return true
  // MySQL can report zero changed rows when the same attempt is re-entered
  // with the same deterministic idempotency task.  Treat that as success only
  // when every fence value still matches; an old lease must never be accepted.
  const linked = await queryOne(`SELECT model_task_id, attempt_count, lease_token, status
    FROM strategy_memory_consistency_jobs WHERE id = ? LIMIT 1`, [job.id])
  if (String(linked?.model_task_id || '') === String(taskId)
    && Number(linked?.attempt_count || 0) === attemptCount
    && String(linked?.lease_token || '') === leaseToken
    && String(linked?.status || '') === 'leased') return true
  throw errorWithCode('model_task_link_failed')
}

function providerResultUnknown(tracker, task = null) {
  const status = String(task?.status || tracker?.status || '')
  if (status === 'status_unknown' || status === 'provider_quiet') return true
  const providerState = tracker?.providerRequestState
  return providerState?.submitted === true && providerState?.responseReceived !== true
}

async function markJobFailure(job, code, retryable) {
  const now = beijingNow()
  const exhausted = Number(job.attempt_count || 0) >= Number(job.max_attempts || 3)
  const status = code === 'provider_status_unknown' ? 'status_unknown' : 'failed'
  const nextAttempt = retryable && !exhausted ? now : null
  await queryRun(`UPDATE strategy_memory_consistency_jobs SET status = ?, last_error_code = ?,
    next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL,
    completed_at = CASE WHEN ? = 'status_unknown' OR (? = 'failed' AND ? = 1)
      THEN COALESCE(completed_at, ?) ELSE completed_at END,
    updated_at = ? WHERE id = ? AND status = 'leased' AND lease_token = ?`,
  [status, String(code || 'strategy_memory_consistency_failed').slice(0, 128), nextAttempt,
    status, status, exhausted ? 1 : 0, now, now, job.id, job.lease_token])
}

async function loadFrozenConsistencyInputs(job) {
  const strategyText = job.strategy_text_snapshot
  const memoryText = job.memory_content_snapshot
  if (strategyText == null || memoryText == null) throw errorWithCode('strategy_memory_consistency_snapshot_missing')
  const normalizedStrategy = normalizeText(strategyText)
  const normalizedMemory = normalizeText(memoryText)
  if (sha256(normalizedStrategy) !== String(job.strategy_content_hash || '')) {
    throw errorWithCode('strategy_memory_consistency_strategy_snapshot_hash_mismatch')
  }
  if (sha256(normalizedMemory) !== String(job.library_content_hash || '')) {
    throw errorWithCode('strategy_memory_consistency_memory_snapshot_hash_mismatch')
  }
  return { strategyText:normalizedStrategy, memoryText:normalizedMemory,
    sourceManifest:buildStrategyMemorySourceManifest({ content_text:normalizedMemory }) }
}

async function currentSourcesMatchJob(job) {
  const strategy = await queryOne('SELECT version, system_prompt, description FROM auto_prompt_types WHERE id = ? LIMIT 1', [job.strategy_id])
  const library = await queryOne('SELECT version_no, content_hash FROM strategy_memory_libraries WHERE strategy_id = ? LIMIT 1', [job.strategy_id])
  const strategyText = strategyTextFromRow(strategy)
  return Number(strategy?.version || 0) === Number(job.strategy_version)
    && sha256(strategyText) === String(job.strategy_content_hash || '')
    && Number(library?.version_no || 0) === Number(job.library_version_no)
    && String(library?.content_hash || '') === String(job.library_content_hash || '')
}

async function applyConsistencyResult(job, checked) {
  const payload = JSON.stringify(checked.result)
  const now = beijingNow()
  const status = checked.candidates.length ? 'succeeded' : 'succeeded_noop'
  const update = await queryRun(`UPDATE strategy_memory_consistency_jobs SET status = ?,
    conflict_count = ?, matched_count = ?, stale_count = ?, result_hash = ?, result_json = ?,
    last_error_code = NULL, lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'leased' AND lease_token = ? AND strategy_version = ?
      AND library_version_no = ? AND library_content_hash = ?`,
  [status, checked.result.conflict_count, checked.result.matched_count, checked.result.stale_count,
    checked.resultHash, payload, now, now, job.id, job.lease_token, job.strategy_version,
    job.library_version_no, job.library_content_hash])
  if (affectedRows(update) !== 1) throw errorWithCode('strategy_memory_consistency_lease_lost')
  return { ...publicJob({ ...job, status, conflict_count:checked.result.conflict_count,
    matched_count:checked.result.matched_count, stale_count:0, result_hash:checked.resultHash,
    result_json:payload, completed_at:now }), result:checked.result }
}

export async function runStrategyMemoryConsistencyOnce({
  requestModel = requestJsonObject, applyValidatedFindings = applyStrategyMemoryConsistencyFindings,
} = {}) {
  if (!await consistencyFeatureEnabled()) return { claimed:false, disabled:true }
  const job = await claimStrategyMemoryConsistencyJob({
    workerId:`strategy-memory-consistency:${process.pid}`,
  })
  if (!job) return { claimed:false }
  const lease = startConsistencyLeaseHeartbeat(job)
  let tracker = null
  try {
    const frozen = await loadFrozenConsistencyInputs(job)
    if (!frozen.memoryText) {
      const checked = validateStrategyMemoryConsistencyOutput({ output:{ candidates:[] },
        strategyText:frozen.strategyText, memoryText:'', sourceManifest:frozen.sourceManifest })
      if (typeof applyValidatedFindings === 'function') {
        await applyValidatedFindings({ job:{ ...publicJob(job),
          strategy_text_snapshot:job.strategy_text_snapshot, memory_content_snapshot:'' },
        candidates:[], result:checked.result })
      }
      const applied = await applyConsistencyResult(job, checked)
      return { claimed:true, status:applied.status, jobId:Number(job.id), result:checked.result }
    }
    const owner = await queryOne('SELECT owner_user_id FROM auto_prompt_types WHERE id = ? LIMIT 1', [job.strategy_id])
    const ownerUserId = Number(owner?.owner_user_id || job.owner_user_id || 0)
    const resolved = await resolveAiTaskModel({ userId:ownerUserId, strategyId:Number(job.strategy_id), usage:'memory_consistency',
      modelPurpose:'memory_consistency' })
    if (!resolved?.model) throw errorWithCode(resolved?.error || 'consistency_model_unavailable')
    const messages = buildStrategyMemoryConsistencyMessages({ strategy:{ id:job.strategy_id, version:job.strategy_version },
      strategyText:frozen.strategyText, library:{ version_no:job.library_version_no, content_hash:job.library_content_hash },
      memoryText:frozen.memoryText, sourceManifest:frozen.sourceManifest })
    const modelCall = await prepareStrategyMemoryConsistencyModelCall(resolved, messages)
    const endpoint = modelEndpoint(resolved.model)
    const idempotencyKey = `strategy_memory_consistency:${job.id}:${job.input_set_hash}:attempt:${Math.max(1, Number(job.attempt_count) || 1)}`
    const trackerInputHash = sha256(JSON.stringify(messages))
    tracker = await createModelTaskTracker({
      taskKind:STRATEGY_MEMORY_CONSISTENCY_TASK_KIND, queueClass:'background', ownerUserId,
      strategyId:Number(job.strategy_id), domainType:'strategy_memory_consistency_job', domainId:job.id,
      idempotencyKey, snapshotHash:String(job.input_set_hash || ''), inputHash:trackerInputHash,
      promptHash:sha256(messages.map(message => message.content).join('\n')),
      outputContractHash:sha256('{"candidates":[{"category":"string","strategy_excerpt":"string","memory_excerpt":"string","summary":"string","suggested_change":"string"}]}'),
      provider:resolved.model.provider, model:resolved.model.model_name, modelProfileId:resolved.model_profile_id,
      protocol:endpoint.protocol, credentialSource:resolved.credential_source,
      frozenContext:{ strategy_id:Number(job.strategy_id), strategy_version:Number(job.strategy_version),
        strategy_content_hash:job.strategy_content_hash, library_version_no:Number(job.library_version_no),
        library_content_hash:job.library_content_hash, input_set_hash:job.input_set_hash,
        detector_contract_version:String(job.detector_contract_version || STRATEGY_MEMORY_CONSISTENCY_DETECTOR_CONTRACT_VERSION) },
      maxAttempts:Number(job.max_attempts || 3), taskDeadlineAtUtcMs:modelCall.taskDeadlineUtcMs,
    }, { workerId:`strategy-memory-consistency:${process.pid}`, leaseMs:STRATEGY_MEMORY_CONSISTENCY_LEASE_MS,
      linkTask:taskId => linkStrategyMemoryConsistencyModelTask(job, taskId) })
    await tracker.persistBudget(modelCall.budget)
    const signal = AbortSignal.any([lease.signal, tracker.signal])
    const output = await requestModel({ url:endpoint.url, apiKey:resolved.model.api_key_encrypted,
      provider:resolved.model.provider, model:resolved.model.model_name, temperature:0.1,
      maxTokens:modelCall.budget.selectedMaxOutputTokens, thinkingEnabled:resolved.model.thinking_enabled,
      reasoningEffort:resolved.model.reasoning_effort, protocol:endpoint.protocol, capabilities:modelCall.capabilities,
      modelProfileId:resolved.model_profile_id, timeout:modelCall.requestTimeoutMs,
      deadlineAtMs:Math.min(modelCall.attemptSafetyDeadlineUtcMs, modelCall.taskDeadlineUtcMs),
      followupValidUntilMs:modelCall.taskDeadlineUtcMs, allowFollowupRequests:false, signal, messages,
      modelTaskBudget:modelCall.budget,
      usageContext:{ userId:ownerUserId, profileId:resolved.model_profile_id, credentialSource:resolved.credential_source,
        usage:'memory_consistency', strategyId:Number(job.strategy_id) },
      onProviderRequest:event => tracker.onProviderRequest(event), onProviderUsage:event => tracker.onProviderUsage(event),
      onProviderActivity:event => tracker.onProviderActivity(event), onProviderQuiet:event => tracker.onProviderQuiet(event),
      validateObject:value => validateStrategyMemoryConsistencyOutput({ output:value, strategyText:frozen.strategyText,
        memoryText:frozen.memoryText, sourceManifest:frozen.sourceManifest }).result,
    })
    const checked = validateStrategyMemoryConsistencyOutput({ output, strategyText:frozen.strategyText,
      memoryText:frozen.memoryText, sourceManifest:frozen.sourceManifest })
    await tracker.resultReady({ resultHash:checked.resultHash })
    lease.assertOwned(); tracker.assertOwned()
    if (!await currentSourcesMatchJob(job)) {
      await tracker.completedStale(errorWithCode('strategy_memory_consistency_source_stale'))
      await queryRun(`UPDATE strategy_memory_consistency_jobs SET status = 'stale', last_error_code = ?,
        lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      ['strategy_memory_consistency_source_stale', beijingNow(), beijingNow(), job.id, job.lease_token])
      return { claimed:true, status:'stale', jobId:Number(job.id) }
    }
    await tracker.applying()
    lease.assertOwned(); tracker.assertOwned()
    if (typeof applyValidatedFindings === 'function') {
      await applyValidatedFindings({ job:{ ...publicJob(job),
        strategy_text_snapshot:job.strategy_text_snapshot,
        memory_content_snapshot:job.memory_content_snapshot },
      candidates:checked.candidates, result:checked.result })
    }
    const applied = await applyConsistencyResult(job, checked)
    await tracker.succeeded({ resultRef:`strategy_memory_consistency:${job.id}`, resultHash:checked.resultHash })
    return { claimed:true, status:applied.status, jobId:Number(job.id), result:checked.result }
  } catch (error) {
    const code = String(error?.code || error?.message || 'strategy_memory_consistency_failed').split(':')[0]
    let modelTask = null
    if (tracker) {
      try { modelTask = await tracker.failed(error, Number(job.attempt_count) >= Number(job.max_attempts || 3)) }
      catch (trackerError) { console.error(`[StrategyMemoryConsistency job=${job.id}] tracker failure:`, safeError(trackerError)) }
    }
    const unknown = providerResultUnknown(tracker, modelTask) || code === 'provider_status_unknown'
    const exhausted = Number(job.attempt_count) >= Number(job.max_attempts || 3)
    try { await markJobFailure(job, unknown ? 'provider_status_unknown' : code, !unknown && !exhausted) }
    catch (failureError) { console.error(`[StrategyMemoryConsistency job=${job.id}] durable failure update failed:`, safeError(failureError)) }
    return { claimed:true, status:unknown ? 'status_unknown' : 'failed', jobId:Number(job.id), error:safeError(error) }
  } finally {
    try { await tracker?.stop() } catch (error) { console.error(`[StrategyMemoryConsistency job=${job.id}] tracker stop:`, safeError(error)) }
    await lease.stop()
  }
}

export async function runStrategyMemoryConsistencyOnceWithoutApplying(options = {}) {
  return runStrategyMemoryConsistencyOnce({ ...options, applyValidatedFindings:null })
}

async function inspectStrategyMemoryConsistencyModelTask(task) {
  const job = await queryOne(`SELECT id, strategy_id, status, strategy_version, library_version_no,
      library_content_hash, result_hash, model_task_id FROM strategy_memory_consistency_jobs
      WHERE model_task_id = ? LIMIT 1`, [task.task_id])
  if (!job) return null
  const succeeded = ['succeeded', 'succeeded_noop'].includes(String(job.status || ''))
  return { job, succeeded, resultRef:succeeded ? `strategy_memory_consistency:${job.id}` : null,
    resultHash:job.result_hash || null }
}

async function transitionConsistencyBusiness({ action, task, business, reason }) {
  const jobId = Number(business?.job?.id || 0)
  if (!jobId) return
  const now = beijingNow()
  if (action === 'requeued') {
    await queryRun(`UPDATE strategy_memory_consistency_jobs SET status = 'queued', model_task_id = NULL,
      last_error_code = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND model_task_id = ? AND status NOT IN ('succeeded','succeeded_noop','stale','status_unknown')`,
    [now, jobId, task.task_id])
  } else if (action === 'status_unknown') {
    await queryRun(`UPDATE strategy_memory_consistency_jobs SET status = 'status_unknown',
      last_error_code = 'provider_status_unknown', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND model_task_id = ? AND status NOT IN ('succeeded','succeeded_noop','stale','status_unknown')`,
    [now, jobId, task.task_id])
  } else if (action === 'stale') {
    await queryRun(`UPDATE strategy_memory_consistency_jobs SET status = 'stale',
      last_error_code = ?, lease_token = NULL, lease_expires_at = NULL,
      completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE id = ? AND model_task_id = ? AND status NOT IN ('succeeded','succeeded_noop','failed','stale')`,
    [String(reason || 'strategy_memory_consistency_recovery_stale').slice(0, 128), now, now, jobId, task.task_id])
  }
}

export async function recoverAbandonedStrategyMemoryConsistencyModelTasks({ nowUtcMs = Date.now(), limit = 100 } = {}) {
  return recoverAbandonedBusinessModelTasks({ taskKinds:[STRATEGY_MEMORY_CONSISTENCY_TASK_KIND], nowUtcMs, limit,
    inspectBusiness:inspectStrategyMemoryConsistencyModelTask, onBusinessTransition:transitionConsistencyBusiness })
}

let workerTimer = null
let workerRunning = false
let workerWake = false
let workerImmediate = null

export function requestStrategyMemoryConsistencyCycle() {
  workerWake = true
  if (workerRunning || workerImmediate) return false
  workerImmediate = setImmediate(async () => {
    workerImmediate = null
    if (workerRunning) return
    workerRunning = true
    try {
      while (workerWake) {
        workerWake = false
        await recoverAbandonedStrategyMemoryConsistencyModelTasks()
        await runStrategyMemoryConsistencyOnce()
      }
    } catch (error) {
      console.error('[StrategyMemoryConsistency] cycle failed:', safeError(error))
    } finally {
      workerRunning = false
      if (workerWake) requestStrategyMemoryConsistencyCycle()
    }
  })
  return true
}

export function startStrategyMemoryConsistencyWorker(intervalMs = STRATEGY_MEMORY_CONSISTENCY_DEFAULT_INTERVAL_MS) {
  if (workerTimer) return false
  workerTimer = setInterval(requestStrategyMemoryConsistencyCycle,
    Math.max(5_000, Number(intervalMs) || STRATEGY_MEMORY_CONSISTENCY_DEFAULT_INTERVAL_MS))
  workerTimer.unref?.()
  requestStrategyMemoryConsistencyCycle()
  return true
}

export function stopStrategyMemoryConsistencyWorker() {
  if (!workerTimer) return false
  clearInterval(workerTimer)
  workerTimer = null
  if (workerImmediate) clearImmediate(workerImmediate)
  workerImmediate = null
  workerWake = false
  return true
}
