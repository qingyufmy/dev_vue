import crypto from 'node:crypto'
import { queryAll, queryOne, queryRun, withTransaction } from '../../db.js'

export const MODEL_TASK_TERMINAL_STATES = new Set([
  'cancelled', 'failed_terminal', 'succeeded', 'completed_stale', 'completed_rejected',
])

const TRANSITIONS = Object.freeze({
  queued:['leased', 'cancelled'],
  leased:['preparing', 'queued', 'cancelled', 'failed_terminal'],
  preparing:['submitted', 'retry_wait', 'failed_terminal', 'cancelled'],
  submitted:['provider_running', 'provider_quiet', 'status_unknown', 'response_received', 'retry_wait', 'failed_terminal', 'cancelled'],
  provider_running:['provider_quiet', 'status_unknown', 'response_received', 'retry_wait', 'failed_terminal', 'cancelled'],
  provider_quiet:['provider_running', 'status_unknown', 'response_received', 'retry_wait', 'failed_terminal', 'cancelled'],
  status_unknown:['reconciling', 'response_received', 'failed_terminal', 'completed_stale', 'cancelled'],
  reconciling:['provider_running', 'provider_quiet', 'status_unknown', 'response_received', 'retry_wait', 'failed_terminal'],
  response_received:['validating', 'retry_wait', 'failed_terminal'],
  validating:['repairing', 'retry_wait', 'result_ready', 'failed_terminal', 'completed_rejected'],
  repairing:['submitted', 'retry_wait', 'result_ready', 'failed_terminal'],
  retry_wait:['queued', 'cancelled', 'failed_terminal'],
  result_ready:['applying', 'completed_stale', 'completed_rejected', 'failed_terminal'],
  applying:['succeeded', 'completed_stale', 'completed_rejected', 'failed_terminal'],
})

export function canTransitionModelTask(fromStatus, toStatus) {
  if (fromStatus === toStatus) return true
  if (MODEL_TASK_TERMINAL_STATES.has(fromStatus)) return false
  return Boolean(TRANSITIONS[fromStatus]?.includes(toStatus))
}

export function assertModelTaskTransition(fromStatus, toStatus) {
  if (!canTransitionModelTask(fromStatus, toStatus)) {
    const error = new Error(`invalid_model_task_transition:${fromStatus}:${toStatus}`)
    error.code = 'invalid_model_task_transition'
    throw error
  }
}

function json(value) {
  return value == null ? null : JSON.stringify(value)
}

export async function appendModelTaskEvent(taskId, eventType, payload = null, attemptId = null, run = queryRun) {
  await run(`INSERT INTO ai_model_task_events
    (task_id, attempt_id, event_type, payload_json, created_at_utc_msc)
    VALUES (?, ?, ?, ?, ?)`, [taskId, attemptId || null, eventType, json(payload), Date.now()])
}

