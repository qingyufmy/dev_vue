import crypto from 'node:crypto'
import { queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { handleAnalyze } from './strategy.js'
import { getStrategyById } from './strategy-ownership.js'
import { getAnalyzeApiKey } from './config.js'
import { modelTaskDeadlines } from './model-task-budget.js'
import { beginModelTaskAttempt, claimModelTaskById, createModelTask,
  finishModelTaskAttempt, renewModelTaskLease, transitionModelTask,
  cancelModelTaskById, markModelTaskStatusUnknownById,
  markModelTaskSucceededFromResult, markModelTaskCompletedStaleById } from './model-task-runtime.js'

const INLINE_WAIT_MS = Math.max(100, Number(process.env.MANUAL_ANALYSIS_INLINE_WAIT_MS) || 1500)
const LEASE_MS = 120 * 1000
const RENEW_MS = 30 * 1000
const MAX_JSON_BYTES = 1024 * 1024

const activeJobs = new Map()
let recoveryTimer = null

function stableValue(value) {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stableValue)
  return Object.keys(value).sort().reduce((out, key) => {
    out[key] = stableValue(value[key])
    return out
  }, {})
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stableValue(value))).digest('hex')
}

function boundedJson(value, fallback = null) {
  if (value == null) return fallback
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) return fallback
    return JSON.parse(text)
  } catch { return fallback }
}

function parseJsonField(value, fallback = null) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return fallback }
}

function restoreSignalFromRow(row) {
  if (!row) return null
  const decision = parseJsonField(row.decision_json, {}) || {}
  const signal = {
    ...row,
    ...decision,
    id:row.id,
    user_id:Number(row.user_id),
    signal_type:row.signal_type || decision.signal_type || 'hold',
    confidence:row.confidence == null ? decision.confidence : Number(row.confidence),
    recommended_volume:row.recommended_volume == null ? decision.recommended_volume : Number(row.recommended_volume),
    is_executed:Boolean(Number(row.is_executed || 0)),
    market_data:parseJsonField(row.market_data_json, null),
    execution_result:parseJsonField(row.execution_result, null),
    decision_json:decision,
  }
  return signal
}

function compactResult(result) {
  if (!result || typeof result !== 'object') return result
  const copy = { ...result }
  let size = () => Buffer.byteLength(JSON.stringify(copy), 'utf8')
  if (size() <= MAX_JSON_BYTES) return copy
  if (copy.market && typeof copy.market === 'object') {
    copy.market = { ...copy.market, strategy_context:undefined, timeframes:undefined, visualization_klines:undefined }
  }
  if (size() <= MAX_JSON_BYTES) return copy
  if (copy.signal && typeof copy.signal === 'object') {
    copy.signal = { ...copy.signal,
      analysis:String(copy.signal.analysis || '').slice(0, 8000),
      reasoning:String(copy.signal.reasoning || '').slice(0, 8000),
      market_data:undefined,
    }
  }
  if (size() <= MAX_JSON_BYTES) return copy
  return { status:copy.status || 'success', signal:copy.signal || null, recovered:Boolean(copy.recovered), result_truncated:true }
}

function modelTuple(model = {}) {
  return {
    provider:String(model.api_provider || model.provider || '').trim().toLowerCase() || null,
    model:String(model.model_name || model.model || '').trim() || null,
    profileId:Number(model._model_profile_id || model.model_profile_id || 0) || null,
    credentialSource:String(model._credential_source || model.credential_source || '').trim() || null,
  }
}

function asErrorCode(error, fallback = 'manual_analysis_failed') {
  const raw = String(error?.code || error?.message || fallback)
  return /^[a-z][a-z0-9_:-]{1,127}$/i.test(raw) ? raw : fallback
}

function isTerminalJob(status) {
  return ['succeeded', 'failed', 'cancelled', 'status_unknown', 'completed_stale', 'expired'].includes(String(status))
}

function isTerminalTaskStatus(status) {
  return ['cancelled', 'failed_terminal', 'succeeded', 'completed_stale', 'completed_rejected'].includes(String(status))
}

function providerOutcomeUnknown(state) {
  return state?.submitted === true && state?.responseReceived !== true
}

function publicJob(row) {
  if (!row) return null
  const result = boundedJson(row.result_json)
  const params = boundedJson(row.params_json, {}) || {}
  const errorCode = row.error_code || null
  const error = errorCode || row.error_message
    ? { code:errorCode, message:row.error_message || errorCode }
    : null
  return {
    id: String(row.job_id || row.id),
    status: row.status,
    stage: row.stage || row.status,
    result,
    error,
    user_id: Number(row.user_id),
    strategy_id: row.strategy_id == null ? null : Number(row.strategy_id),
    strategy_version: row.strategy_version == null ? null : Number(row.strategy_version),
    model_task_id: row.model_task_id || null,
    cancel_requested: Boolean(Number(row.cancel_requested || 0)),
    created_at_utc_msc: Number(row.created_at_utc_msc || 0) || null,
    updated_at_utc_msc: Number(row.updated_at_utc_msc || 0) || null,
    completed_at_utc_msc: Number(row.completed_at_utc_msc || 0) || null,
    deadline_at_utc_msc: Number(row.deadline_at_utc_msc || 0) || null,
    params,
  }
}

