import crypto from 'node:crypto'
import { queryOne } from '../../db.js'
import { getRedis, isRedisAvailable } from '../../redis.js'

export const AUTO_INFERENCE_DEPLOYMENT_DRAIN_KEY = 'auto:inference:deployment-drain'
export const AUTO_INFERENCE_DEPLOYMENT_DRAIN_DEFAULT_TTL_SECONDS = 900
export const AUTO_INFERENCE_DEPLOYMENT_DRAIN_MIN_TTL_SECONDS = 30
export const AUTO_INFERENCE_DEPLOYMENT_DRAIN_MAX_TTL_SECONDS = 3600
const REDIS_DRAIN_READY_TIMEOUT_MS = 5000

const AUTO_INFERENCE_TERMINAL_STATES = [
  'cancelled', 'failed_terminal', 'succeeded', 'completed_stale', 'completed_rejected',
]

const RELEASE_DRAIN_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

const RENEW_DRAIN_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('expire', KEYS[1], ARGV[2])
end
return 0
`

function drainError(code, message = code) {
  return Object.assign(new Error(message), { code })
}

function normalizedTtlSeconds(value = AUTO_INFERENCE_DEPLOYMENT_DRAIN_DEFAULT_TTL_SECONDS) {
  const ttl = Number(value)
  if (!Number.isSafeInteger(ttl)
    || ttl < AUTO_INFERENCE_DEPLOYMENT_DRAIN_MIN_TTL_SECONDS
    || ttl > AUTO_INFERENCE_DEPLOYMENT_DRAIN_MAX_TTL_SECONDS) {
    throw drainError('auto_inference_drain_ttl_invalid')
  }
  return ttl
}

function normalizedToken(value) {
  const token = String(value || '').trim()
  if (token && token.length <= 256) return token
  return crypto.randomUUID()
}

async function redisForOperation(redis) {
  const client = redis || getRedis()
  if (!client) throw drainError('auto_inference_drain_redis_unavailable')
  if (isRedisAvailable()) return client
  if (typeof client.ping !== 'function') throw drainError('auto_inference_drain_redis_unavailable')
  let timeoutId
  try {
    await Promise.race([
      client.ping(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(drainError('auto_inference_drain_redis_timeout')), REDIS_DRAIN_READY_TIMEOUT_MS)
      }),
    ])
    // A successful ping is the operation-local readiness proof. The shared
    // availability flag may be updated by ioredis on the next event turn.
    return client
  } catch (error) {
    throw drainError('auto_inference_drain_redis_unavailable', error.message)
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function drainExpiry(ttlSeconds, nowMs = Date.now()) {
  return Number(ttlSeconds) > 0 ? nowMs + Number(ttlSeconds) * 1000 : null
}

/**
 * Read the process-wide deployment drain lease. The token is intentionally
 * returned only to internal callers so a caller can prove ownership before
 * releasing or renewing the lease; no HTTP route exposes it.
 */
export async function readAutoInferenceDeploymentDrain({ redis: suppliedRedis, nowMs = Date.now() } = {}) {
  let redis
  try {
    redis = await redisForOperation(suppliedRedis)
    const token = await redis.get(AUTO_INFERENCE_DEPLOYMENT_DRAIN_KEY)
    if (!token) return { available:true, active:false, token:'', ttlSeconds:0, expiresAtUtcMsc:null }
    const rawTtl = await redis.ttl(AUTO_INFERENCE_DEPLOYMENT_DRAIN_KEY)
    const ttlSeconds = Number(rawTtl)
    // -2 means the key disappeared between GET and TTL. A zero TTL is kept as
    // active for this read and will be rechecked on the next scheduler tick.
    if (ttlSeconds === -2) return { available:true, active:false, token:'', ttlSeconds:0, expiresAtUtcMsc:null }
    return {
      available:true,
      active:true,
      token:String(token),
      ttlSeconds:Number.isFinite(ttlSeconds) ? ttlSeconds : null,
      expiresAtUtcMsc:drainExpiry(ttlSeconds, nowMs),
    }
  } catch (error) {
    return {
      available:false,
      active:false,
      token:'',
      ttlSeconds:null,
      expiresAtUtcMsc:null,
      error:String(error?.code || error?.message || 'auto_inference_drain_read_failed'),
    }
  }
}

export async function beginAutoInferenceDeploymentDrain({
  redis: suppliedRedis, token, ttlSeconds = AUTO_INFERENCE_DEPLOYMENT_DRAIN_DEFAULT_TTL_SECONDS,
  nowMs = Date.now(),
} = {}) {
  const ttl = normalizedTtlSeconds(ttlSeconds)
  const redis = await redisForOperation(suppliedRedis)
  const leaseToken = normalizedToken(token)
  let result
  try {
    result = await redis.set(
      AUTO_INFERENCE_DEPLOYMENT_DRAIN_KEY,
      leaseToken,
      'EX',
      ttl,
      'NX',
    )
  } catch (error) {
    throw drainError('auto_inference_drain_begin_failed', error.message)
  }
  if (!result) {
    const current = await readAutoInferenceDeploymentDrain({ redis, nowMs })
    return {
      acquired:false,
      key:AUTO_INFERENCE_DEPLOYMENT_DRAIN_KEY,
      ttlSeconds:current.ttlSeconds,
      expiresAtUtcMsc:current.expiresAtUtcMsc,
    }
  }
  return {
    acquired:true,
    key:AUTO_INFERENCE_DEPLOYMENT_DRAIN_KEY,
    token:leaseToken,
    ttlSeconds:ttl,
    expiresAtUtcMsc:drainExpiry(ttl, nowMs),
  }
}

export async function renewAutoInferenceDeploymentDrain({
  redis: suppliedRedis, token, ttlSeconds = AUTO_INFERENCE_DEPLOYMENT_DRAIN_DEFAULT_TTL_SECONDS,
} = {}) {
  const ttl = normalizedTtlSeconds(ttlSeconds)
  const leaseToken = String(token || '').trim()
  if (!leaseToken) return false
  const redis = await redisForOperation(suppliedRedis)
  if (typeof redis.eval !== 'function') throw drainError('auto_inference_drain_atomic_command_unavailable')
  try {
    const result = await redis.eval(RENEW_DRAIN_LUA, 1, AUTO_INFERENCE_DEPLOYMENT_DRAIN_KEY, leaseToken, ttl)
    return Number(result) === 1
  } catch (error) {
    throw drainError('auto_inference_drain_renew_failed', error.message)
  }
}

export async function endAutoInferenceDeploymentDrain({ redis: suppliedRedis, token } = {}) {
  const leaseToken = String(token || '').trim()
  if (!leaseToken) return { released:false, reason:'token_required' }
  const redis = await redisForOperation(suppliedRedis)
  if (typeof redis.eval !== 'function') throw drainError('auto_inference_drain_atomic_command_unavailable')
  try {
    const result = await redis.eval(RELEASE_DRAIN_LUA, 1, AUTO_INFERENCE_DEPLOYMENT_DRAIN_KEY, leaseToken)
    return { released:Number(result) === 1, reason:Number(result) === 1 ? null : 'token_mismatch' }
  } catch (error) {
    throw drainError('auto_inference_drain_end_failed', error.message)
  }
}

export async function countActiveAutoInferenceTasks() {
  const placeholders = AUTO_INFERENCE_TERMINAL_STATES.map(() => '?').join(', ')
  const row = await queryOne(`SELECT COUNT(*) AS active_count
    FROM ai_model_tasks
    WHERE task_kind = 'auto_inference'
      AND COALESCE(status, '') NOT IN (${placeholders})`, AUTO_INFERENCE_TERMINAL_STATES)
  return Math.max(0, Number(row?.active_count || 0))
}

function waitDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitForAutoInferenceDeploymentDrain({
  token, timeoutSeconds, pollSeconds = 5, ttlSeconds = AUTO_INFERENCE_DEPLOYMENT_DRAIN_DEFAULT_TTL_SECONDS,
  now = () => Date.now(), sleep = waitDelay, read = readAutoInferenceDeploymentDrain,
  count = countActiveAutoInferenceTasks, renew = renewAutoInferenceDeploymentDrain,
} = {}) {
  const leaseToken = String(token || '').trim()
  if (!leaseToken) throw drainError('auto_inference_drain_token_required')
  const pollMs = Math.max(250, Number(pollSeconds) * 1000 || 5000)
  const timeoutMs = Math.max(1000, (Number(timeoutSeconds) > 0 ? Number(timeoutSeconds) : Number(ttlSeconds)) * 1000)
  const startedAt = now()
  const deadline = startedAt + timeoutMs

  while (true) {
    const lease = await read()
    if (!lease.available) throw drainError('auto_inference_drain_redis_unavailable')
    if (!lease.active || lease.token !== leaseToken) throw drainError('auto_inference_drain_token_mismatch')
    const activeCount = await count()
    if (activeCount === 0) {
      return { drained:true, activeCount:0, elapsedMs:Math.max(0, now() - startedAt) }
    }
    if (now() >= deadline) {
      return { drained:false, activeCount, timeout:true, elapsedMs:Math.max(0, now() - startedAt) }
    }

    // Keep the lease alive only while its owner is actively waiting. A crashed
    // deploy process still leaves a bounded TTL for the scheduler to recover.
    if (typeof renew === 'function') {
      const renewed = await renew({ token:leaseToken, ttlSeconds })
      if (!renewed) throw drainError('auto_inference_drain_token_mismatch')
    }
    await sleep(Math.min(pollMs, Math.max(250, deadline - now())))
  }
}

export const __autoInferenceDeploymentDrainTest = {
  AUTO_INFERENCE_TERMINAL_STATES,
  RELEASE_DRAIN_LUA,
  RENEW_DRAIN_LUA,
  normalizedTtlSeconds,
  normalizedToken,
  drainExpiry,
}
