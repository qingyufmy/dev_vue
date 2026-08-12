// Durable model worker for the unified per-strategy memory library.
//
// A compression job freezes one library version and one set of pending review
// updates.  The provider call is wrapped in the same model-task envelope as
// the other background jobs so a lost lease or an unknown provider result can
// never be replayed blindly.

import crypto from 'node:crypto'
import { queryAll, queryOne, queryRun, beijingNow } from '../../db.js'
import { requestJsonObject } from './llm.js'
import { resolveAiTaskModel } from './model-profiles.js'
import { MODEL_PROVIDER_DEFAULTS, modelProviderProtocol } from './model-providers.js'
import { getModelProviderCapabilities } from './model-provider-capabilities.js'
import { createModelTaskTracker } from './model-task-tracker.js'
import { recoverAbandonedBusinessModelTasks } from './model-task-runtime.js'
import { estimateModelInputTokens, modelTaskDeadlines, selectModelTaskBudget } from './model-task-budget.js'
import {
  applyStrategyMemoryCompressionJob,
  claimStrategyMemoryCompressionJob,
  failStrategyMemoryCompressionJob,
  renewStrategyMemoryCompressionLease,
  sanitizeStrategyMemoryText,
  strategyMemoryCharCount,
} from './strategy-memory-library.js'

export const STRATEGY_MEMORY_COMPRESSION_LEASE_MS = 15 * 60_000
export const STRATEGY_MEMORY_COMPRESSION_HEARTBEAT_MS = 30_000
export const STRATEGY_MEMORY_COMPRESSION_DEFAULT_INTERVAL_MS = 60_000

const TERMINAL_MODEL_TASK_STATES = new Set([
  'cancelled', 'failed_terminal', 'succeeded', 'completed_stale', 'completed_rejected',
])

function safeError(error) {
  return String(error?.message || error || 'strategy_memory_compression_failed')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 512)
}