async function loadJob(userId, jobId) {
  return queryOne(`SELECT * FROM ai_manual_analysis_jobs
    WHERE job_id = ? AND user_id = ? LIMIT 1`, [String(jobId), Number(userId)])
}

async function loadJobByTask(taskId) {
  return queryOne('SELECT * FROM ai_manual_analysis_jobs WHERE model_task_id = ? LIMIT 1', [String(taskId)])
}

async function updateJob(jobId, patch = {}) {
  const fields = []
  const values = []
  const put = (name, value) => { fields.push(`${name} = ?`); values.push(value) }
  if (patch.status !== undefined) put('status', patch.status)
  if (patch.stage !== undefined) put('stage', patch.stage)
  if (patch.result !== undefined) put('result_json', patch.result == null ? null : JSON.stringify(compactResult(patch.result)))
  if (patch.errorCode !== undefined) put('error_code', patch.errorCode)
  if (patch.errorMessage !== undefined) put('error_message', patch.errorMessage)
  if (patch.cancelRequested !== undefined) put('cancel_requested', patch.cancelRequested ? 1 : 0)
  if (patch.signalId !== undefined) put('signal_id', patch.signalId)
  if (patch.leaseToken !== undefined) put('lease_token', patch.leaseToken)
  if (patch.fencingToken !== undefined) put('fencing_token', patch.fencingToken)
  if (patch.completedAtUtcMs !== undefined) put('completed_at_utc_msc', patch.completedAtUtcMs)
  put('updated_at_utc_msc', Date.now())
  if (!fields.length) return
  values.push(String(jobId))
  await queryRun(`UPDATE ai_manual_analysis_jobs SET ${fields.join(', ')} WHERE job_id = ?`, values)
}

function normalizedParams(body = {}) {
  // This endpoint is deliberately never an execution endpoint. Keep the field
  // false in the frozen input so a queued task cannot later become a trade.
  return {
    session_id:String(body.session_id || 'default').trim().slice(0, 191) || 'default',
    symbol:String(body.symbol || '').trim().slice(0, 64),
    strategy_id:Number(body.strategy_id),
    auto_execute:false,
  }
}

async function readStrategySnapshot(userId, params, userRole = 'user') {
  const strategyId = Number(params.strategy_id)
  if (!Number.isInteger(strategyId) || strategyId <= 0) throw new Error('strategy_required')
  const strategy = await getStrategyById(strategyId, Number(userId), userRole, { forExecution:true })
  if (!strategy) throw new Error('strategy_not_available')
  return {
    strategyId,
    strategyVersion: Number(strategy.version || 1),
    promptHash: sha256(String(strategy.system_prompt || '')),
    systemPrompt: String(strategy.system_prompt || ''),
  }
}

async function resolveFrozenModel(userId, params) {
  try {
    const config = await getAnalyzeApiKey(Number(userId), String(params.session_id || 'default'), Number(params.strategy_id))
    return {
      provider: config?.api_provider || config?.provider || null,
      model: config?.model_name || config?.model || null,
      modelProfileId: Number(config?._model_profile_id) || null,
      credentialSource: config?._credential_source || null,
      protocol: config?.protocol || null,
    }
  } catch (error) {
    // Model availability is checked again by handleAnalyze. Do not put a
    // credential or transient provider failure into the durable snapshot.
    if (String(error?.message || '').includes('encryption_master_key_missing')) throw error
    return { provider:null, model:null, modelProfileId:null, credentialSource:null, protocol:null }
  }
}

