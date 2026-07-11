import crypto from 'crypto'
import { queryAll, withTransaction } from '../db.js'
import { getRedis } from '../redis.js'

const JOB_NAME = 'hold_signal_cleanup'
const LOCK_KEY = `maintenance:${JOB_NAME}:lock`
const LAST_SUCCESS_KEY = `maintenance:${JOB_NAME}:last_success`
const LOCK_TTL_MS = 30 * 60 * 1000
const RETRY_DELAY_MS = 10 * 60 * 1000
const DEFAULT_BATCH_SIZE = 1000
const TARGET_HOUR = 4
const TARGET_MINUTE = 30

const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

const RENEW_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`

let cleanupTimer = null
let cleanupRunning = false

function beijingParts(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

export function beijingBusinessDate(now = new Date()) {
  const p = beijingParts(now)
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

export function nextCleanupDelay(now = new Date()) {
  const p = beijingParts(now)
  let target = Date.UTC(p.year, p.month, p.day, TARGET_HOUR - 8, TARGET_MINUTE)
  if (target <= now.getTime()) target += 24 * 60 * 60 * 1000
  return target - now.getTime()
}

export function cleanupDueToday(now = new Date()) {
  const p = beijingParts(now)
  return p.hour > TARGET_HOUR || (p.hour === TARGET_HOUR && p.minute >= TARGET_MINUTE)
}

function batchSize() {
  const configured = Number.parseInt(process.env.HOLD_SIGNAL_CLEANUP_BATCH_SIZE || '', 10)
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 5000) : DEFAULT_BATCH_SIZE
}

async function releaseLock(redis, token) {
  try {
    await redis.eval(RELEASE_LOCK_LUA, 1, LOCK_KEY, token)
  } catch (err) {
    console.error('[HoldSignalCleanup] Redis lock release failed:', err.message)
  }
}

async function renewLock(redis, token) {
  const renewed = await redis.eval(RENEW_LOCK_LUA, 1, LOCK_KEY, token, String(LOCK_TTL_MS))
  return renewed > 0
}

export async function deleteExpiredHoldSignals({ redis, limit = batchSize() } = {}) {
  let deletedSignals = 0
  let deletedDeliveries = 0
  let batches = 0

  while (true) {
    if (redis && !(await renewLock(redis.client, redis.token))) {
      throw new Error('cleanup_lock_lost')
    }

    const rows = await queryAll(
      `SELECT id FROM ai_signals
       WHERE signal_type = 'hold' AND created_at < DATE_SUB(CURDATE(), INTERVAL 1 DAY)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      [limit]
    )
    if (rows.length === 0) break

    const ids = rows.map(row => row.id)
    const placeholders = ids.map(() => '?').join(',')
    const result = await withTransaction(async run => {
      const [deliveryResult] = await run(
        `DELETE FROM auto_signal_deliveries WHERE signal_id IN (${placeholders})`, ids
      )
      const [signalResult] = await run(
        `DELETE FROM ai_signals WHERE id IN (${placeholders}) AND signal_type = 'hold'`, ids
      )
      return {
        deliveries: deliveryResult.affectedRows || 0,
        signals: signalResult.affectedRows || 0,
      }
    })

    deletedDeliveries += result.deliveries
    deletedSignals += result.signals
    batches += 1
  }

  return { deletedSignals, deletedDeliveries, batches }
}

export async function runHoldSignalCleanup(now = new Date()) {
  if (process.env.HOLD_SIGNAL_CLEANUP_ENABLED === 'false') return { status: 'disabled' }
  if (cleanupRunning) return { status: 'already_running' }

  const redis = getRedis()
  if (!redis) {
    console.warn('[HoldSignalCleanup] Redis unavailable, cleanup skipped')
    return { status: 'redis_unavailable' }
  }

  cleanupRunning = true
  const businessDate = beijingBusinessDate(now)
  const token = crypto.randomUUID()
  const startedAt = Date.now()
  let lockOwned = false

  try {
    if (await redis.get(LAST_SUCCESS_KEY) === businessDate) return { status: 'already_completed' }

    const acquired = await redis.set(LOCK_KEY, token, 'NX', 'PX', LOCK_TTL_MS)
    if (!acquired) return { status: 'locked' }
    lockOwned = true

    if (await redis.get(LAST_SUCCESS_KEY) === businessDate) return { status: 'already_completed' }

    console.log(`[HoldSignalCleanup] Started, business_date=${businessDate}, cutoff=yesterday 00:00 Asia/Shanghai`)
    const result = await deleteExpiredHoldSignals({ redis: { client: redis, token } })
    await redis.set(LAST_SUCCESS_KEY, businessDate)
    console.log(`[HoldSignalCleanup] Completed, signals=${result.deletedSignals}, deliveries=${result.deletedDeliveries}, batches=${result.batches}, duration_ms=${Date.now() - startedAt}`)
    return { status: 'completed', ...result }
  } catch (err) {
    console.error('[HoldSignalCleanup] Failed:', err.message)
    return { status: 'failed', error: err.message }
  } finally {
    if (lockOwned) await releaseLock(redis, token)
    cleanupRunning = false
  }
}

function schedule(delay) {
  if (cleanupTimer) clearTimeout(cleanupTimer)
  cleanupTimer = setTimeout(async () => {
    cleanupTimer = null
    const result = await runHoldSignalCleanup()
    const retry = ['failed', 'redis_unavailable', 'locked'].includes(result.status)
    schedule(retry ? RETRY_DELAY_MS : nextCleanupDelay())
  }, delay)
  cleanupTimer.unref?.()
}

export async function startHoldSignalCleanup(now = new Date()) {
  if (cleanupTimer || cleanupRunning || process.env.HOLD_SIGNAL_CLEANUP_ENABLED === 'false') return

  if (cleanupDueToday(now)) {
    const result = await runHoldSignalCleanup(now)
    const retry = ['failed', 'redis_unavailable', 'locked'].includes(result.status)
    schedule(retry ? RETRY_DELAY_MS : nextCleanupDelay(now))
  } else {
    schedule(nextCleanupDelay(now))
  }
  console.log('[HoldSignalCleanup] Scheduled daily at 04:30 Asia/Shanghai')
}

export function stopHoldSignalCleanup() {
  if (cleanupTimer) clearTimeout(cleanupTimer)
  cleanupTimer = null
}