export async function createModelTask(input, run = queryRun) {
  const taskId = input.taskId || crypto.randomUUID()
  const now = Number(input.nowUtcMs) || Date.now()
  const result = await run(`INSERT IGNORE INTO ai_model_tasks
    (task_id, task_kind, queue_class, owner_user_id, strategy_id, domain_type, domain_id,
     idempotency_key, snapshot_hash, input_hash, prompt_hash, output_contract_hash,
     frozen_provider, frozen_model, frozen_model_profile_id, frozen_protocol, frozen_credential_source,
     frozen_context_json, status, priority, max_attempts, scheduled_at_utc_msc,
     task_deadline_at_utc_msc, result_valid_until_utc_msc, created_at_utc_msc, updated_at_utc_msc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
  [taskId, input.taskKind, input.queueClass || 'background', Number(input.ownerUserId) || 0,
    Number(input.strategyId) || null, input.domainType || null, input.domainId == null ? null : String(input.domainId),
    input.idempotencyKey || null, input.snapshotHash || null, input.inputHash || null, input.promptHash || null,
    input.outputContractHash || null, input.provider || null, input.model || null,
    Number(input.modelProfileId) || null, input.protocol || null, input.credentialSource || null,
    json(input.frozenContext), Number(input.priority) || 0, Math.max(1, Number(input.maxAttempts) || 1),
    Number(input.scheduledAtUtcMs) || now, Number(input.taskDeadlineAtUtcMs) || null,
    Number(input.resultValidUntilUtcMs) || null, now, now])
  const created = Number(result?.affectedRows ?? result?.changes ?? 0) === 1
  const task = created ? await queryOne('SELECT * FROM ai_model_tasks WHERE task_id = ?', [taskId])
    : await queryOne(`SELECT * FROM ai_model_tasks WHERE task_kind = ? AND idempotency_key = ? LIMIT 1`,
      [input.taskKind, input.idempotencyKey])
  if (created) await appendModelTaskEvent(taskId, 'task_created', { status:'queued' }, null, run)
  return { task, created }
}

export async function claimNextModelTask({ taskKinds = null, leaseMs = 120_000, workerId = null } = {}) {
  return withTransaction(async run => {
    const now = Date.now()
    const kinds = Array.isArray(taskKinds) && taskKinds.length ? taskKinds : null
    const kindClause = kinds ? `AND task_kind IN (${kinds.map(() => '?').join(',')})` : ''
    const [rows] = await run(`SELECT * FROM ai_model_tasks
      WHERE status IN ('queued','retry_wait') AND scheduled_at_utc_msc <= ?
        AND (lease_expires_at_utc_msc IS NULL OR lease_expires_at_utc_msc < ?)
        ${kindClause}
      ORDER BY priority DESC, scheduled_at_utc_msc, created_at_utc_msc LIMIT 1 FOR UPDATE`,
    [now, now, ...(kinds || [])])
    if (!rows[0]) return null
    const leaseToken = crypto.randomUUID()
    const fencingToken = Number(rows[0].fencing_token || 0) + 1
    await run(`UPDATE ai_model_tasks SET status = 'leased', lease_token = ?, fencing_token = ?,
      lease_owner = ?, lease_expires_at_utc_msc = ?, last_activity_at_utc_msc = ?,
      attempt_count = attempt_count + 1, updated_at_utc_msc = ? WHERE task_id = ?`,
    [leaseToken, fencingToken, workerId || null, now + Math.max(1_000, Number(leaseMs) || 120_000), now, now, rows[0].task_id])
    await appendModelTaskEvent(rows[0].task_id, 'task_leased', { worker_id:workerId, fencing_token:fencingToken }, null, run)
    return { ...rows[0], status:'leased', lease_token:leaseToken, fencing_token:fencingToken,
      lease_owner:workerId || null, lease_expires_at_utc_msc:now + Math.max(1_000, Number(leaseMs) || 120_000),
      attempt_count:Number(rows[0].attempt_count || 0) + 1 }
  })
}

export async function claimModelTaskById(taskId, { leaseMs = 120_000, workerId = null } = {}) {
  return withTransaction(async run => {
    const now = Date.now()
    const [rows] = await run(`SELECT * FROM ai_model_tasks WHERE task_id = ? FOR UPDATE`, [taskId])
    const task = rows[0]
    if (!task || !['queued', 'retry_wait'].includes(task.status)
      || Number(task.scheduled_at_utc_msc) > now
      || (Number(task.lease_expires_at_utc_msc) > now && task.lease_token)) return null
    const leaseToken = crypto.randomUUID()
    const fencingToken = Number(task.fencing_token || 0) + 1
    const expiresAt = now + Math.max(1_000, Number(leaseMs) || 120_000)
    await run(`UPDATE ai_model_tasks SET status = 'leased', lease_token = ?, fencing_token = ?,
      lease_owner = ?, lease_expires_at_utc_msc = ?, last_activity_at_utc_msc = ?,
      attempt_count = attempt_count + 1, updated_at_utc_msc = ? WHERE task_id = ?`,
    [leaseToken, fencingToken, workerId || null, expiresAt, now, now, taskId])
    await appendModelTaskEvent(taskId, 'task_leased', { worker_id:workerId, fencing_token:fencingToken }, null, run)
    return { ...task, status:'leased', lease_token:leaseToken, fencing_token:fencingToken,
      lease_owner:workerId || null, lease_expires_at_utc_msc:expiresAt,
      attempt_count:Number(task.attempt_count || 0) + 1 }
  })
}

export async function renewModelTaskLease(task, leaseMs = 120_000) {
  const now = Date.now()
  const result = await queryRun(`UPDATE ai_model_tasks SET lease_expires_at_utc_msc = ?,
    last_activity_at_utc_msc = ?, updated_at_utc_msc = ?
    WHERE task_id = ? AND lease_token = ? AND fencing_token = ?
      AND status NOT IN ('cancelled','failed_terminal','succeeded','completed_stale','completed_rejected')`,
  [now + Math.max(1_000, Number(leaseMs) || 120_000), now, now,
    task.task_id, task.lease_token, Number(task.fencing_token)])
  return Number(result?.affectedRows ?? result?.changes ?? 0) === 1
}

export async function persistModelTaskBudget(task, budget = {}) {
  const now = Date.now()
  const estimatedInputTokens = Math.max(0, Math.trunc(Number(budget.estimatedInputTokens) || 0))
  const selectedOutputBudget = Math.max(0, Math.trunc(Number(budget.selectedMaxOutputTokens) || 0))
  if (!selectedOutputBudget) throw new Error('model_task_budget_invalid')
  const schemaNeedTokens = Math.max(0, Math.trunc(Number(budget.schemaNeedTokens) || 0))
  const contextWindowTokens = Number(budget.contextWindowTokens) > 0
    ? Math.trunc(Number(budget.contextWindowTokens)) : null
  const providerOutputCap = Number(budget.providerOutputCap) > 0
    ? Math.trunc(Number(budget.providerOutputCap)) : null
  const result = await queryRun(`UPDATE ai_model_tasks SET estimated_input_tokens = ?,
    selected_output_budget = ?, schema_need_tokens = ?, context_window_tokens = ?,
    provider_output_cap = ?, last_activity_at_utc_msc = ?, updated_at_utc_msc = ?
    WHERE task_id = ? AND lease_token = ? AND fencing_token = ?
      AND status = 'preparing'`,
  [estimatedInputTokens, selectedOutputBudget, schemaNeedTokens, contextWindowTokens,
    providerOutputCap, now, now, task.task_id, task.lease_token, Number(task.fencing_token)])
  if (Number(result?.affectedRows ?? result?.changes ?? 0) !== 1) throw new Error('model_task_fence_lost')
  const persisted = {
    estimatedInputTokens,
    selectedMaxOutputTokens:selectedOutputBudget,
    schemaNeedTokens,
    contextWindowTokens,
    providerOutputCap,
  }
  await appendModelTaskEvent(task.task_id, 'budget_persisted', persisted)
  return { ...task, ...persisted }
}

export async function transitionModelTask(task, toStatus, patch = {}) {
  assertModelTaskTransition(task.status, toStatus)
  const now = Date.now()
  const terminal = MODEL_TASK_TERMINAL_STATES.has(toStatus)
  const result = await queryRun(`UPDATE ai_model_tasks SET status = ?, error_code = COALESCE(?, error_code),
    error_message = COALESCE(?, error_message), result_ref = COALESCE(?, result_ref),
    result_hash = COALESCE(?, result_hash), finish_reason = COALESCE(?, finish_reason),
    incomplete_details_json = COALESCE(?, incomplete_details_json), last_activity_at_utc_msc = ?,
    completed_at_utc_msc = ${terminal ? '?' : 'completed_at_utc_msc'},
    lease_token = ${terminal ? 'NULL' : 'lease_token'},
    lease_expires_at_utc_msc = ${terminal ? 'NULL' : 'lease_expires_at_utc_msc'}, updated_at_utc_msc = ?
    WHERE task_id = ? AND lease_token = ? AND fencing_token = ? AND status = ?`,
  [toStatus, patch.errorCode || null, patch.errorMessage || null, patch.resultRef || null,
    patch.resultHash || null, patch.finishReason || null, json(patch.incompleteDetails), now,
    ...(terminal ? [now] : []), now, task.task_id, task.lease_token, Number(task.fencing_token), task.status])
  if (Number(result?.affectedRows ?? result?.changes ?? 0) !== 1) throw new Error('model_task_fence_lost')
  await appendModelTaskEvent(task.task_id, 'status_changed', { from:task.status, to:toStatus, ...patch })
  return { ...task, ...patch, status:toStatus, completed_at_utc_msc:terminal ? now : task.completed_at_utc_msc }
}

export async function beginModelTaskAttempt(task, input = {}) {
  const now = Date.now()
  const attemptNo = Math.max(1, Number(input.attemptNo) || Number(task.attempt_count) || 1)
  const result = await queryRun(`INSERT INTO ai_model_task_attempts
    (task_id, attempt_no, fencing_token, provider_request_id, provider_idempotency_key,
     status, request_started_at_utc_msc, last_activity_at_utc_msc, created_at_utc_msc, updated_at_utc_msc)
    VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?)`,
  [task.task_id, attemptNo, Number(task.fencing_token), input.providerRequestId || null,
    input.providerIdempotencyKey || null, now, now, now, now])
  await appendModelTaskEvent(task.task_id, 'attempt_started', { attempt_no:attemptNo }, result.insertId)
  return { id:result.insertId, task_id:task.task_id, attempt_no:attemptNo,
    fencing_token:Number(task.fencing_token), status:'submitted' }
}

export async function finishModelTaskAttempt(task, attempt, patch = {}) {
  const now = Date.now()
  const result = await queryRun(`UPDATE ai_model_task_attempts SET status = ?, provider_request_id = COALESCE(?, provider_request_id),
    response_received_at_utc_msc = ?, last_activity_at_utc_msc = ?, input_tokens = ?, output_tokens = ?,
    reasoning_tokens = ?, cached_tokens = ?, total_tokens = ?, finish_reason = ?, incomplete_details_json = ?,
    request_bytes = ?, response_bytes = ?, http_status = ?, error_code = ?, error_message = ?, updated_at_utc_msc = ?
    WHERE id = ? AND task_id = ? AND fencing_token = ?`,
  [patch.status || 'succeeded', patch.providerRequestId || null, now, now,
    Number(patch.inputTokens) || 0, Number(patch.outputTokens) || 0, Number(patch.reasoningTokens) || 0,
    Number(patch.cachedTokens) || 0, Number(patch.totalTokens) || 0, patch.finishReason || null,
    json(patch.incompleteDetails), Math.max(0, Number(patch.requestBytes) || 0),
    Math.max(0, Number(patch.responseBytes) || 0), Number(patch.httpStatus) || null, patch.errorCode || null,
    patch.errorMessage || null, now, attempt.id, task.task_id, Number(task.fencing_token)])
  if (Number(result?.affectedRows ?? result?.changes ?? 0) !== 1) throw new Error('model_task_attempt_fence_lost')
  await appendModelTaskEvent(task.task_id, 'attempt_finished', patch, attempt.id)
}

export async function listRecoverableModelTasks(limit = 100) {
  return queryAll(`SELECT * FROM ai_model_tasks WHERE status IN
    ('leased','preparing','submitted','provider_running','provider_quiet','status_unknown','reconciling',
     'response_received','validating','repairing','retry_wait','result_ready','applying')
    ORDER BY updated_at_utc_msc LIMIT ?`, [Math.max(1, Math.min(1000, Number(limit) || 100))])
}

// Explicit user cancellation is allowed without borrowing a worker lease. A
// stale worker is fenced by the status predicate and can no longer transition
// or apply a result after this update.
export async function cancelModelTaskById(taskId, reason = 'model_task_cancelled') {
  const now = Date.now()
  const result = await queryRun(`UPDATE ai_model_tasks SET status='cancelled',
    error_code=?, error_message=?, completed_at_utc_msc=?,
    lease_token=NULL, lease_owner=NULL, lease_expires_at_utc_msc=NULL, updated_at_utc_msc=?
    WHERE task_id=? AND status NOT IN ('cancelled','failed_terminal','succeeded','completed_stale','completed_rejected')`,
  [String(reason).slice(0, 128), String(reason).slice(0, 512), now, now, String(taskId)])
  if (Number(result?.affectedRows ?? result?.changes ?? 0) > 0) {
    await appendModelTaskEvent(String(taskId), 'task_cancelled', { reason })
    return true
  }
  return false
}

function recoveryWhere({ taskId = '', expectedStatus = null, fencingToken = null, nowUtcMs = null,
  requireLeaseExpired = false, requireDeadlineReached = false, requireDeadlineNotReached = false,
  requireLeaseOrDeadline = false } = {}) {
  const clauses = ['task_id = ?']
  const params = [String(taskId)]
  if (expectedStatus) { clauses.push('status = ?'); params.push(String(expectedStatus)) }
  if (fencingToken != null) { clauses.push('fencing_token = ?'); params.push(Number(fencingToken)) }
  const now = Number(nowUtcMs) || Date.now()
  const leaseExpired = '(lease_expires_at_utc_msc IS NULL OR lease_expires_at_utc_msc <= ?)'
  const deadlineReached = '(task_deadline_at_utc_msc IS NOT NULL AND task_deadline_at_utc_msc > 0 AND task_deadline_at_utc_msc <= ?)'
  if (requireLeaseOrDeadline) {
    clauses.push(`(${leaseExpired} OR ${deadlineReached})`)
    params.push(now, now)
  } else {
    if (requireLeaseExpired) { clauses.push(leaseExpired); params.push(now) }
    if (requireDeadlineReached) { clauses.push(deadlineReached); params.push(now) }
    if (requireDeadlineNotReached) {
      clauses.push('(task_deadline_at_utc_msc IS NULL OR task_deadline_at_utc_msc <= 0 OR task_deadline_at_utc_msc > ?)')
      params.push(now)
    }
  }
  return { sql:clauses.join(' AND '), params }
}

export async function markModelTaskStatusUnknownById(taskId, reason = 'provider_status_unknown', guard = {}) {
  const now = Date.now()
  const where = recoveryWhere({ ...guard, taskId })
  const result = await queryRun(`UPDATE ai_model_tasks SET status='status_unknown',
    error_code=?, error_message=?, lease_token=NULL, lease_owner=NULL, lease_expires_at_utc_msc=NULL,
    updated_at_utc_msc=? WHERE ${where.sql} AND status IN ('leased','preparing','submitted','provider_running','provider_quiet')`,
  [String(reason).slice(0, 128), String(reason).slice(0, 512), now, ...where.params])
  if (Number(result?.affectedRows ?? result?.changes ?? 0) > 0) {
    await appendModelTaskEvent(String(taskId), 'task_status_unknown', { reason })
    return true
  }
  return false
}

// Reconciliation may discover a durable domain result after the worker lease
// disappeared (for example, the process died immediately after ai_signals
// committed). The result row is the proof that applying already completed, so
// finish the envelope without allowing a stale worker to write any new data.
export async function markModelTaskSucceededFromResult(taskId, { resultRef = null, resultHash = null } = {}) {
  const now = Date.now()
  const result = await queryRun(`UPDATE ai_model_tasks SET status='succeeded',
    result_ref=COALESCE(?, result_ref), result_hash=COALESCE(?, result_hash),
    error_code=NULL, error_message=NULL, completed_at_utc_msc=?,
    lease_token=NULL, lease_owner=NULL, lease_expires_at_utc_msc=NULL,
    last_activity_at_utc_msc=?, updated_at_utc_msc=?
    WHERE task_id=? AND status NOT IN ('cancelled','failed_terminal','succeeded','completed_stale','completed_rejected')`,
  [resultRef, resultHash, now, now, now, String(taskId)])
  if (Number(result?.affectedRows ?? result?.changes ?? 0) > 0) {
    await appendModelTaskEvent(String(taskId), 'task_reconciled_from_result', { result_ref:resultRef })
    return true
  }
  return false
}

// Source fingerprints are checked immediately before apply. If they changed,
// the model output must never be applied even when the ordinary leased state
// machine cannot transition directly from its current intermediate state.
export async function markModelTaskCompletedStaleById(taskId, reason = 'model_task_source_stale', guard = {}) {
  const now = Date.now()
  const where = recoveryWhere({ ...guard, taskId })
  const result = await queryRun(`UPDATE ai_model_tasks SET status='completed_stale',
    error_code=?, error_message=?, completed_at_utc_msc=?,
    lease_token=NULL, lease_owner=NULL, lease_expires_at_utc_msc=NULL,
    last_activity_at_utc_msc=?, updated_at_utc_msc=?
    WHERE ${where.sql} AND status NOT IN ('cancelled','failed_terminal','succeeded','completed_stale','completed_rejected')`,
  [String(reason).slice(0, 128), String(reason).slice(0, 512), now, now, now, ...where.params])
  if (Number(result?.affectedRows ?? result?.changes ?? 0) > 0) {
    await appendModelTaskEvent(String(taskId), 'task_completed_stale', { reason })
    return true
  }
  return false
}

// A leased model task may be returned to the queue only when there is durable
// proof that no provider attempt was started. This path is intentionally
// separate from the normal transition graph because `preparing` has no safe
// in-process predecessor after a worker restart.
export async function requeueAbandonedModelTaskById(taskId, reason = 'model_task_worker_abandoned', guard = {}) {
  const now = Date.now()
  const where = recoveryWhere({ ...guard, taskId })
  const result = await queryRun(`UPDATE ai_model_tasks SET status='queued',
    error_code=NULL, error_message=NULL, lease_token=NULL, lease_owner=NULL,
    lease_expires_at_utc_msc=NULL, fencing_token=fencing_token + 1,
    last_activity_at_utc_msc=?, updated_at_utc_msc=?
    WHERE ${where.sql} AND status IN ('leased','preparing')
      AND NOT EXISTS (SELECT 1 FROM ai_model_task_attempts attempts WHERE attempts.task_id = ai_model_tasks.task_id)`,
  [now, now, ...where.params])
  if (Number(result?.affectedRows ?? result?.changes ?? 0) > 0) {
    await appendModelTaskEvent(String(taskId), 'task_requeued_after_recovery', { reason })
    return true
  }
  return false
}

const BUSINESS_RECOVERY_ACTIVE_STATES = Object.freeze([
  'leased', 'preparing', 'submitted', 'provider_running', 'provider_quiet',
  'status_unknown', 'reconciling', 'response_received', 'validating', 'repairing',
  'result_ready', 'applying',
])

/**
 * Recover model tasks linked to a durable business job. The business module
 * supplies an inspection callback so a model task is reconciled only after a
 * persisted domain result is found. Unknown provider requests are never
 * requeued; they remain blocked until their frozen deadline, then become
 * completed_stale.
 */
export async function recoverAbandonedBusinessModelTasks({
  taskKinds = null,
  nowUtcMs = Date.now(),
  limit = 500,
  inspectBusiness = null,
  onBusinessTransition = null,
} = {}) {
  const kinds = Array.isArray(taskKinds)
    ? [...new Set(taskKinds.map(value => String(value || '').trim()).filter(Boolean))]
    : []
  const kindClause = kinds.length ? ` AND tasks.task_kind IN (${kinds.map(() => '?').join(',')})` : ''
  const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 500))
  const tasks = await queryAll(`SELECT tasks.*,
      EXISTS (SELECT 1 FROM ai_model_task_attempts attempts WHERE attempts.task_id = tasks.task_id) AS provider_attempt_started
    FROM ai_model_tasks tasks
    WHERE tasks.status IN (${BUSINESS_RECOVERY_ACTIVE_STATES.map(() => '?').join(',')})${kindClause}
    ORDER BY tasks.updated_at_utc_msc LIMIT ?`, [...BUSINESS_RECOVERY_ACTIVE_STATES, ...kinds, boundedLimit])
  const result = {
    scanned:tasks.length, succeeded:0, requeued:0, statusUnknown:0, stale:0, active:0, errors:0,
  }
  const now = Number(nowUtcMs) || Date.now()

  for (const task of tasks) {
    let business = null
    try {
      business = typeof inspectBusiness === 'function' ? await inspectBusiness(task) : null
    } catch (error) {
      result.errors += 1
      console.error(`[ModelTaskRecovery task=${task.task_id}] business inspection failed:`, error.message)
      continue
    }

    if (business?.succeeded === true) {
      if (await markModelTaskSucceededFromResult(task.task_id, {
        resultRef:business.resultRef || null, resultHash:business.resultHash || null,
      })) result.succeeded += 1
      continue
    }

    const leaseExpiresAt = Number(task.lease_expires_at_utc_msc)
    const leaseExpired = !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now
    const deadlineAt = Number(task.task_deadline_at_utc_msc)
    const deadlineReached = Number.isFinite(deadlineAt) && deadlineAt > 0 && deadlineAt <= now
    if (!leaseExpired && !deadlineReached) {
      result.active += 1
      continue
    }

    const status = String(task.status || '')
    if (status === 'status_unknown') {
      if (deadlineReached) {
        if (await markModelTaskCompletedStaleById(task.task_id, 'model_task_status_unknown_deadline_expired', {
          expectedStatus:status, fencingToken:Number(task.fencing_token || 0), nowUtcMs:now, requireDeadlineReached:true,
        })) {
          result.stale += 1
          await onBusinessTransition?.({ action:'stale', task, business, reason:'model_task_status_unknown_deadline_expired' })
        }
      } else {
        result.statusUnknown += 1
        await onBusinessTransition?.({ action:'status_unknown', task, business, reason:'model_task_status_unknown' })
      }
      continue
    }

    if (['leased', 'preparing'].includes(status) && leaseExpired && !deadlineReached
      && Number(task.provider_attempt_started) === 0) {
      if (await requeueAbandonedModelTaskById(task.task_id, 'model_task_worker_abandoned_before_provider', {
        expectedStatus:status, fencingToken:Number(task.fencing_token || 0), nowUtcMs:now,
        requireLeaseExpired:true, requireDeadlineNotReached:true,
      })) {
        result.requeued += 1
        await onBusinessTransition?.({ action:'requeued', task, business, reason:'model_task_worker_abandoned_before_provider' })
      }
      continue
    }

    if (((['leased', 'preparing'].includes(status) && Number(task.provider_attempt_started) > 0)
      || ['submitted', 'provider_running', 'provider_quiet'].includes(status)) && leaseExpired && !deadlineReached) {
      if (await markModelTaskStatusUnknownById(task.task_id, 'provider_status_unknown_after_recovery', {
        expectedStatus:status, fencingToken:Number(task.fencing_token || 0), nowUtcMs:now,
        requireLeaseExpired:true, requireDeadlineNotReached:true,
      })) {
        result.statusUnknown += 1
        await onBusinessTransition?.({ action:'status_unknown', task, business, reason:'provider_status_unknown_after_recovery' })
      }
      continue
    }

    // Once a request reached a response/application stage without a durable
    // business result, replay is unsafe. Finalize the envelope as stale and
    // let the business job record a visible failed recovery outcome.
    const staleReason = deadlineReached
      ? 'model_task_deadline_expired_without_business_result'
      : 'model_task_intermediate_result_missing'
    if (await markModelTaskCompletedStaleById(task.task_id, staleReason, {
      expectedStatus:status, fencingToken:Number(task.fencing_token || 0), nowUtcMs:now, requireLeaseOrDeadline:true,
    })) {
      result.stale += 1
      await onBusinessTransition?.({ action:'stale', task, business, reason:staleReason })
    }
  }
  return result
}

// Auto inference cannot be replayed after a process restart because its frozen
// market/account snapshot may already be stale and most synchronous providers
// cannot prove whether an interrupted request was accepted. Reconcile the
// durable envelope before schedulers start so a Redis lease loss never turns
// into a blind duplicate model request.
export async function recoverAbandonedAutoInferenceTasks({ nowUtcMs = Date.now(), limit = 500 } = {}) {
  const now = Number(nowUtcMs) || Date.now()
  const tasks = await queryAll(`SELECT * FROM ai_model_tasks
    WHERE task_kind = 'auto_inference'
      AND status NOT IN ('cancelled','failed_terminal','succeeded','completed_stale','completed_rejected')
    ORDER BY updated_at_utc_msc LIMIT ?`, [Math.max(1, Math.min(1000, Number(limit) || 500))])
  const result = { scanned:tasks.length, succeeded:0, statusUnknown:0, stale:0, active:0 }
  for (const task of tasks) {
    const applied = await queryOne('SELECT id FROM ai_signals WHERE inference_task_id = ? LIMIT 1', [task.task_id])
    if (applied?.id) {
      if (await markModelTaskSucceededFromResult(task.task_id, { resultRef:`ai_signals:${applied.id}` })) result.succeeded += 1
      continue
    }
    const leaseExpired = !Number(task.lease_expires_at_utc_msc) || Number(task.lease_expires_at_utc_msc) <= now
    const deadlineExpired = Number(task.task_deadline_at_utc_msc) > 0 && Number(task.task_deadline_at_utc_msc) <= now
    if (!leaseExpired && !deadlineExpired) {
      result.active += 1
      continue
    }
    if (['submitted','provider_running','provider_quiet'].includes(task.status) && !deadlineExpired) {
      if (await markModelTaskStatusUnknownById(task.task_id, 'auto_inference_provider_status_unknown_after_restart', {
        expectedStatus:String(task.status), fencingToken:Number(task.fencing_token || 0), nowUtcMs:now,
        requireLeaseExpired:true, requireDeadlineNotReached:true,
      })) {
        result.statusUnknown += 1
      }
      continue
    }
    if (task.status === 'status_unknown' && !deadlineExpired) {
      result.statusUnknown += 1
      continue
    }
    if (await markModelTaskCompletedStaleById(task.task_id,
      deadlineExpired ? 'auto_inference_task_deadline_expired' : 'auto_inference_worker_abandoned', {
        expectedStatus:String(task.status), fencingToken:Number(task.fencing_token || 0), nowUtcMs:now,
        requireLeaseOrDeadline:true,
      })) {
      result.stale += 1
    }
  }
  return result
}
