// Durable provider/model-profile capacity reservations.
//
// Capacity is deliberately kept separate from the model-task callback queue.
// The database rows are the source of truth, which means two web processes
// cannot both spend the same provider slot simply because their local event
// loops are busy or paused.

import crypto from 'node:crypto'
import { queryAll, queryOne, queryRun, withTransaction } from '../../db.js'

export const MODEL_TASK_CAPACITY_QUEUE = Object.freeze({
  EXECUTION_CRITICAL: 'execution_critical',
  INTERACTIVE: 'interactive',
  BACKGROUND: 'background',
})

export const MODEL_TASK_CAPACITY_DEFAULTS = Object.freeze({
  maxConcurrency: 4,
  reserveExecutionCriticalSlots: 1,
  backgroundPerUserCap: 1,
  leaseMs: 120_000,
  conservativeLeaseMs: 300_000,
  waiterPollMs: 250,
  starvationAgeMs: 5_000,
})

const ACTIVE_LEASE_STATUS = 'active'
const WAITING_STATUS = 'waiting'
const MAX_WAITERS_TO_LOCK = 1000

function asPositiveInt(value, fallback, { min = 1, max = 2_147_483_647 } = {}) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < min) return fallback
  return Math.min(max, parsed)
}

function asNonNegativeInt(value, fallback, { max = 2_147_483_647 } = {}) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0) return fallback
  return Math.min(max, parsed)
}

function normalizePolicy(defaultRow = {}, profileRow = null) {
  const pick = (key, fallback) => {
    const profileValue = profileRow?.[key]
    return profileValue === null || profileValue === undefined || profileValue === ''
      ? (defaultRow?.[key] === null || defaultRow?.[key] === undefined || defaultRow?.[key] === '' ? fallback : defaultRow[key])
      : profileValue
  }
  const maxConcurrency = asPositiveInt(pick('max_concurrency', MODEL_TASK_CAPACITY_DEFAULTS.maxConcurrency), MODEL_TASK_CAPACITY_DEFAULTS.maxConcurrency)
  const reserveExecutionCriticalSlots = Math.min(
    maxConcurrency,
    asNonNegativeInt(pick('reserve_execution_critical_slots', MODEL_TASK_CAPACITY_DEFAULTS.reserveExecutionCriticalSlots), MODEL_TASK_CAPACITY_DEFAULTS.reserveExecutionCriticalSlots),
  )
  return {
    maxConcurrency,
    reserveExecutionCriticalSlots,
    backgroundPerUserCap: asNonNegativeInt(pick('background_per_user_cap', MODEL_TASK_CAPACITY_DEFAULTS.backgroundPerUserCap), MODEL_TASK_CAPACITY_DEFAULTS.backgroundPerUserCap),
    leaseMs: asPositiveInt(pick('lease_ms', MODEL_TASK_CAPACITY_DEFAULTS.leaseMs), MODEL_TASK_CAPACITY_DEFAULTS.leaseMs, { min:1_000, max:86_400_000 }),
    conservativeLeaseMs: asPositiveInt(pick('conservative_lease_ms', MODEL_TASK_CAPACITY_DEFAULTS.conservativeLeaseMs), MODEL_TASK_CAPACITY_DEFAULTS.conservativeLeaseMs, { min:1_000, max:86_400_000 }),
    waiterPollMs: asPositiveInt(pick('waiter_poll_ms', MODEL_TASK_CAPACITY_DEFAULTS.waiterPollMs), MODEL_TASK_CAPACITY_DEFAULTS.waiterPollMs, { min:25, max:5_000 }),
    starvationAgeMs: asPositiveInt(pick('starvation_age_ms', MODEL_TASK_CAPACITY_DEFAULTS.starvationAgeMs), MODEL_TASK_CAPACITY_DEFAULTS.starvationAgeMs, { min:250, max:86_400_000 }),
  }
}