export async function createManualAnalysisJob(userId, body = {}, options = {}) {
  const params = body && typeof body === 'object' ? body : {}
  if (params.auto_execute === true || String(params.auto_execute || '').toLowerCase() === 'true') {
    const error = new Error('manual_analysis_auto_execute_forbidden')
    error.code = 'manual_analysis_auto_execute_forbidden'
    throw error
  }
  const frozenParams = normalizedParams(params)
  if (!frozenParams.symbol) throw new Error('symbol_required')
  const strategy = await readStrategySnapshot(userId, frozenParams, options.userRole || 'user')
  const frozenModel = await resolveFrozenModel(userId, frozenParams)
  const inputHash = sha256(frozenParams)
  const requestKey = String(params.idempotency_key || params.request_id || '').trim()
  // The request hash is the durable idempotency boundary. An explicit key can
  // intentionally create a new run for the same market input; otherwise two
  // concurrent submissions of the same request share one model task.
  const sourceHash = sha256({ input_hash:inputHash, strategy_version:strategy.strategyVersion,
    prompt_hash:strategy.promptHash, model:frozenModel })
  let idempotencyKey = requestKey
    ? `manual:${Number(userId)}:${requestKey.slice(0, 140)}`
    : `manual:${Number(userId)}:source:${sourceHash}`
  const now = Date.now()
  const taskDeadline = modelTaskDeadlines('manual_analysis', { nowUtcMs:now }).taskDeadlineUtcMs
  let taskResult = await createModelTask({
    taskKind:'manual_analysis', queueClass:'interactive', ownerUserId:Number(userId),
    strategyId:strategy.strategyId, domainType:'manual_analysis', domainId:null,
    idempotencyKey, inputHash, promptHash:strategy.promptHash,
    provider:frozenModel.provider, model:frozenModel.model,
    modelProfileId:frozenModel.modelProfileId, protocol:frozenModel.protocol,
    credentialSource:frozenModel.credentialSource,
    frozenContext:{ strategy_version:strategy.strategyVersion, prompt_hash:strategy.promptHash,
      request_params:frozenParams }, taskDeadlineAtUtcMs:taskDeadline,
    resultValidUntilUtcMs:taskDeadline, maxAttempts:1,
  })
  if (!taskResult.task?.task_id) throw new Error('manual_analysis_task_create_failed')
  if (!taskResult.created) {
    const existingModel = modelTuple({ provider:taskResult.task.frozen_provider, model:taskResult.task.frozen_model,
      model_profile_id:taskResult.task.frozen_model_profile_id,
      credential_source:taskResult.task.frozen_credential_source })
    const requestedModel = modelTuple(frozenModel)
    const envelopeConflict = taskResult.task.input_hash && String(taskResult.task.input_hash) !== inputHash
      || taskResult.task.prompt_hash && String(taskResult.task.prompt_hash) !== strategy.promptHash
      || existingModel.provider && existingModel.provider !== requestedModel.provider
      || existingModel.model && existingModel.model !== requestedModel.model
      || existingModel.profileId && existingModel.profileId !== requestedModel.profileId
      || existingModel.credentialSource && existingModel.credentialSource !== requestedModel.credentialSource
    if (envelopeConflict) throw new Error('manual_analysis_idempotency_conflict')
    if (String(taskResult.task.status) === 'status_unknown'
      && Number(taskResult.task.task_deadline_at_utc_msc || 0) > 0
      && Number(taskResult.task.task_deadline_at_utc_msc) <= now) {
      const stale = await markModelTaskCompletedStaleById(taskResult.task.task_id,
        'manual_analysis_status_unknown_deadline_expired', { requireDeadlineReached:true, nowUtcMs:now })
      if (stale) {
        const existingJob = await loadJobByTask(taskResult.task.task_id)
        if (existingJob) {
          await updateJob(existingJob.job_id, { status:'completed_stale', stage:'completed_stale',
            errorCode:'manual_analysis_status_unknown_deadline_expired',
            errorMessage:'provider outcome remained unknown until the task deadline', completedAtUtcMs:now })
        }
        taskResult = { ...taskResult, task:{ ...taskResult.task, status:'completed_stale' } }
      } else {
        const refreshed = await queryOne('SELECT * FROM ai_model_tasks WHERE task_id = ? LIMIT 1',
          [taskResult.task.task_id])
        if (refreshed && isTerminalTaskStatus(refreshed.status)) {
          taskResult = { ...taskResult, task:refreshed }
        }
      }
    }
  }
  // A completed task is a historical result, not an active idempotency slot.
  // Allow a deliberate repeat while retaining the same-key dedupe guarantee
  // for queued/running tasks.
  if (!taskResult.created && isTerminalTaskStatus(taskResult.task.status)) {
    idempotencyKey = `${idempotencyKey}:retry:${crypto.randomUUID()}`
    taskResult = await createModelTask({
      taskKind:'manual_analysis', queueClass:'interactive', ownerUserId:Number(userId),
      strategyId:strategy.strategyId, domainType:'manual_analysis', domainId:null,
      idempotencyKey, inputHash, promptHash:strategy.promptHash,
      provider:frozenModel.provider, model:frozenModel.model,
      modelProfileId:frozenModel.modelProfileId, protocol:frozenModel.protocol,
      credentialSource:frozenModel.credentialSource,
      frozenContext:{ strategy_version:strategy.strategyVersion, prompt_hash:strategy.promptHash,
        request_params:frozenParams }, taskDeadlineAtUtcMs:taskDeadline,
      resultValidUntilUtcMs:taskDeadline, maxAttempts:1,
    })
  }
  const taskId = String(taskResult.task.task_id)
  let job = await loadJobByTask(taskId)
  if (!job) {
    const jobId = crypto.randomUUID()
    try {
      await queryRun(`INSERT INTO ai_manual_analysis_jobs
        (job_id, user_id, strategy_id, strategy_version, strategy_prompt_hash,
         request_hash, params_json, model_task_id, status, stage, cancel_requested,
         deadline_at_utc_msc, created_at_utc_msc, updated_at_utc_msc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, ?, ?)`,
      [jobId, Number(userId), strategy.strategyId, strategy.strategyVersion, strategy.promptHash,
        inputHash, JSON.stringify(frozenParams), taskId, taskDeadline, now, now])
      job = await loadJob(userId, jobId)
    } catch (error) {
      // A concurrent request with the same model-task idempotency key won the
      // insert. Return its job rather than ever issuing another provider call.
      job = await loadJobByTask(taskId)
      if (!job) throw error
    }
  }
  if (!job) throw new Error('manual_analysis_job_create_failed')
  const promise = processManualAnalysisJob(String(job.job_id))
  // Keep the promise alive after an HTTP response; browser disconnects are not
  // cancellation. Callers may await it when using the short inline window.
  if (options.waitForCompletion === false) return publicJob(job)
  const completed = await Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(null), Math.max(100, Number(options.inlineWaitMs) || INLINE_WAIT_MS))),
  ])
  return completed || publicJob(await loadJob(userId, job.job_id))
}

