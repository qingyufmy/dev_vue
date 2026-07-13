import crypto from 'crypto'
import { queryRun } from '../db.js'
import { getRedis, isRedisAvailable } from '../redis.js'
import { getAllBridges, sendBridgeCommand, sendToBrowsers } from '../bridge-ws.js'
import {
  isWeeklyFlattenPrimaryWindow,
  isWeeklyFlattenWindow,
  weeklyFlattenCycleId,
  weeklyFlattenEnabled,
} from './weekly-risk-window.js'

const SYSTEM_MAGIC = 234000
const LOCK_TTL_MS = 2 * 60 * 1000
const COMPLETED_TTL_SECONDS = 14 * 24 * 60 * 60
const ACTIVE_INTERVAL_MS = 15 * 1000
const RECOVERY_INTERVAL_MS = 60 * 1000

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

let timer = null
let running = false

function userConcurrency() {
  const configured = Number.parseInt(process.env.WEEKLY_SYSTEM_FLATTEN_CONCURRENCY || '', 10)
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 20) : 5
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

function lockKey(userId, cycle) {
  return `risk:weekly_flatten:${cycle}:user:${userId}:lock`
}

function completedKey(userId, cycle) {
  return `risk:weekly_flatten:${cycle}:user:${userId}:completed`
}