/** Map model usage contexts to the admission queues. */
export function modelTaskCapacityQueue(usage) {
  const normalized = String(usage || '').trim().toLowerCase().replace(/-/g, '_')
  if (normalized === 'auto_platform' || normalized === 'auto_private') return MODEL_TASK_CAPACITY_QUEUE.EXECUTION_CRITICAL
  if (normalized === 'manual' || normalized === 'model_test' || normalized === 'modeltest') return MODEL_TASK_CAPACITY_QUEUE.INTERACTIVE
  if (normalized === 'review' || normalized === 'model_compare' || normalized === 'memory_compression') return MODEL_TASK_CAPACITY_QUEUE.BACKGROUND
  throw new Error(`model_capacity_usage_unknown:${normalized || 'empty'}`)
}

// Compatibility aliases make the queue contract easy to use from callers that
// describe this as a class rather than a queue.
export const resolveModelTaskCapacityQueue = modelTaskCapacityQueue
export const classifyModelTaskUsage = modelTaskCapacityQueue

function safeId(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function safeUserId(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function normalizeRequest(input = {}, options = {}) {
  const usage = String(input.usage || options.usage || '').trim().toLowerCase().replace(/-/g, '_')
  const queue = modelTaskCapacityQueue(usage)
  const profileId = safeId(input.profileId ?? input.modelProfileId ?? options.profileId)
  const userId = safeUserId(input.userId ?? options.userId)
  const modelTaskId = String(input.modelTaskId ?? input.taskId ?? options.modelTaskId ?? options.taskId ?? '').trim() || null
  const signal = options.signal || input.signal || null
  const deadlineAtMsValue = options.deadlineAtMs ?? input.deadlineAtMs ?? input.taskDeadlineAtUtcMs ?? input.taskDeadlineAtMs
  const deadlineAtMs = Number.isFinite(Number(deadlineAtMsValue)) && Number(deadlineAtMsValue) > 0
    ? Number(deadlineAtMsValue)
    : null
  return { usage, queue, profileId, userId, modelTaskId, signal, deadlineAtMs }
}

function capacityError(code, details = {}) {
  const error = new Error(code)
  error.code = code
  Object.assign(error, details)
  return error
}

function throwIfAborted(signal, deadlineAtMs) {
  signal?.throwIfAborted?.()
  if (deadlineAtMs && Date.now() >= deadlineAtMs) throw capacityError('model_capacity_deadline_exceeded')
}

function policyRowsFromQuery(rows) {
  const list = Array.isArray(rows) ? rows : []
  const defaultRow = list.find(row => String(row.policy_scope || row.scope || '').toLowerCase() === 'default'
    || Number(row.model_profile_id || 0) === 0) || null
  const profileRow = list.find(row => String(row.policy_scope || row.scope || '').toLowerCase() === 'profile'
    && Number(row.model_profile_id || 0) > 0) || null
  return { defaultRow, profileRow }
}

async function readPolicyRows(run, profileId, { lock = false } = {}) {
  const suffix = lock ? ' FOR UPDATE' : ''
  const [rows] = await run(`SELECT policy_scope, model_profile_id, max_concurrency,
      reserve_execution_critical_slots, background_per_user_cap, lease_ms,
      conservative_lease_ms, waiter_poll_ms, starvation_age_ms
    FROM ai_model_capacity_policies
    WHERE ((policy_scope = 'default' AND model_profile_id = 0)
       OR (policy_scope = 'profile' AND model_profile_id = ?))
      AND enabled = 1
    ORDER BY CASE WHEN policy_scope = 'default' THEN 0 ELSE 1 END${suffix}`, [profileId || 0])
  return policyRowsFromQuery(rows)
}

async function resolvePolicy(profileId) {
  // `undefined` is intentionally treated as an unavailable test adapter, not
  // as an implicit runtime policy. mysql2 returns null for a missing row.
  const rows = await queryAll(`SELECT policy_scope, model_profile_id, max_concurrency,
      reserve_execution_critical_slots, background_per_user_cap, lease_ms,
      conservative_lease_ms, waiter_poll_ms, starvation_age_ms
    FROM ai_model_capacity_policies
    WHERE ((policy_scope = 'default' AND model_profile_id = 0)
       OR (policy_scope = 'profile' AND model_profile_id = ?))
      AND enabled = 1
    ORDER BY CASE WHEN policy_scope = 'default' THEN 0 ELSE 1 END`, [profileId || 0])
  if (rows === undefined) return { unavailable: true }
  const { defaultRow, profileRow } = policyRowsFromQuery(rows)
  if (!defaultRow) throw capacityError('model_capacity_policy_unavailable')
  return normalizePolicy(defaultRow, profileRow)
}

function leaseExpiry(now, policy, deadlineAtMs) {
  const configured = now + policy.leaseMs
  return deadlineAtMs ? Math.min(configured, deadlineAtMs) : configured
}

function activeCapacity(activeRows, request, policy, now) {
  const active = (Array.isArray(activeRows) ? activeRows : []).filter(row => {
    const expires = Number(row.lease_expires_at_utc_msc || 0)
    return String(row.status || '') === ACTIVE_LEASE_STATUS && (!expires || expires > now)
  })
  const activeCritical = active.filter(row => row.queue_class === MODEL_TASK_CAPACITY_QUEUE.EXECUTION_CRITICAL).length
  const activeNonCritical = active.length - activeCritical
  if (active.length >= policy.maxConcurrency && request.queue !== MODEL_TASK_CAPACITY_QUEUE.EXECUTION_CRITICAL) return false
  if (request.queue !== MODEL_TASK_CAPACITY_QUEUE.EXECUTION_CRITICAL
    && activeNonCritical >= Math.max(0, policy.maxConcurrency - policy.reserveExecutionCriticalSlots)) return false
  if (request.queue === MODEL_TASK_CAPACITY_QUEUE.BACKGROUND && request.userId) {
    const sameUser = active.filter(row => row.queue_class === MODEL_TASK_CAPACITY_QUEUE.BACKGROUND
      && Number(row.user_id || 0) === Number(request.userId)).length
    if (sameUser >= policy.backgroundPerUserCap) return false
  }
  return activeCritical + activeNonCritical < policy.maxConcurrency
}

function chooseEligibleWaiter(waiters, activeRows, request, policy, now) {
  const eligible = (Array.isArray(waiters) ? waiters : []).filter(row => {
    if (String(row.status || '') !== WAITING_STATUS) return false
    const deadline = Number(row.deadline_at_utc_msc || 0)
    if (deadline && deadline <= now) return false
    const candidate = {
      queue: String(row.queue_class || ''),
      userId: safeUserId(row.user_id),
    }
    return activeCapacity(activeRows, candidate, policy, now)
  })
  // Critical work is preferred while all waiters are fresh. Once any eligible
  // waiter reaches the bounded aging threshold, switch that admission round
  // to strict durable arrival order so a continuous stream of critical jobs
  // cannot starve an older background/interactive waiter.
  const aged = eligible.filter(row => now - Number(row.requested_at_utc_msc || now) >= policy.starvationAgeMs)
  const candidates = aged.length ? aged : eligible
  candidates.sort((a, b) => {
    if (!aged.length) {
      const queueRank = row => row.queue_class === MODEL_TASK_CAPACITY_QUEUE.EXECUTION_CRITICAL ? 0
        : row.queue_class === MODEL_TASK_CAPACITY_QUEUE.INTERACTIVE ? 1 : 2
      const priorityDiff = queueRank(a) - queueRank(b)
      if (priorityDiff) return priorityDiff
    }
    const timeDiff = Number(a.requested_at_utc_msc || 0) - Number(b.requested_at_utc_msc || 0)
    if (timeDiff) return timeDiff
    return Number(a.waiter_id || 0) - Number(b.waiter_id || 0)
  })
  return candidates[0] || null
}

async function cancelCapacityWaiter(waiter) {
  if (!waiter?.waiterId || !waiter?.ownerToken) return false
  const result = await queryRun(`UPDATE ai_model_capacity_waiters
    SET status = 'cancelled', cancelled_at_utc_msc = ?, updated_at_utc_msc = ?
    WHERE waiter_id = ? AND owner_token = ? AND status = 'waiting'`,
  [Date.now(), Date.now(), waiter.waiterId, waiter.ownerToken])
  return Number(result?.affectedRows ?? result?.changes ?? 0) === 1
}

async function tryGrantCapacityWaiter(waiter, request, policy, now) {
  const result = await withTransaction(async run => {
    const { defaultRow, profileRow } = await readPolicyRows(run, request.profileId, { lock: true })
    if (!defaultRow) throw capacityError('model_capacity_policy_unavailable')
    const lockedPolicy = normalizePolicy(defaultRow, profileRow)

    // Reclaim only leases whose durable expiry has passed. A process restart
    // therefore cannot leak capacity, while a post-submit unknown response
    // remains conservative until this deadline.
    await run(`UPDATE ai_model_capacity_leases
      SET status = 'expired', released_at_utc_msc = ?, updated_at_utc_msc = ?
      WHERE status = 'active' AND lease_expires_at_utc_msc <= ?`, [now, now, now])
    await run(`UPDATE ai_model_capacity_waiters
      SET status = 'expired', cancelled_at_utc_msc = ?, updated_at_utc_msc = ?
      WHERE status = 'waiting' AND deadline_at_utc_msc IS NOT NULL AND deadline_at_utc_msc <= ?`, [now, now, now])

    const [activeRows] = await run(`SELECT lease_id, queue_class, user_id, status,
        lease_expires_at_utc_msc
      FROM ai_model_capacity_leases
      WHERE status = 'active' AND lease_expires_at_utc_msc > ?
        AND ((? IS NOT NULL AND model_profile_id = ?)
          OR (? IS NULL AND model_profile_id IS NULL))
      ORDER BY lease_id FOR UPDATE`, [now, request.profileId, request.profileId, request.profileId])
    const [waiters] = await run(`SELECT waiter_id, owner_token, queue_class, user_id,
        requested_at_utc_msc, deadline_at_utc_msc, status
      FROM ai_model_capacity_waiters
      WHERE status = 'waiting'
        AND ((? IS NOT NULL AND model_profile_id = ?)
          OR (? IS NULL AND model_profile_id IS NULL))
      ORDER BY requested_at_utc_msc, waiter_id
      LIMIT ${MAX_WAITERS_TO_LOCK} FOR UPDATE`, [request.profileId, request.profileId, request.profileId])
    const selected = chooseEligibleWaiter(waiters, activeRows, request, lockedPolicy, now)
    if (!selected || String(selected.owner_token) !== String(waiter.ownerToken)) return null

    const expiresAt = leaseExpiry(now, lockedPolicy, request.deadlineAtMs)
    if (expiresAt <= now) return null
    const leaseId = crypto.randomUUID()
    await run(`INSERT INTO ai_model_capacity_leases
      (lease_id, owner_token, waiter_id, model_task_id, model_profile_id, user_id,
       usage_kind, queue_class, status, acquired_at_utc_msc, lease_expires_at_utc_msc,
       conservative_until_utc_msc, created_at_utc_msc, updated_at_utc_msc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)`,
    [leaseId, waiter.ownerToken, waiter.waiterId, request.modelTaskId, request.profileId,
      request.userId, request.usage, request.queue, now, expiresAt, now, now])
    await run(`UPDATE ai_model_capacity_waiters
      SET status = 'granted', lease_id = ?, granted_at_utc_msc = ?, updated_at_utc_msc = ?
      WHERE waiter_id = ? AND owner_token = ? AND status = 'waiting'`,
    [leaseId, now, now, waiter.waiterId, waiter.ownerToken])
    return { leaseId, expiresAt, policy:lockedPolicy }
  })
  return result
}

function sleepUntilRetry(delayMs, signal, deadlineAtMs) {
  return new Promise((resolve, reject) => {
    let timer = null
    let deadlineTimer = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (deadlineTimer) clearTimeout(deadlineTimer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(signal.reason || capacityError('model_capacity_aborted'))
    }
    timer = setTimeout(() => { cleanup(); resolve() }, Math.max(1, delayMs))
    timer.unref?.()
    signal?.addEventListener?.('abort', onAbort, { once:true })
    if (deadlineAtMs) {
      const remaining = Math.max(1, deadlineAtMs - Date.now())
      deadlineTimer = setTimeout(() => { cleanup(); reject(capacityError('model_capacity_deadline_exceeded')) }, remaining)
      deadlineTimer.unref?.()
    }
  })
}

function stopHeartbeat(lease) {
  if (lease?.heartbeatTimer) {
    clearInterval(lease.heartbeatTimer)
    lease.heartbeatTimer = null
  }
}

async function renewLeaseInternal(lease, leaseMs = null) {
  if (!lease?.leaseId || !lease?.ownerToken || lease.released || lease.conservative) return false
  const now = Date.now()
  const configured = now + Math.max(1_000, Number(leaseMs) || Number(lease.policy?.leaseMs) || MODEL_TASK_CAPACITY_DEFAULTS.leaseMs)
  const expiresAt = lease.deadlineAtMs ? Math.min(configured, lease.deadlineAtMs) : configured
  if (expiresAt <= now) { stopHeartbeat(lease); return false }
  const result = await queryRun(`UPDATE ai_model_capacity_leases
    SET lease_expires_at_utc_msc = ?, updated_at_utc_msc = ?
    WHERE lease_id = ? AND owner_token = ? AND status = 'active'
      AND lease_expires_at_utc_msc > ?`,
  [expiresAt, now, lease.leaseId, lease.ownerToken, now])
  const renewed = Number(result?.affectedRows ?? result?.changes ?? 0) === 1
  if (renewed) lease.expiresAt = expiresAt
  else stopHeartbeat(lease)
  return renewed
}

async function releaseLeaseInternal(lease, reason = 'provider_response') {
  if (!lease?.leaseId || !lease?.ownerToken || lease.released) return false
  stopHeartbeat(lease)
  const now = Date.now()
  const result = await queryRun(`UPDATE ai_model_capacity_leases
    SET status = 'released', release_reason = ?, released_at_utc_msc = ?, updated_at_utc_msc = ?
    WHERE lease_id = ? AND owner_token = ? AND status = 'active'`,
  [String(reason || 'released').slice(0, 128), now, now, lease.leaseId, lease.ownerToken])
  const released = Number(result?.affectedRows ?? result?.changes ?? 0) === 1
  if (released) lease.released = true
  return released
}

/**
 * Acquire a durable model capacity lease. The waiter itself is durable, so a
 * process can wait without racing another process that happened to poll first.
 */
export async function acquireModelTaskCapacity(input = {}, options = {}) {
  const request = normalizeRequest(input, options)
  const policy = await resolvePolicy(request.profileId)
  // The undefined result is only used by unit-test DB adapters. A real mysql2
  // query returns []/null and therefore fails closed when migration 166 is
  // absent or the default row is missing.
  if (policy?.unavailable) return null
  const deadlineAtMs = request.deadlineAtMs || Date.now() + policy.leaseMs
  throwIfAborted(request.signal, deadlineAtMs)

  const ownerToken = crypto.randomUUID()
  const requestedAt = Date.now()
  const waiterResult = await queryRun(`INSERT INTO ai_model_capacity_waiters
    (owner_token, model_task_id, model_profile_id, user_id, usage_kind, queue_class,
     status, requested_at_utc_msc, deadline_at_utc_msc, created_at_utc_msc, updated_at_utc_msc)
    VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)`,
  [ownerToken, request.modelTaskId, request.profileId, request.userId, request.usage, request.queue,
    requestedAt, deadlineAtMs, requestedAt, requestedAt])
  const waiter = { waiterId:Number(waiterResult?.insertId || 0), ownerToken }
  if (!waiter.waiterId) throw capacityError('model_capacity_waiter_create_failed')

  try {
    for (;;) {
      throwIfAborted(request.signal, deadlineAtMs)
      const granted = await tryGrantCapacityWaiter(waiter, { ...request, deadlineAtMs }, policy, Date.now())
      if (granted) {
        const lease = {
          leaseId:granted.leaseId,
          ownerToken,
          waiterId:waiter.waiterId,
          modelTaskId:request.modelTaskId,
          profileId:request.profileId,
          userId:request.userId,
          usage:request.usage,
          queue:request.queue,
          expiresAt:granted.expiresAt,
          deadlineAtMs,
          policy:granted.policy,
          released:false,
          conservative:false,
          heartbeatTimer:null,
        }
        const heartbeatMs = Math.max(250, Math.min(30_000, Math.floor(granted.policy.leaseMs / 3)))
        lease.heartbeatTimer = setInterval(() => {
          renewLeaseInternal(lease).catch(error => {
            // The database row remains authoritative. If renewal fails or the
            // token is fenced, stop trying; provider capacity stays reserved
            // until the durable expiry and can then be reclaimed by a waiter.
            console.warn('[ModelCapacity] Lease heartbeat failed:', error.message)
            stopHeartbeat(lease)
          })
        }, heartbeatMs)
        lease.heartbeatTimer.unref?.()
        lease.renew = leaseMs => renewLeaseInternal(lease, leaseMs)
        lease.release = reason => releaseLeaseInternal(lease, reason)
        lease.retainConservative = options => retainModelTaskCapacityLease(lease, options)
        return lease
      }
      const delay = Math.min(policy.waiterPollMs, Math.max(1, deadlineAtMs - Date.now()))
      await sleepUntilRetry(delay, request.signal, deadlineAtMs)
    }
  } catch (error) {
    await cancelCapacityWaiter(waiter).catch(() => {})
    throw error
  }
}

export const acquireModelCapacity = acquireModelTaskCapacity
export const acquireCapacityLease = acquireModelTaskCapacity

export async function renewModelTaskCapacityLease(lease, leaseMs = null) {
  if (typeof lease === 'string') return false
  return renewLeaseInternal(lease, leaseMs)
}

export const renewModelCapacityLease = renewModelTaskCapacityLease

export async function releaseModelTaskCapacityLease(lease, reason = 'released') {
  if (typeof lease === 'string') return false
  return releaseLeaseInternal(lease, reason)
}

export const releaseModelCapacityLease = releaseModelTaskCapacityLease

/** Keep an unknown-result provider call conservatively reserved. */
export async function retainModelTaskCapacityLease(lease, { untilMs = null, reason = 'provider_response_unknown' } = {}) {
  if (!lease?.leaseId || !lease?.ownerToken || lease.released) return false
  stopHeartbeat(lease)
  const now = Date.now()
  const bounded = Math.min(
    now + Math.max(1_000, Number(lease.policy?.conservativeLeaseMs) || MODEL_TASK_CAPACITY_DEFAULTS.conservativeLeaseMs),
    Number(untilMs) > now ? Number(untilMs) : Number.POSITIVE_INFINITY,
    lease.deadlineAtMs && lease.deadlineAtMs > now ? lease.deadlineAtMs : Number.POSITIVE_INFINITY,
  )
  const result = await queryRun(`UPDATE ai_model_capacity_leases
    SET lease_expires_at_utc_msc = ?, conservative_until_utc_msc = ?, release_reason = ?, updated_at_utc_msc = ?
    WHERE lease_id = ? AND owner_token = ? AND status = 'active'`,
  [bounded, bounded, String(reason || 'provider_response_unknown').slice(0, 128), now, lease.leaseId, lease.ownerToken])
  const retained = Number(result?.affectedRows ?? result?.changes ?? 0) === 1
  if (retained) { lease.conservative = true; lease.expiresAt = bounded }
  return retained
}

export const retainModelCapacityLease = retainModelTaskCapacityLease

/** Reclaim only expired durable leases; safe to call from startup or a worker. */
export async function recoverExpiredModelTaskCapacityLeases(now = Date.now()) {
  const result = await queryRun(`UPDATE ai_model_capacity_leases
    SET status = 'expired', released_at_utc_msc = ?, updated_at_utc_msc = ?
    WHERE status = 'active' AND lease_expires_at_utc_msc <= ?`, [now, now, now])
  return Number(result?.affectedRows ?? result?.changes ?? 0)
}

export const recoverExpiredModelCapacityLeases = recoverExpiredModelTaskCapacityLeases
