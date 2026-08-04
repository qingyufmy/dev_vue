import * as modelTaskRuntime from './model-task-runtime.js'
import { classifyModelProviderError } from './model-provider-adapters.js'

const { beginModelTaskAttempt, claimModelTaskById, createModelTask, finishModelTaskAttempt,
  persistModelTaskBudget, renewModelTaskLease, transitionModelTask } = modelTaskRuntime

const CLAIMABLE_STATUSES = new Set(['queued', 'retry_wait'])
const TERMINAL_STATUSES = new Set(['cancelled', 'failed_terminal', 'succeeded', 'completed_stale', 'completed_rejected'])
const ACTIVE_STATUSES = new Set([
  'leased', 'preparing', 'submitted', 'provider_running', 'provider_quiet', 'status_unknown',
  'reconciling', 'response_received', 'validating', 'repairing', 'result_ready', 'applying',
])

function trackerError(code, detail = '') {
  const error = new Error(detail ? `${code}:${detail}` : code)
  error.code = code
  return error
}

function affectedRows(value) {
  if (typeof value === 'number') return value
  if (!value || typeof value !== 'object') return null
  const candidate = value.affectedRows ?? value.changes
  return candidate == null ? null : Number(candidate)
}

function assertLinkResult(value) {
  // Link callbacks may return a boolean acknowledgement, a database result,
  // or nothing. A rejected callback always propagates; explicit false/zero
  // results are treated as a failed durable association.
  if (value === false) throw trackerError('model_task_link_failed')
  const rows = affectedRows(value)
  if (rows != null && rows < 1) throw trackerError('model_task_link_failed')
}

function classifyExistingTask(task) {
  const status = String(task?.status || '')
  if (CLAIMABLE_STATUSES.has(status)) return
  if (ACTIVE_STATUSES.has(status)) throw trackerError('model_task_duplicate_active', status)
  if (TERMINAL_STATUSES.has(status)) throw trackerError('model_task_duplicate_terminal', status)
  throw trackerError('model_task_not_claimable', status || 'missing_status')
}

function taskError(error, fallback = 'model_task_tracker_failed') {
  if (error instanceof Error) return error
  return trackerError(fallback, String(error || fallback))
}

/**
 * Create the authoritative runtime envelope around one provider invocation.
 *
 * Initialization is intentionally strict. An existing idempotent task may be
 * claimed only while it is still queued/retry_wait; an active or terminal task
 * is never treated as a new provider attempt.
 */