async function transitionToApplying(task) {
  let current = task
  const steps = {
    leased:'preparing', preparing:'submitted', submitted:'response_received',
    provider_running:'response_received', provider_quiet:'response_received',
    response_received:'validating', validating:'result_ready', result_ready:'applying',
  }
  let guard = 0
  while (current && current.status !== 'applying' && guard++ < 8) {
    const next = steps[current.status]
    if (!next) break
    current = await transitionModelTask(current, next)
  }
  return current
}

async function ensureTaskFailed(task, error, terminal = true) {
  if (!task || ['succeeded', 'cancelled', 'completed_stale', 'completed_rejected', 'failed_terminal'].includes(task.status)) return
  try {
    const toStatus = terminal ? 'failed_terminal' : 'retry_wait'
    await transitionModelTask(task, toStatus, {
      errorCode:asErrorCode(error), errorMessage:String(error?.message || error || 'manual_analysis_failed').slice(0, 512),
    })
  } catch (transitionError) {
    if (!String(transitionError?.message || '').includes('fence_lost')) {
      console.error('[ManualAnalysis] failed to persist task failure:', transitionError.message)
    }
  }
}

async function markTaskTerminal(task, status, patch = {}) {
  if (!task) return null
  try {
    return await transitionModelTask(task, status, patch)
  } catch (error) {
    if (!String(error?.message || '').includes('fence_lost')) console.error('[ManualAnalysis] terminal transition failed:', error.message)
    return null
  }
}