async function audit(userId, action, symbol, request, result, status) {
  await queryRun(
    `INSERT INTO trade_audit_logs(user_id, action, symbol, request_json, result_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [userId, action, symbol || null, JSON.stringify(request || {}), JSON.stringify(result || {}), status]
  ).catch(err => console.error(`[WeeklyFlatten] Audit failed user=${userId} action=${action}:`, err.message))
}

async function inventory(userId) {
  return sendBridgeCommand(userId, 'system_trade_inventory', {}, 15000, { noFallback: true })
}

async function notify(userId, status, details = {}) {
  sendToBrowsers(userId, { type: 'weekly_flatten_state', status, ...details })
}

export async function runWeeklySystemFlattenForUser(userId, now = new Date()) {
  if (!isWeeklyFlattenWindow(now)) return { status: 'outside_window' }
  const redis = getRedis()
  if (!redis || !isRedisAvailable()) return { status: 'redis_unavailable' }

  const cycle = weeklyFlattenCycleId(now)
  const doneKey = completedKey(userId, cycle)
  const wasCompleted = !!(await redis.get(doneKey))
  // Keep verifying throughout 04:00-05:00 because an order accepted just
  // before the risk window can arrive after the first zero-inventory check.
  if (wasCompleted && !isWeeklyFlattenPrimaryWindow(now)) return { status: 'already_completed', cycle }

  const key = lockKey(userId, cycle)
  const token = crypto.randomUUID()
  const acquired = await redis.set(key, token, 'NX', 'PX', LOCK_TTL_MS)
  if (!acquired) return { status: 'locked', cycle }

  const startedAt = Date.now()
  let lockOwned = true
  const renewTimer = setInterval(async () => {
    try {
      lockOwned = (await redis.eval(RENEW_LOCK_LUA, 1, key, token, String(LOCK_TTL_MS))) > 0
    } catch {
      lockOwned = false
    }
  }, Math.floor(LOCK_TTL_MS / 3))
  renewTimer.unref?.()
  try {
    const before = await inventory(userId)
    if (!before || before.status !== 'success') {
      const result = { status: 'failed', reason: 'inventory_unavailable', response: before, cycle }
      await audit(userId, 'weekly_flatten_retry', null, { cycle, stage: 'inventory' }, result, 'error')
      await notify(userId, 'retrying', { cycle, reason: 'inventory_unavailable' })
      return result
    }

    const pendingOrders = Array.isArray(before.pending_orders) ? before.pending_orders : []
    const positions = Array.isArray(before.positions) ? before.positions : []
    if (wasCompleted && pendingOrders.length === 0 && positions.length === 0) {
      return { status: 'already_completed', cycle, verified: true }
    }
    if (wasCompleted) await redis.del(doneKey)
    const announced = await redis.set(`${doneKey}:started`, '1', 'NX', 'EX', COMPLETED_TTL_SECONDS)
    if (announced) {
      await audit(userId, 'weekly_flatten_started', null,
        { cycle, magic: SYSTEM_MAGIC, pending_count: pendingOrders.length, position_count: positions.length, account: before.account },
        { status: 'started' }, 'info')
      await notify(userId, 'running', { cycle, pending_count: pendingOrders.length, position_count: positions.length })
    }

    const failures = []
    for (const order of pendingOrders) {
      if (!lockOwned) throw new Error('weekly_flatten_lock_lost')
      const result = await sendBridgeCommand(userId, 'cancel_system_pending', { ticket: order.ticket }, 15000, { noFallback: true })
      const ok = result?.status === 'success'
      if (!ok) failures.push({ kind: 'pending', ticket: order.ticket, result })
      if (ok) {
        await Promise.all([
          queryRun("UPDATE auto_signal_deliveries SET pending_state = 'cancelled' WHERE user_id = ? AND pending_ticket = ? AND pending_state = 'pending'", [userId, String(order.ticket)]),
          queryRun("UPDATE ai_signals SET pending_state = 'cancelled' WHERE user_id = ? AND pending_ticket = ? AND pending_state = 'pending'", [userId, String(order.ticket)]),
        ]).catch(err => console.error(`[WeeklyFlatten] Pending state sync failed user=${userId} ticket=${order.ticket}:`, err.message))
      }
      await audit(userId, ok ? 'weekly_pending_cancelled' : 'weekly_flatten_retry', order.symbol,
        { cycle, ticket: order.ticket, magic: SYSTEM_MAGIC }, result, ok ? 'success' : 'error')
    }

    if (positions.length > 0 && before.account?.is_hedging !== true) {
      const result = { status: 'unsupported_netting', cycle, account: before.account, position_count: positions.length }
      await audit(userId, 'weekly_flatten_unsupported_netting', null,
        { cycle, magic: SYSTEM_MAGIC, account: before.account }, result, 'error')
      await notify(userId, 'failed', { cycle, reason: 'unsupported_netting', remaining_positions: positions.length })
      return result
    }

    for (const position of positions) {
      if (!lockOwned) throw new Error('weekly_flatten_lock_lost')
      const result = await sendBridgeCommand(userId, 'close_system_position', { ticket: position.ticket }, 15000, { noFallback: true })
      const ok = result?.status === 'success'
      if (!ok) failures.push({ kind: 'position', ticket: position.ticket, result })
      await audit(userId, ok ? 'weekly_position_closed' : 'weekly_flatten_retry', position.symbol,
        { cycle, ticket: position.ticket, volume: position.volume, magic: SYSTEM_MAGIC }, result, ok ? 'success' : 'error')
    }

    const after = await inventory(userId)
    if (!after || after.status !== 'success') {
      const result = { status: 'failed', reason: 'verification_unavailable', failures, cycle }
      await audit(userId, 'weekly_flatten_retry', null, { cycle, stage: 'verification' }, result, 'error')
      await notify(userId, 'retrying', { cycle, reason: 'verification_unavailable' })
      return result
    }

    const remainingPending = Array.isArray(after.pending_orders) ? after.pending_orders : []
    const remainingPositions = Array.isArray(after.positions) ? after.positions : []
    if (remainingPending.length === 0 && remainingPositions.length === 0) {
      const result = { status: 'completed', cycle, duration_ms: Date.now() - startedAt }
      await redis.set(doneKey, JSON.stringify({ completed_at: new Date().toISOString() }), 'EX', COMPLETED_TTL_SECONDS)
      await audit(userId, 'weekly_flatten_completed', null,
        { cycle, magic: SYSTEM_MAGIC }, result, 'success')
      await notify(userId, 'completed', { cycle })
      return result
    }

    const result = {
      status: 'partial', cycle, failures,
      remaining_pending: remainingPending.map(item => item.ticket),
      remaining_positions: remainingPositions.map(item => item.ticket),
    }
    const primaryWindow = isWeeklyFlattenPrimaryWindow(now)
    const reportSuffix = primaryWindow ? 'partial' : 'missed'
    const reportTtl = primaryWindow ? 300 : COMPLETED_TTL_SECONDS
    const shouldReport = await redis.set(`${doneKey}:${reportSuffix}:reported`, '1', 'NX', 'EX', reportTtl)
    if (shouldReport) {
      await audit(userId, primaryWindow ? 'weekly_flatten_partial' : 'weekly_flatten_missed', null,
        { cycle, magic: SYSTEM_MAGIC }, result, primaryWindow ? 'warning' : 'error')
      await notify(userId, primaryWindow ? 'retrying' : 'failed', {
        cycle,
        reason: primaryWindow ? 'positions_remaining' : 'deadline_missed',
        remaining_pending: remainingPending.length,
        remaining_positions: remainingPositions.length,
      })
    }
    return result
  } catch (err) {
    const result = { status: 'failed', error: err.message, cycle }
    await audit(userId, 'weekly_flatten_retry', null, { cycle }, result, 'error')
    return result
  } finally {
    clearInterval(renewTimer)
    try { await redis.eval(RELEASE_LOCK_LUA, 1, key, token) } catch (err) {
      console.error(`[WeeklyFlatten] Lock release failed user=${userId}:`, err.message)
    }
  }
}

export async function runWeeklySystemFlatten(now = new Date()) {
  if (!isWeeklyFlattenWindow(now)) return { status: 'outside_window', users: [] }
  if (running) return { status: 'already_running', users: [] }
  if (!getRedis() || !isRedisAvailable()) return { status: 'redis_unavailable', users: [] }

  running = true
  try {
    const users = getAllBridges().filter(item => item.connected && item.alive)
    const results = await mapWithConcurrency(users, userConcurrency(), async item => ({
      userId: item.userId,
      result: await runWeeklySystemFlattenForUser(item.userId, now),
    }))
    return { status: 'completed', users: results }
  } finally {
    running = false
  }
}

function scheduleNext(now = new Date()) {
  if (timer) clearTimeout(timer)
  const delay = isWeeklyFlattenPrimaryWindow(now) ? ACTIVE_INTERVAL_MS : RECOVERY_INTERVAL_MS
  timer = setTimeout(async () => {
    timer = null
    await runWeeklySystemFlatten().catch(err => console.error('[WeeklyFlatten] Cycle failed:', err.message))
    scheduleNext()
  }, delay)
  timer.unref?.()
}

export async function triggerWeeklySystemFlattenForUser(userId, now = new Date()) {
  if (!isWeeklyFlattenWindow(now)) return { status: 'outside_window' }
  return runWeeklySystemFlattenForUser(userId, now)
}

export function startWeeklySystemFlatten(now = new Date()) {
  if (timer || !weeklyFlattenEnabled()) return
  if (isWeeklyFlattenWindow(now)) {
    runWeeklySystemFlatten(now).catch(err => console.error('[WeeklyFlatten] Startup run failed:', err.message))
  }
  scheduleNext(now)
  console.log('[WeeklyFlatten] Scheduled: Saturday 04:00-05:00 Asia/Shanghai, weekend recovery until Monday 08:00')
}

export function stopWeeklySystemFlatten() {
  if (timer) clearTimeout(timer)
  timer = null
}

export const __weeklyFlattenTest = { lockKey, completedKey, mapWithConcurrency, SYSTEM_MAGIC }