export async function createModelTaskTracker(input, {
  linkTask = null,
  workerId = null,
  leaseMs = 120_000,
  renewIntervalMs = 30_000,
} = {}) {
  const createdResult = await createModelTask(input)
  const taskFromCreate = createdResult?.task
  if (!taskFromCreate) throw trackerError('model_task_create_failed')
  if (!createdResult.created) classifyExistingTask(taskFromCreate)

  if (typeof linkTask === 'function') {
    const linked = await linkTask(taskFromCreate.task_id)
    assertLinkResult(linked)
  }

  let task = await claimModelTaskById(taskFromCreate.task_id, {
    leaseMs,
    workerId:workerId || `model-task:${process.pid}`,
  })
  if (!task) throw trackerError('model_task_not_claimable', String(taskFromCreate.status || 'unknown'))

  task = await transitionModelTask(task, 'preparing')
  let attempt = null
  let providerAttemptSequence = 0
  // Keep the last provider attempt outcome in memory while the durable
  // attempt row remains the source of truth.  A failed fetch can leave no
  // response to inspect, so the request id/status captured by the usage
  // callback are needed when deciding whether another request is safe.
  let providerAttemptState = {
    submitted:false,
    responseReceived:false,
    providerRequestId:null,
    httpStatus:null,
  }
  let lastPersistedActivityAtUtcMs = 0
  let firstBytePersisted = false
  const ACTIVITY_PERSIST_INTERVAL_MS = 5_000
  let stopped = false
  let fatalError = null
  let tail = Promise.resolve()
  let renewTimer = null
  const controller = new AbortController()

  const rememberFailure = error => {
    const normalized = taskError(error)
    if (!fatalError) fatalError = normalized
    if (!controller.signal.aborted) controller.abort(fatalError)
    if (renewTimer) clearInterval(renewTimer)
    return fatalError
  }

  const assertOwned = () => {
    if (fatalError) throw fatalError
    if (stopped) throw trackerError('model_task_tracker_stopped')
    controller.signal.throwIfAborted()
  }

  const assertOwnedTx = async run => {
    assertOwned()
    if (typeof run !== 'function') throw trackerError('model_task_transaction_runner_missing')
    try {
      const result = await run(`SELECT task_id, status, lease_token, fencing_token, lease_expires_at_utc_msc,
          result_valid_until_utc_msc
        FROM ai_model_tasks WHERE task_id = ? FOR UPDATE`, [task.task_id])
      const rows = Array.isArray(result?.[0]) ? result[0] : (Array.isArray(result) ? result : [])
      const current = rows[0]
      const hasLeaseExpiry = current && Object.prototype.hasOwnProperty.call(current, 'lease_expires_at_utc_msc')
      const leaseExpired = hasLeaseExpiry
        && (!Number.isFinite(Number(current.lease_expires_at_utc_msc)) || Number(current.lease_expires_at_utc_msc) <= Date.now())
      if (!current || TERMINAL_STATUSES.has(String(current.status || ''))
        || String(current.lease_token || '') !== String(task.lease_token || '')
        || Number(current.fencing_token) !== Number(task.fencing_token)
        || leaseExpired
        || !ACTIVE_STATUSES.has(String(current.status || ''))) {
        throw trackerError('model_task_fence_lost')
      }
      return current
    } catch (error) {
      throw rememberFailure(error)
    }
  }

  const enqueue = operation => {
    const current = tail.then(async () => {
      assertOwned()
      try {
        const result = await operation()
        // stop() intentionally waits for the already queued operation. Do not
        // turn a successful in-flight operation into a synthetic failure just
        // because stopping began while it was completing.
        if (fatalError) throw fatalError
        return result
      } catch (error) {
        throw rememberFailure(error)
      }
    })
    // Keep the queue usable for stop/assertOwned while preserving the error
    // for the caller that owns this operation.
    tail = current.catch(error => {
      rememberFailure(error)
    })
    return current
  }

  const renewOnce = () => enqueue(async () => {
    const renewed = await renewModelTaskLease(task, leaseMs)
    if (!renewed) throw trackerError('model_task_lease_lost')
    return true
  })

  const statusTransition = (toStatus, patch = {}) => enqueue(async () => {
    task = await transitionModelTask(task, toStatus, patch)
    return task
  })

  renewTimer = setInterval(() => {
    void renewOnce().catch(error => {
      console.error(`[ModelTask] lease renewal failed for ${task.task_id}:`, error.message)
    })
  }, Math.max(1, Number(renewIntervalMs) || 30_000))
  renewTimer.unref?.()

  const transitionToResultReady = patch => enqueue(async () => {
    if (task.status === 'submitted') task = await transitionModelTask(task, 'response_received')
    if (task.status === 'response_received') task = await transitionModelTask(task, 'validating')
    if (task.status === 'validating') task = await transitionModelTask(task, 'result_ready', patch)
    if (task.status !== 'result_ready') throw trackerError('model_task_result_not_ready', task.status)
    return task
  })

  const transitionToTerminal = (toStatus, reason = null) => enqueue(async () => {
    if (!['completed_stale', 'completed_rejected'].includes(toStatus)) {
      throw trackerError('model_task_terminal_status_invalid', toStatus)
    }
    const patch = reason == null ? {} : {
      errorCode:String(reason?.code || reason || toStatus).slice(0, 128),
      errorMessage:String(reason?.message || reason || toStatus).slice(0, 512),
    }
    const allowed = toStatus === 'completed_stale'
      ? ['status_unknown', 'result_ready', 'applying']
      : ['validating', 'result_ready', 'applying']
    if (allowed.includes(task.status)) {
      task = await transitionModelTask(task, toStatus, patch)
      return task
    }
    throw trackerError('model_task_terminal_transition_invalid', `${task.status}:${toStatus}`)
  })

  return {
    get active() { return !stopped && !fatalError },
    get status() { return task.status },
    get task() { return { ...task } },
    get providerRequestState() { return { ...providerAttemptState } },
    taskId:task.task_id,
    signal:controller.signal,
    assertOwned,
    assertOwnedTx,
    persistBudget:budget => enqueue(async () => {
      task = await persistModelTaskBudget(task, budget)
      return task
    }),
    renewNow:renewOnce,
    onProviderRequest:event => enqueue(async () => {
      if (task.status === 'response_received') task = await transitionModelTask(task, 'validating')
      if (task.status === 'validating') task = await transitionModelTask(task, 'repairing')
      if (task.status === 'repairing') task = await transitionModelTask(task, 'submitted')
      if (task.status === 'preparing') task = await transitionModelTask(task, 'submitted')
      if (task.status !== 'submitted') throw trackerError('model_task_provider_request_invalid', task.status)
      providerAttemptState = {
        submitted:true,
        responseReceived:false,
        providerRequestId:event?.providerRequestId || null,
        httpStatus:null,
      }
      lastPersistedActivityAtUtcMs = 0
      firstBytePersisted = false
      if (!attempt) {
        attempt = await beginModelTaskAttempt(task, {
          attemptNo:(Math.max(1, Number(task.attempt_count)) - 1) * 10 + (++providerAttemptSequence),
          providerRequestId:event?.providerRequestId || null,
        })
      }
      return attempt
    }),
    onProviderActivity:event => enqueue(async () => {
      if (task.status === 'submitted' || task.status === 'provider_quiet') {
        task = await transitionModelTask(task, 'provider_running')
      }
      if (task.status !== 'provider_running' && task.status !== 'response_received') {
        throw trackerError('model_task_provider_activity_invalid', task.status)
      }
      providerAttemptState = {
        ...providerAttemptState,
        submitted:true,
        providerRequestId:event?.providerRequestId || providerAttemptState.providerRequestId || null,
      }
      const activityNow = Date.now()
      const firstByte = event?.firstByte === true
      const shouldPersist = (firstByte && !firstBytePersisted) || !lastPersistedActivityAtUtcMs
        || activityNow - lastPersistedActivityAtUtcMs >= ACTIVITY_PERSIST_INTERVAL_MS
      const touchActivity = Object.prototype.hasOwnProperty.call(modelTaskRuntime, 'touchModelTaskActivity')
        ? modelTaskRuntime.touchModelTaskActivity : null
      if (shouldPersist && typeof touchActivity === 'function') {
        await touchActivity(task, attempt, {
          firstByte, lastActivityAtUtcMs:activityNow,
        })
        lastPersistedActivityAtUtcMs = activityNow
        firstBytePersisted = firstBytePersisted || firstByte
      }
      return true
    }),
    onProviderQuiet:event => enqueue(async () => {
      if (task.status === 'submitted' || task.status === 'provider_running') {
        task = await transitionModelTask(task, 'provider_quiet')
      }
      if (task.status !== 'provider_quiet') throw trackerError('model_task_provider_quiet_invalid', task.status)
      providerAttemptState = {
        ...providerAttemptState,
        submitted:true,
        providerRequestId:event?.providerRequestId || providerAttemptState.providerRequestId || null,
      }
      return true
    }),
    onProviderUsage:event => enqueue(async () => {
      if (!attempt) throw trackerError('model_task_attempt_missing')
      const httpStatus = Number(event?.httpStatus)
      const hasHttpStatus = Number.isFinite(httpStatus) && httpStatus > 0
      const hasExplicitResponseReceived = Object.prototype.hasOwnProperty.call(event || {}, 'responseReceived')
      const responseReceived = event?.responseReceived === true
        || (!hasExplicitResponseReceived && (event?.status === 'success'
          || (hasHttpStatus && httpStatus >= 200)))
      providerAttemptState = {
        submitted:true,
        responseReceived,
        providerRequestId:event?.providerRequestId || providerAttemptState.providerRequestId || null,
        httpStatus:hasHttpStatus ? httpStatus : providerAttemptState.httpStatus,
      }
      await finishModelTaskAttempt(task, attempt, {
        status:event?.status === 'success' ? 'succeeded' : 'failed',
        providerRequestId:event?.providerRequestId,
        httpStatus:hasHttpStatus ? httpStatus : undefined,
        inputTokens:event?.inputTokens, outputTokens:event?.outputTokens,
        reasoningTokens:event?.reasoningTokens, cachedTokens:event?.cachedTokens,
        totalTokens:event?.totalTokens || event?.tokenCount,
        requestBytes:event?.requestBytes, responseBytes:event?.responseBytes,
        finishReason:event?.finishReason, incompleteDetails:event?.incompleteDetails,
        errorCode:event?.errorCode,
      })
      attempt = null
      if (event?.status === 'success' && ['submitted', 'provider_running', 'provider_quiet'].includes(task.status)) {
        task = await transitionModelTask(task, 'response_received', {
          finishReason:event?.finishReason, incompleteDetails:event?.incompleteDetails,
        })
      }
      return true
    }),
    resultReady:transitionToResultReady,
    applying:() => statusTransition('applying'),
    succeeded:patch => statusTransition('succeeded', patch),
    completedStale:reason => transitionToTerminal('completed_stale', reason),
    completedRejected:reason => transitionToTerminal('completed_rejected', reason),
    failed:(error, exhausted = false) => enqueue(async () => {
      // Once a validated result reached result_ready/applying, retry_wait would
      // require replaying an output that is no longer durably stored in the
      // generic envelope. Fail that attempt terminally instead of performing
      // an invalid transition or silently issuing a second provider request.
      const status = String(task.status || '')
      const responseStatus = Number(providerAttemptState.httpStatus)
      const successfulResponse = providerAttemptState.responseReceived
        && (!Number.isFinite(responseStatus) || responseStatus < 400)
      const responseValidationFailure = successfulResponse
        || ['response_received', 'validating', 'repairing'].includes(status)

      // A complete provider response followed by schema/contract validation
      // failure is still a controlled retry.  It is fundamentally different
      // from a transport failure after submission, where replaying can issue
      // a second billable request with an unknown first result.
      let classification = null
      let target
      if (responseValidationFailure) {
        target = exhausted || ['result_ready', 'applying'].includes(status)
          ? 'failed_terminal' : 'retry_wait'
      } else {
        const providerStatus = Number(error?.providerStatus) > 0
          ? Number(error.providerStatus)
          : (Number.isFinite(responseStatus) && responseStatus >= 400 ? responseStatus : null)
        const classificationError = providerStatus == null || error?.providerStatus != null
          ? error
          : Object.assign(error instanceof Error ? error : new Error(String(error || 'model_task_failed')), { providerStatus })
        classification = classifyModelProviderError(classificationError, {
          requestSubmitted:providerAttemptState.submitted && !providerAttemptState.responseReceived,
          providerRequestId:error?.providerRequestId || providerAttemptState.providerRequestId || null,
        })
        if (classification.statusUnknown || classification.state === 'provider_quiet') {
          // Unknown/quiet is deliberately independent of `exhausted`: the
          // provider may still have accepted the request, so no retry budget
          // can make a duplicate request safe.
          target = classification.state
        } else if (classification.state === 'retry_wait') {
          target = exhausted ? 'failed_terminal' : 'retry_wait'
        } else {
          target = 'failed_terminal'
        }
      }

      if (['leased', 'preparing', 'submitted', 'provider_running', 'provider_quiet', 'status_unknown',
        'response_received', 'validating', 'repairing', 'result_ready', 'applying'].includes(status)
        && target !== 'status_unknown' && target !== 'provider_quiet') {
        task = await transitionModelTask(task, target, {
          errorCode:String(classification?.code || error?.code || error?.message || 'model_task_failed').slice(0, 128),
          errorMessage:String(error?.message || error || 'model_task_failed').slice(0, 512),
        })
        return task
      }
      if (['submitted', 'provider_running', 'provider_quiet'].includes(status)
        && ['status_unknown', 'provider_quiet'].includes(target)) {
        task = await transitionModelTask(task, target, {
          errorCode:String(classification?.code || error?.code || 'provider_status_unknown').slice(0, 128),
          errorMessage:String(error?.message || error || classification?.code || 'provider_status_unknown').slice(0, 512),
        })
        return task
      }
      throw trackerError('model_task_failure_transition_invalid', task.status)
    }),
    async stop() {
      stopped = true
      if (renewTimer) clearInterval(renewTimer)
      await tail.catch(error => {
        if (!fatalError) rememberFailure(error)
      })
      if (fatalError) throw fatalError
    },
  }
}