async function processManualAnalysisJob(jobId) {
  const key = String(jobId)
  if (activeJobs.has(key)) return activeJobs.get(key).promise
  const controller = new AbortController()
  const active = { controller, promise:null }
  active.promise = (async () => {
    let job = await queryOne('SELECT * FROM ai_manual_analysis_jobs WHERE job_id = ? LIMIT 1', [key])
    if (!job || isTerminalJob(job.status)) return publicJob(job)
    const existingSignal = await queryOne('SELECT * FROM ai_signals WHERE inference_task_id = ? LIMIT 1', [job.model_task_id])
    if (existingSignal) {
      const restoredSignal = restoreSignalFromRow(existingSignal)
      const result = { status:'success', signal:restoredSignal, market:restoredSignal?.market_data || null, recovered:true }
      await markModelTaskSucceededFromResult(job.model_task_id, {
        resultRef:`ai_signals:${existingSignal.id}`,
        resultHash:sha256(result),
      }).catch(error => console.error('[ManualAnalysis] failed to reconcile committed task:', error.message))
      await updateJob(key, { status:'succeeded', stage:'completed', result, signalId:existingSignal.id, completedAtUtcMs:Date.now(), errorCode:null, errorMessage:null })
      return publicJob(await queryOne('SELECT * FROM ai_manual_analysis_jobs WHERE job_id = ? LIMIT 1', [key]))
    }
    let task = await queryOne('SELECT * FROM ai_model_tasks WHERE task_id = ? LIMIT 1', [job.model_task_id])
    if (!task) throw new Error('manual_analysis_task_not_found')
    if (['status_unknown', 'completed_stale', 'completed_rejected', 'cancelled', 'failed_terminal'].includes(task.status)) {
      const nextStatus = task.status === 'status_unknown' ? 'status_unknown' : task.status === 'completed_stale' ? 'completed_stale' : task.status === 'cancelled' ? 'cancelled' : 'failed'
      await updateJob(key, { status:nextStatus, stage:nextStatus })
      return publicJob(await queryOne('SELECT * FROM ai_manual_analysis_jobs WHERE job_id = ? LIMIT 1', [key]))
    }
    if (Number(job.deadline_at_utc_msc || 0) <= Date.now()) {
      controller.abort(new Error('manual_analysis_expired'))
      await cancelModelTaskById(task.task_id, 'manual_analysis_expired').catch(() => {})
      await updateJob(key, { status:'expired', stage:'expired', errorCode:'manual_analysis_expired', errorMessage:'manual analysis deadline exceeded', completedAtUtcMs:Date.now() })
      return publicJob(await queryOne('SELECT * FROM ai_manual_analysis_jobs WHERE job_id = ? LIMIT 1', [key]))
    }
    if (task.status === 'submitted' || task.status === 'provider_running' || task.status === 'provider_quiet') {
      // No provider-specific poll adapter is wired into manual analysis yet.
      // A capability row alone is not proof that this process can reconcile a
      // request, so recovery must fail closed instead of issuing a duplicate.
      await markModelTaskStatusUnknownById(task.task_id, 'provider_status_unknown').catch(() => {})
      await updateJob(key, { status:'status_unknown', stage:'status_unknown', errorCode:'provider_status_unknown', errorMessage:'provider request was submitted before restart and cannot be polled' })
      return publicJob(await queryOne('SELECT * FROM ai_manual_analysis_jobs WHERE job_id = ? LIMIT 1', [key]))
    }
    const claimed = task.status === 'leased' && task.lease_token
      ? task
      : await claimModelTaskById(task.task_id, { leaseMs:LEASE_MS, workerId:`manual-analysis:${process.pid}` })
    if (!claimed) return publicJob(await queryOne('SELECT * FROM ai_manual_analysis_jobs WHERE job_id = ? LIMIT 1', [key]))
    task = claimed
    await updateJob(key, { status:'running', stage:'preparing', leaseToken:task.lease_token, fencingToken:task.fencing_token, errorCode:null, errorMessage:null })
    const deadlineTimer = setTimeout(() => controller.abort(new Error('manual_analysis_expired')), Math.max(1, Number(job.deadline_at_utc_msc) - Date.now()))
    deadlineTimer.unref?.()
    let leaseLost = false
    let leaseChain = Promise.resolve()
    const renewTimer = setInterval(() => {
      leaseChain = leaseChain.then(async () => {
        if (controller.signal.aborted) return
        if (!await renewModelTaskLease(task, LEASE_MS)) {
          leaseLost = true
          controller.abort(new Error('manual_analysis_lease_lost'))
        }
      }).catch(error => {
        leaseLost = true
        controller.abort(error)
      })
    }, RENEW_MS)
    renewTimer.unref?.()
    let attempt = null
    let attemptSequence = 0
    let providerAttemptState = { submitted:false, responseReceived:false, providerRequestId:null, httpStatus:null }
    const assertCanApply = async () => {
      await leaseChain
      if (leaseLost || controller.signal.aborted) {
        const error = new Error(leaseLost ? 'manual_analysis_lease_lost' : 'manual_analysis_cancelled')
        error.code = leaseLost ? 'manual_analysis_lease_lost' : 'manual_analysis_cancelled'
        throw error
      }
      const currentJob = await queryOne('SELECT status, cancel_requested, deadline_at_utc_msc, strategy_version, strategy_prompt_hash FROM ai_manual_analysis_jobs WHERE job_id = ? LIMIT 1', [key])
      if (!currentJob || Number(currentJob.cancel_requested) === 1 || ['cancelled','expired'].includes(currentJob.status)) {
        const error = new Error('manual_analysis_cancelled')
        error.code = 'manual_analysis_cancelled'
        throw error
      }
      if (Number(currentJob.deadline_at_utc_msc || 0) <= Date.now()) {
        const error = new Error('manual_analysis_expired')
        error.code = 'manual_analysis_expired'
        throw error
      }
      const currentStrategy = await queryOne('SELECT version, system_prompt FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL LIMIT 1', [Number(currentJob.strategy_id || job.strategy_id)])
      if (!currentStrategy || Number(currentStrategy.version || 1) !== Number(currentJob.strategy_version || 1)
        || sha256(String(currentStrategy.system_prompt || '')) !== String(currentJob.strategy_prompt_hash || '')) {
        const error = new Error('manual_analysis_source_stale')
        error.code = 'manual_analysis_source_stale'
        throw error
      }
      const freshTask = await queryOne(`SELECT status, lease_token, fencing_token,
        frozen_provider, frozen_model, frozen_model_profile_id, frozen_credential_source
        FROM ai_model_tasks WHERE task_id = ? LIMIT 1`, [job.model_task_id])
      if (!freshTask || freshTask.lease_token !== task.lease_token || Number(freshTask.fencing_token) !== Number(task.fencing_token)
        || ['cancelled','failed_terminal','completed_stale','completed_rejected','succeeded'].includes(freshTask.status)) {
        const error = new Error('manual_analysis_lease_lost')
        error.code = 'manual_analysis_lease_lost'
        throw error
      }
      const frozenModel = modelTuple({ provider:freshTask.frozen_provider, model:freshTask.frozen_model,
        model_profile_id:freshTask.frozen_model_profile_id, credential_source:freshTask.frozen_credential_source })
      if (frozenModel.provider || frozenModel.model || frozenModel.profileId || frozenModel.credentialSource) {
        let currentModel
        try { currentModel = modelTuple(await getAnalyzeApiKey(Number(job.user_id), String((boundedJson(job.params_json, {}) || {}).session_id || 'default'), Number(job.strategy_id))) }
        catch {
          const error = new Error('manual_analysis_model_stale')
          error.code = 'manual_analysis_model_stale'
          throw error
        }
        if (currentModel.provider !== frozenModel.provider || currentModel.model !== frozenModel.model
          || currentModel.profileId !== frozenModel.profileId || currentModel.credentialSource !== frozenModel.credentialSource) {
          const error = new Error('manual_analysis_model_stale')
          error.code = 'manual_analysis_model_stale'
          throw error
        }
      }
    }
    const assertCanApplyTx = async run => {
      const [jobRows] = await run(`SELECT status, cancel_requested, deadline_at_utc_msc
        FROM ai_manual_analysis_jobs WHERE job_id = ? FOR UPDATE`, [key])
      const lockedJob = jobRows?.[0]
      if (!lockedJob || lockedJob.status !== 'running' || Number(lockedJob.cancel_requested) === 1
        || Number(lockedJob.deadline_at_utc_msc || 0) <= Date.now()) {
        const error = new Error(Number(lockedJob?.deadline_at_utc_msc || 0) <= Date.now()
          ? 'manual_analysis_expired' : 'manual_analysis_cancelled')
        error.code = error.message
        throw error
      }
      const [taskRows] = await run(`SELECT status, lease_token, fencing_token
        FROM ai_model_tasks WHERE task_id = ? FOR UPDATE`, [job.model_task_id])
      const lockedTask = taskRows?.[0]
      if (!lockedTask || lockedTask.lease_token !== task.lease_token
        || Number(lockedTask.fencing_token) !== Number(task.fencing_token)
        || ['cancelled','failed_terminal','completed_stale','completed_rejected','succeeded','status_unknown'].includes(lockedTask.status)) {
        const error = new Error('manual_analysis_lease_lost')
        error.code = 'manual_analysis_lease_lost'
        throw error
      }
      return true
    }
    try {
      task = await transitionModelTask(task, 'preparing')
      await updateJob(key, { stage:'submitting' })
      const result = await handleAnalyze(Number(job.user_id), boundedJson(job.params_json, {}) || {}, {
        taskId:String(job.model_task_id), abortSignal:controller.signal, assertCanApply, assertCanApplyTx,
        taskDeadlineAtUtcMs:Number(task.task_deadline_at_utc_msc) || Number(job.deadline_at_utc_msc) || null,
        resultValidUntilUtcMs:Number(task.result_valid_until_utc_msc) || Number(job.deadline_at_utc_msc) || null,
        onProviderRequest:async event => {
          await assertCanApply()
          if (task.status === 'response_received') task = await transitionModelTask(task, 'validating')
          if (task.status === 'validating') task = await transitionModelTask(task, 'repairing')
          if (task.status === 'repairing') task = await transitionModelTask(task, 'submitted')
          if (task.status === 'preparing') task = await transitionModelTask(task, 'submitted')
          providerAttemptState = { submitted:true, responseReceived:false,
            providerRequestId:event?.providerRequestId || null, httpStatus:null }
          attempt = await beginModelTaskAttempt(task, { attemptNo:(Math.max(1, Number(task.attempt_count)) - 1) * 10 + (++attemptSequence), providerRequestId:event?.providerRequestId || null })
          await updateJob(key, { stage:'provider_running' })
        },
        onProviderUsage:async event => {
          const httpStatus = Number(event?.httpStatus)
          providerAttemptState = {
            submitted:true,
            responseReceived:event?.responseReceived === true || event?.status === 'success'
              || (Number.isFinite(httpStatus) && httpStatus > 0),
            providerRequestId:event?.providerRequestId || providerAttemptState.providerRequestId || null,
            httpStatus:Number.isFinite(httpStatus) && httpStatus > 0 ? httpStatus : null,
          }
          if (attempt) {
            await finishModelTaskAttempt(task, attempt, { status:event?.status === 'success' ? 'succeeded' : 'failed', providerRequestId:event?.providerRequestId,
              inputTokens:event?.inputTokens, outputTokens:event?.outputTokens, reasoningTokens:event?.reasoningTokens,
              cachedTokens:event?.cachedTokens, totalTokens:event?.totalTokens || event?.tokenCount,
              finishReason:event?.finishReason, incompleteDetails:event?.incompleteDetails, errorCode:event?.errorCode })
            attempt = null
          }
          if (event?.status === 'success' && ['submitted', 'provider_running', 'provider_quiet'].includes(task.status)) {
            task = await transitionModelTask(task, 'response_received', { finishReason:event?.finishReason, incompleteDetails:event?.incompleteDetails })
          }
        },
        onProviderActivity:async () => {
          if (task.status === 'submitted' || task.status === 'provider_quiet') {
            task = await transitionModelTask(task, 'provider_running')
          }
          await updateJob(key, { stage:'provider_running' })
        },
        onProviderQuiet:async () => {
          if (task.status === 'submitted' || task.status === 'provider_running') {
            task = await transitionModelTask(task, 'provider_quiet')
          }
          await updateJob(key, { stage:'provider_quiet' })
        },
      })
      await assertCanApply()
      if (result?.status !== 'success') {
        const error = new Error(result?.error_code || result?.message || 'manual_analysis_failed')
        error.code = result?.error_code || 'manual_analysis_failed'
        throw error
      }
      task = await transitionToApplying(task)
      if (!task || task.status !== 'applying') {
        const error = new Error('manual_analysis_lease_lost')
        error.code = 'manual_analysis_lease_lost'
        throw error
      }
      task = await markTaskTerminal(task, 'succeeded', { resultRef:`ai_signals:${result.signal?.id || ''}`, resultHash:sha256(result) })
      if (!task || task.status !== 'succeeded') {
        const error = new Error('manual_analysis_lease_lost')
        error.code = 'manual_analysis_lease_lost'
        throw error
      }
      await updateJob(key, { status:'succeeded', stage:'completed', result, signalId:result.signal?.id || null, completedAtUtcMs:Date.now(), errorCode:null, errorMessage:null })
    } catch (error) {
      const code = asErrorCode(error)
      const isCancel = ['manual_analysis_cancelled', 'manual_analysis_expired'].includes(code) || controller.signal.aborted && String(controller.signal.reason?.message || '').includes('cancel')
      const isStale = ['manual_analysis_source_stale', 'manual_analysis_model_stale'].includes(code)
      if (isStale) {
        await markModelTaskCompletedStaleById(task.task_id, code).catch(error =>
          console.error('[ManualAnalysis] failed to finalize stale task:', error.message))
        await updateJob(key, { status:'completed_stale', stage:'completed_stale', errorCode:code,
          errorMessage:code === 'manual_analysis_model_stale' ? 'model configuration changed while analysis was running' : 'strategy or prompt changed while analysis was running', completedAtUtcMs:Date.now() })
      } else if (isCancel) {
        await cancelModelTaskById(task.task_id, code).catch(() => {})
        await updateJob(key, { status:code === 'manual_analysis_expired' ? 'expired' : 'cancelled', stage:code === 'manual_analysis_expired' ? 'expired' : 'cancelled', errorCode:code, errorMessage:String(error?.message || code), completedAtUtcMs:Date.now() })
      } else if (code === 'manual_analysis_lease_lost' || code === 'model_task_fence_lost') {
        // A signal may have committed immediately before the fencing update
        // lost. Reconcile it on the next read; never claim success merely from
        // an unverified in-memory result.
        const committed = await queryOne('SELECT * FROM ai_signals WHERE inference_task_id = ? LIMIT 1', [job.model_task_id])
        if (committed) {
          const restoredSignal = restoreSignalFromRow(committed)
          await updateJob(key, { status:'succeeded', stage:'completed', result:{ status:'success', signal:restoredSignal, market:restoredSignal?.market_data || null, recovered:true }, signalId:committed.id, completedAtUtcMs:Date.now(), errorCode:null, errorMessage:null })
        } else {
          await markModelTaskStatusUnknownById(task.task_id, code).catch(() => {})
          await updateJob(key, { status:'status_unknown', stage:'status_unknown', errorCode:code, errorMessage:'task lease was lost before completion could be verified' })
        }
      } else if (providerOutcomeUnknown(providerAttemptState)) {
        await markModelTaskStatusUnknownById(task.task_id, 'provider_status_unknown').catch(() => {})
        await updateJob(key, { status:'status_unknown', stage:'status_unknown', errorCode:'provider_status_unknown',
          errorMessage:'provider request was submitted but no terminal response could be verified' })
      } else {
        await ensureTaskFailed(task, error, true)
        await updateJob(key, { status:'failed', stage:'failed', errorCode:code, errorMessage:String(error?.message || code).slice(0, 512), completedAtUtcMs:Date.now() })
      }
    } finally {
      clearInterval(renewTimer)
      clearTimeout(deadlineTimer)
      await leaseChain.catch(() => {})
    }
    return publicJob(await queryOne('SELECT * FROM ai_manual_analysis_jobs WHERE job_id = ? LIMIT 1', [key]))
  })().catch(async error => {
    const code = asErrorCode(error)
    await updateJob(key, { status:'failed', stage:'failed', errorCode:code, errorMessage:String(error?.message || code).slice(0, 512), completedAtUtcMs:Date.now() }).catch(() => {})
    return publicJob(await queryOne('SELECT * FROM ai_manual_analysis_jobs WHERE job_id = ? LIMIT 1', [key]))
  }).finally(() => activeJobs.delete(key))
  activeJobs.set(key, active)
  return active.promise
}