function errorWithCode(code, detail = '') {
  const error = new Error(detail ? `${code}:${detail}` : code)
  error.code = code
  return error
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

function positiveIds(value) {
  const values = Array.isArray(value) ? value : parseJson(value, [])
  return [...new Set((Array.isArray(values) ? values : [])
    .map(item => Number(item)).filter(item => Number.isInteger(item) && item > 0))]
}

function strategyPromptText(strategy) {
  return sanitizeStrategyMemoryText(String(strategy?.system_prompt || strategy?.description || '')
    .replace(/\r\n?/g, '\n'))
}

function modelEndpoint(model) {
  const provider = model?.provider || model?.api_provider
  const protocol = modelProviderProtocol(provider)
  const base = String(model?.api_base_url || MODEL_PROVIDER_DEFAULTS[provider] || '').replace(/\/+$/, '')
  if (!base) throw errorWithCode('unsupported_compression_model_provider')
  return { protocol, url: `${base}/${protocol === 'responses' ? 'responses' : 'chat/completions'}` }
}

function requestTimeoutMs(deadlines, nowUtcMs = Date.now()) {
  return Math.max(1, Math.trunc(Math.min(deadlines.attemptSafetyDeadlineUtcMs, deadlines.taskDeadlineUtcMs) - nowUtcMs))
}

/**
 * Read all frozen job inputs without applying a character limit.  The physical
 * provider capability check happens after the complete prompt is assembled;
 * silently truncating a memory update would make the durable source set lie.
 */
export async function loadStrategyMemoryCompressionInputs(job) {
  const strategy = await queryOne(`SELECT id, scope, owner_user_id, title, version,
      visibility_status, is_active, system_prompt, description
    FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [job.strategy_id])
  if (!strategy) throw errorWithCode('strategy_memory_strategy_not_found')
  const library = await queryOne(
    'SELECT * FROM strategy_memory_libraries WHERE strategy_id = ? LIMIT 1', [job.strategy_id]
  )
  if (!library) throw errorWithCode('strategy_memory_library_not_found')
  if (Number(library.version_no) !== Number(job.source_version_no)
      || String(library.content_hash || '') !== String(job.source_content_hash || '')) {
    throw errorWithCode('strategy_memory_compression_stale')
  }
  const pendingIds = positiveIds(job.pending_update_ids_json)
  let pendingUpdates = []
  if (pendingIds.length) {
    pendingUpdates = await queryAll(
      `SELECT * FROM strategy_memory_pending_updates
        WHERE strategy_id = ? AND status = 'pending' AND id IN (${pendingIds.map(() => '?').join(',')})
        ORDER BY id ASC`, [job.strategy_id, ...pendingIds]
    )
    const found = new Set(pendingUpdates.map(row => Number(row.id)))
    if (pendingIds.some(id => !found.has(id))) {
      throw errorWithCode('strategy_memory_pending_update_stale')
    }
  }
  return {
    strategy,
    strategyText:strategyPromptText(strategy),
    library,
    pendingIds,
    pendingUpdates,
  }
}

export function buildStrategyMemoryCompressionMessages({ strategy, strategyText, library, pendingUpdates,
  pendingIds = [], targetChars, includePendingUpdates = true }) {
  const target = Math.max(1, Math.trunc(Number(targetChars) || 0))
  const currentText = sanitizeStrategyMemoryText(library?.content_text || '')
  const updates = (Array.isArray(pendingUpdates) ? pendingUpdates : []).map(row => ({
    id:Number(row.id), update_kind:String(row.update_kind || ''),
    content_text:sanitizeStrategyMemoryText(row.content_text || ''),
    source_refs:parseJson(row.source_refs_json, null),
  }))
  const system = [
    '你负责压缩单个策略的统一记忆库。只返回一个 JSON 对象，字段必须是 content_text。',
    'content_text 必须是 Markdown 字符串，字符数不得超过 target_chars。',
    '只能整理、合并和压缩已经给出的内容；不得创造新的交易规则、改变风险边界或替策略做决定。',
    '保留有意义的自然语言边界、反例、冲突与不确定性；禁止生成或保留 applicable_when/avoid_when JSON、原始 applicability JSON、迁移表名或迁移来源内部 ID。',
    '当前策略是唯一行为约束。记忆经验不能覆盖策略、风险政策或人工配置。',
  ].join('\n')
  const user = JSON.stringify({
    target_chars:target,
    strategy:{ id:Number(strategy?.id), title:strategy?.title || null, version:strategy?.version ?? null,
      text:String(strategyText || '') },
    current_memory_library:{ version_no:Number(library?.version_no || 0), content_hash:library?.content_hash || null,
      content_text:currentText },
    frozen_pending_updates:includePendingUpdates ? { ids:pendingIds, updates } : { ids:[], updates:[] },
    output_contract:{ content_text:'string', max_characters:target },
  })
  return [
    { role:'system', content:system },
    { role:'user', content:user },
  ]
}

export async function prepareStrategyMemoryCompressionModelCall(resolved, messages, {
  nowUtcMs = Date.now(), businessDeadlineUtcMs = null, capabilities = null,
} = {}) {
  const providerCapabilities = capabilities || await getModelProviderCapabilities(resolved?.model_profile_id)
  const budget = selectModelTaskBudget({
    taskKind:'memory_compression',
    providerOutputCap:providerCapabilities?.max_output_tokens,
    contextWindowTokens:providerCapabilities?.context_window_tokens,
    maxInputTokens:providerCapabilities?.max_input_tokens ?? providerCapabilities?.provider_max_input_tokens,
    contextLimitSemantics:providerCapabilities?.context_limit_semantics,
    capabilities:providerCapabilities,
    // The profile's legacy max_tokens is deliberately not passed as a cap.
    profile:null,
    estimatedInputTokens:estimateModelInputTokens(messages),
    schemaNeedTokens:Math.max(1_200, Math.ceil(JSON.stringify({ content_text:'string' }).length / 2)),
  })
  if (budget.reason === 'model_token_limits_unconfirmed' || budget.reason === 'model_token_limits_stale') {
    throw errorWithCode(budget.reason)
  }
  if (budget.reason === 'model_input_limit_exceeded' || budget.inputLimitExceeded) {
    throw errorWithCode('model_input_limit_exceeded')
  }
  if (!budget.sufficient || budget.selectedMaxOutputTokens <= 0) {
    throw errorWithCode('output_budget_insufficient')
  }
  const deadlines = modelTaskDeadlines('memory_compression', { nowUtcMs, businessDeadlineUtcMs })
  return {
    budget,
    ...deadlines,
    requestTimeoutMs:requestTimeoutMs(deadlines, nowUtcMs),
    capabilities:providerCapabilities,
  }
}

function startCompressionLeaseHeartbeat(job, {
  leaseMs = STRATEGY_MEMORY_COMPRESSION_LEASE_MS,
  intervalMs = STRATEGY_MEMORY_COMPRESSION_HEARTBEAT_MS,
} = {}) {
  const controller = new AbortController()
  let stopped = false
  let pending = null
  const renew = async () => {
    if (stopped || pending || controller.signal.aborted) return
    pending = renewStrategyMemoryCompressionLease({ jobId:job.id, leaseToken:job.lease_token, leaseMs })
      .catch(error => {
        if (!controller.signal.aborted) controller.abort(error)
      }).finally(() => { pending = null })
    await pending
  }
  const timer = setInterval(() => { void renew() }, Math.max(1_000, Number(intervalMs) || 30_000))
  timer.unref?.()
  return {
    signal:controller.signal,
    assertOwned:() => controller.signal.throwIfAborted(),
    async stop() {
      stopped = true
      clearInterval(timer)
      if (pending) await pending
    },
  }
}

function providerResultUnknown(tracker, task = null) {
  const status = String(task?.status || tracker?.status || '')
  if (status === 'status_unknown' || status === 'provider_quiet') return true
  const state = tracker?.providerRequestState
  return state?.submitted === true && state?.responseReceived !== true
}

async function linkModelTask(job, taskId) {
  const result = await queryRun(`UPDATE strategy_memory_compression_jobs
    SET model_task_id = CASE WHEN model_task_id IS NULL OR model_task_id = ? THEN ? ELSE model_task_id END,
        updated_at = ?
    WHERE id = ? AND lease_token = ?`, [taskId, taskId, beijingNow(), job.id, job.lease_token])
  const affected = Number(result?.affectedRows ?? result?.changes)
  if (Number.isFinite(affected) && affected > 0) return true
  const linked = await queryOne('SELECT model_task_id FROM strategy_memory_compression_jobs WHERE id = ? LIMIT 1', [job.id])
  if (String(linked?.model_task_id || '') !== String(taskId)) throw errorWithCode('model_task_link_failed')
  return true
}

async function clearTerminalModelTaskLink(job) {
  if (!job.model_task_id) return
  const task = await queryOne('SELECT task_id, status, idempotency_key FROM ai_model_tasks WHERE task_id = ? LIMIT 1', [job.model_task_id])
  if (!task) return
  const status = String(task.status || '')
  if (status === 'queued' || status === 'retry_wait') {
    // A deterministic provider/validation failure may leave the generic task
    // in retry_wait. Reuse its idempotency key so the tracker claims that
    // durable envelope instead of creating a second provider task.
    job._priorIdempotencyKey = task.idempotency_key || null
    return
  }
  if (status === 'status_unknown' || status === 'provider_quiet'
      || !TERMINAL_MODEL_TASK_STATES.has(status)) {
    if (status === 'status_unknown' || status === 'provider_quiet') {
      throw errorWithCode('provider_status_unknown')
    }
    throw errorWithCode('strategy_memory_model_task_active', status)
  }
  await queryRun(`UPDATE strategy_memory_compression_jobs SET model_task_id = NULL, updated_at = ?
    WHERE id = ? AND lease_token = ?`, [beijingNow(), job.id, job.lease_token])
  job.model_task_id = null
}

async function failClaimedJob(job, errorCode, retryable) {
  try {
    return await failStrategyMemoryCompressionJob({ jobId:job.id, leaseToken:job.lease_token,
      retryable, attemptCount:Number(job.attempt_count || 1),
      errorCode:String(errorCode || 'strategy_memory_compression_failed').slice(0, 128) })
  } catch (error) {
    // A lost lease is already visible in the durable job row. Do not mask the
    // original provider/model error with a second lease error.
    if (String(error?.message || '').includes('lease_lost')) return { id:job.id, status:'lease_lost' }
    throw error
  }
}

export async function runStrategyMemoryCompressionOnce({ requestModel = requestJsonObject } = {}) {
  const job = await claimStrategyMemoryCompressionJob({
    workerId:`strategy-memory-compression:${process.pid}`,
    leaseMs:STRATEGY_MEMORY_COMPRESSION_LEASE_MS,
  })
  if (!job) return { claimed:false }
  const lease = startCompressionLeaseHeartbeat(job)
  let tracker = null
  let resolved = null
  try {
    const inputs = await loadStrategyMemoryCompressionInputs(job)
    const ownerUserId = inputs.strategy.scope === 'private' ? Number(inputs.strategy.owner_user_id) : 0
    if (String(job.last_error_code || '') === 'provider_status_unknown') {
      throw errorWithCode('provider_status_unknown')
    }
    resolved = await resolveAiTaskModel({
      userId:ownerUserId,
      strategyId:Number(job.strategy_id),
      usage:'memory_compression',
    })
    if (!resolved?.model) throw errorWithCode(resolved?.error || 'compression_model_unavailable')
    const targetChars = Math.max(1, Number(job.target_chars) || 1)
    // A queued capacity job may carry updates that are not current yet. They
    // are deliberately excluded from the provider prompt: the server appends
    // those frozen rows after compressing only the old library.
    const messages = buildStrategyMemoryCompressionMessages({ ...inputs, targetChars,
      includePendingUpdates:inputs.pendingIds.length === 0 })
    const nowUtcMs = Date.now()
    const deadlines = await prepareStrategyMemoryCompressionModelCall(resolved, messages, {
      nowUtcMs, capabilities:null,
    })
    await clearTerminalModelTaskLink(job)
    const endpoint = modelEndpoint(resolved.model)
    const sourceHash = sha256(JSON.stringify({ strategy_id:Number(job.strategy_id), source_version_no:Number(job.source_version_no),
      source_content_hash:job.source_content_hash, pending_ids:inputs.pendingIds }))
    const idempotencyKey = job._priorIdempotencyKey
      || `strategy_memory_compression:${job.id}:${sourceHash}:attempt:${Math.max(1, Number(job.attempt_count) || 1)}`
    const taskDeadline = Math.min(deadlines.taskDeadlineUtcMs, deadlines.attemptSafetyDeadlineUtcMs + 45 * 60_000)
    tracker = await createModelTaskTracker({
      taskKind:'memory_compression', queueClass:'background', ownerUserId,
      strategyId:Number(job.strategy_id), domainType:'strategy_memory_compression_job', domainId:job.id,
      idempotencyKey, snapshotHash:sourceHash, inputHash:sha256(JSON.stringify(messages)),
      promptHash:sha256(messages.map(message => message.content).join('\n')),
      outputContractHash:sha256('{"content_text":"string"}'),
      provider:resolved.model.provider, model:resolved.model.model_name,
      modelProfileId:resolved.model_profile_id, protocol:endpoint.protocol,
      credentialSource:resolved.credential_source,
      frozenContext:{ strategy_id:Number(job.strategy_id), source_version_no:Number(job.source_version_no),
        source_content_hash:job.source_content_hash, pending_update_ids:inputs.pendingIds, target_chars:targetChars },
      maxAttempts:Number(job.max_attempts) || 3, taskDeadlineAtUtcMs:taskDeadline,
    }, { workerId:`strategy-memory-compression:${process.pid}`, leaseMs:STRATEGY_MEMORY_COMPRESSION_LEASE_MS,
      linkTask:taskId => linkModelTask(job, taskId) })
    await tracker.persistBudget(deadlines.budget)
    const providerSignal = AbortSignal.any([lease.signal, tracker.signal])
    const output = await requestModel({
      url:endpoint.url, apiKey:resolved.model.api_key_encrypted, provider:resolved.model.provider,
      model:resolved.model.model_name, temperature:0.1,
      maxTokens:deadlines.budget.selectedMaxOutputTokens,
      thinkingEnabled:resolved.model.thinking_enabled, reasoningEffort:resolved.model.reasoning_effort,
      protocol:endpoint.protocol, capabilities:deadlines.capabilities,
      modelProfileId:resolved.model_profile_id, timeout:deadlines.requestTimeoutMs,
      deadlineAtMs:Math.min(deadlines.attemptSafetyDeadlineUtcMs, deadlines.taskDeadlineUtcMs),
      followupValidUntilMs:deadlines.taskDeadlineUtcMs, allowFollowupRequests:false,
      signal:providerSignal, messages, modelTaskBudget:deadlines.budget,
      usageContext:{ userId:ownerUserId, profileId:resolved.model_profile_id,
        credentialSource:resolved.credential_source, usage:'memory_compression', strategyId:Number(job.strategy_id) },
      onProviderRequest:event => tracker.onProviderRequest(event),
      onProviderUsage:event => tracker.onProviderUsage(event),
      onProviderActivity:event => tracker.onProviderActivity(event),
      onProviderQuiet:event => tracker.onProviderQuiet(event),
      validateObject:value => {
        if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, 'content_text')
            || typeof value.content_text !== 'string') throw errorWithCode('strategy_memory_compression_output_invalid')
        const normalized = sanitizeStrategyMemoryText(value.content_text)
        if (strategyMemoryCharCount(normalized) > targetChars) throw errorWithCode('strategy_memory_compression_output_exceeds_target')
        return { content_text:normalized }
      },
    })
    if (!output || typeof output.content_text !== 'string') {
      throw errorWithCode('strategy_memory_compression_output_invalid')
    }
    const content = sanitizeStrategyMemoryText(output.content_text)
    if (strategyMemoryCharCount(content) > targetChars) throw errorWithCode('strategy_memory_compression_output_exceeds_target')
    await tracker.resultReady({ resultHash:sha256(content) })
    lease.assertOwned(); tracker.assertOwned()
    await tracker.applying()
    lease.assertOwned(); tracker.assertOwned()
    const applied = await applyStrategyMemoryCompressionJob({
      jobId:job.id, leaseToken:job.lease_token, content_text:content,
      actor:{ serverOwned:true, userId:ownerUserId, strategyScope:inputs.strategy.scope,
        strategyOwnerUserId:Number(inputs.strategy.owner_user_id || 0) },
    })
    await tracker.succeeded({ resultRef:`strategy_memory:${job.strategy_id}:revision:${applied.revision_id}` })
    return { claimed:true, status:'succeeded', strategyId:Number(job.strategy_id), jobId:Number(job.id), applied }
  } catch (error) {
    const code = String(error?.code || error?.message || 'strategy_memory_compression_failed').split(':')[0]
    let modelTask = null
    if (tracker) {
      try { modelTask = await tracker.failed(error, Number(job.attempt_count) >= Number(job.max_attempts || 3)) }
      catch (trackerError) { console.error(`[StrategyMemoryCompression job=${job.id}] tracker failure:`, safeError(trackerError)) }
    }
    const unknown = providerResultUnknown(tracker, modelTask) || code === 'provider_status_unknown'
    const exhausted = Number(job.attempt_count) >= Number(job.max_attempts || 3)
    try {
      await failClaimedJob(job, unknown ? 'provider_status_unknown' : code, !unknown && !exhausted)
    } catch (failError) {
      console.error(`[StrategyMemoryCompression job=${job.id}] durable failure update failed:`, safeError(failError))
    }
    return { claimed:true, status:unknown ? 'status_unknown' : 'failed', jobId:Number(job.id), error:safeError(error) }
  } finally {
    try { await tracker?.stop() } catch (error) { console.error(`[StrategyMemoryCompression job=${job.id}] tracker stop:`, safeError(error)) }
    await lease.stop()
  }
}

async function inspectStrategyMemoryCompressionModelTask(task) {
  const job = await queryOne(`SELECT id, strategy_id, status, model_task_id, attempt_count, max_attempts
      FROM strategy_memory_compression_jobs WHERE model_task_id = ? LIMIT 1`, [task.task_id])
  if (!job) return null
  const succeeded = String(job.status) === 'succeeded'
  return { job, succeeded, resultRef:succeeded ? `strategy_memory:${job.strategy_id}` : null }
}

async function transitionStrategyMemoryCompressionBusiness({ action, task, business, reason }) {
  const jobId = Number(business?.job?.id || 0)
  if (!jobId) return
  const now = beijingNow()
  if (action === 'requeued') {
    await queryRun(`UPDATE strategy_memory_compression_jobs SET status = 'queued', model_task_id = NULL,
      last_error_code = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND model_task_id = ? AND status NOT IN ('succeeded','failed')`, [now, jobId, task.task_id])
  } else if (action === 'status_unknown') {
    await queryRun(`UPDATE strategy_memory_compression_jobs SET status = 'failed',
      last_error_code = 'provider_status_unknown', lease_token = NULL, lease_expires_at = NULL,
      updated_at = ? WHERE id = ? AND model_task_id = ? AND status NOT IN ('succeeded','failed')`, [now, jobId, task.task_id])
  } else if (action === 'stale') {
    await queryRun(`UPDATE strategy_memory_compression_jobs SET status = 'failed',
      last_error_code = ?, lease_token = NULL, lease_expires_at = NULL,
      completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE id = ? AND model_task_id = ? AND status NOT IN ('succeeded','failed')`,
    [String(reason || 'model_task_recovery_stale').slice(0, 128), now, now, jobId, task.task_id])
  }
}

export async function recoverAbandonedStrategyMemoryCompressionModelTasks({ nowUtcMs = Date.now(), limit = 100 } = {}) {
  return recoverAbandonedBusinessModelTasks({
    taskKinds:['memory_compression'], nowUtcMs, limit,
    inspectBusiness:inspectStrategyMemoryCompressionModelTask,
    onBusinessTransition:transitionStrategyMemoryCompressionBusiness,
  })
}

let workerTimer = null

export function startStrategyMemoryCompressionWorker(intervalMs = STRATEGY_MEMORY_COMPRESSION_DEFAULT_INTERVAL_MS) {
  if (workerTimer) return false
  const cycle = async () => {
    try {
      await recoverAbandonedStrategyMemoryCompressionModelTasks()
      await runStrategyMemoryCompressionOnce()
    } catch (error) {
      console.error('[StrategyMemoryCompression] cycle failed:', safeError(error))
    }
  }
  workerTimer = setInterval(() => { void cycle() }, Math.max(5_000, Number(intervalMs) || STRATEGY_MEMORY_COMPRESSION_DEFAULT_INTERVAL_MS))
  workerTimer.unref?.()
  void cycle()
  return true
}

export function stopStrategyMemoryCompressionWorker() {
  if (!workerTimer) return false
  clearInterval(workerTimer)
  workerTimer = null
  return true
}