export async function getManualAnalysisJob(userId, jobId) {
  const row = await loadJob(userId, jobId)
  if (!row) throw new Error('manual_analysis_job_not_found')
  return publicJob(row)
}

export async function cancelManualAnalysisJob(userId, jobId) {
  const cancellation = await withTransaction(async run => {
    const [jobRows] = await run(`SELECT * FROM ai_manual_analysis_jobs
      WHERE job_id = ? AND user_id = ? LIMIT 1 FOR UPDATE`, [String(jobId), Number(userId)])
    const row = jobRows?.[0]
    if (!row) throw new Error('manual_analysis_job_not_found')
    if (isTerminalJob(row.status)) return { row, changed:false, existingSignal:null }
    // Lock in the same order as assertCanApplyTx (job -> signal/task). If the
    // signal already committed, cancellation loses the race and must restore
    // the succeeded result instead of showing a cancelled job.
    const [signalRows] = await run('SELECT * FROM ai_signals WHERE inference_task_id = ? LIMIT 1 FOR UPDATE', [row.model_task_id])
    if (signalRows?.[0]) return { row, changed:false, existingSignal:signalRows[0] }
    const now = Date.now()
    await run(`UPDATE ai_manual_analysis_jobs SET status='cancelled', stage='cancelled',
      cancel_requested=1, error_code='manual_analysis_cancelled', error_message='cancelled by user',
      completed_at_utc_msc=?, updated_at_utc_msc=? WHERE job_id=? AND user_id=?
      AND status IN ('queued','running')`, [now, now, String(jobId), Number(userId)])
    return { row, changed:true, existingSignal:null }
  })
  if (cancellation.existingSignal) {
    const restoredSignal = restoreSignalFromRow(cancellation.existingSignal)
    const result = { status:'success', signal:restoredSignal, market:restoredSignal?.market_data || null, recovered:true }
    await markModelTaskSucceededFromResult(cancellation.row.model_task_id, {
      resultRef:`ai_signals:${cancellation.existingSignal.id}`,
      resultHash:sha256(result),
    }).catch(error => console.error('[ManualAnalysis] failed to reconcile committed cancellation race:', error.message))
    await updateJob(jobId, { status:'succeeded', stage:'completed', result, signalId:cancellation.existingSignal.id,
      errorCode:null, errorMessage:null, completedAtUtcMs:Date.now() })
  } else if (cancellation.changed) {
    const active = activeJobs.get(String(jobId))
    active?.controller.abort(new Error('manual_analysis_cancelled'))
    await cancelModelTaskById(cancellation.row.model_task_id, 'manual_analysis_cancelled').catch(() => {})
  }
  return publicJob(await loadJob(userId, jobId))
}

export async function recoverManualAnalysisJobs() {
  const rows = await queryAll(`SELECT j.*, t.status AS task_status, t.frozen_model_profile_id
      , t.task_deadline_at_utc_msc
    FROM ai_manual_analysis_jobs j LEFT JOIN ai_model_tasks t ON t.task_id = j.model_task_id
    WHERE j.status IN ('queued','running','status_unknown') ORDER BY j.created_at_utc_msc LIMIT 100`)
  for (const row of rows) {
    try {
      const taskStatus = String(row.task_status || '')
      if (row.status === 'status_unknown' || taskStatus === 'status_unknown') {
        const deadlineAt = Number(row.task_deadline_at_utc_msc || row.deadline_at_utc_msc || 0)
        if (deadlineAt > 0 && deadlineAt <= Date.now()) {
          const stale = await markModelTaskCompletedStaleById(row.model_task_id,
            'manual_analysis_status_unknown_deadline_expired', { requireDeadlineReached:true, nowUtcMs:Date.now() })
          if (stale) {
            await updateJob(row.job_id, { status:'completed_stale', stage:'completed_stale',
              errorCode:'manual_analysis_status_unknown_deadline_expired',
              errorMessage:'provider outcome remained unknown until the task deadline', completedAtUtcMs:Date.now() })
          }
        }
        continue
      }
      if (['submitted','provider_running','provider_quiet'].includes(taskStatus)) {
        await markModelTaskStatusUnknownById(row.model_task_id, 'provider_status_unknown').catch(() => {})
        await updateJob(row.job_id, { status:'status_unknown', stage:'status_unknown', errorCode:'provider_status_unknown', errorMessage:'provider request was submitted before restart and cannot be polled' })
        continue
      }
      if (taskStatus === 'leased' || taskStatus === 'preparing') {
        await queryRun(`UPDATE ai_model_tasks SET status='queued', lease_token=NULL, lease_owner=NULL,
          lease_expires_at_utc_msc=NULL, updated_at_utc_msc=? WHERE task_id=? AND status IN ('leased','preparing')`,
        [Date.now(), row.model_task_id])
      }
      processManualAnalysisJob(String(row.job_id)).catch(error => console.error('[ManualAnalysis] recovery failed:', error.message))
    } catch (error) { console.error('[ManualAnalysis] recovery inspection failed:', error.message) }
  }
  return { inspected:rows.length }
}

export function startManualAnalysisJobs() {
  recoverManualAnalysisJobs().catch(error => console.error('[ManualAnalysis] startup recovery failed:', error.message))
  if (!recoveryTimer) {
    recoveryTimer = setInterval(() => {
      recoverManualAnalysisJobs().catch(error => console.error('[ManualAnalysis] periodic recovery failed:', error.message))
    }, 30_000)
    recoveryTimer.unref?.()
  }
}

export const __manualAnalysisJobsTest = {
  activeJobs,
  stableValue,
  sha256,
  restoreSignalFromRow,
  compactResult,
  publicJob,
  normalizedParams,
  isTerminalJob,
  providerOutcomeUnknown,
  processManualAnalysisJob,
}
