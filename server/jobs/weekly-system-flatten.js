import crypto from 'crypto'
import { queryRun } from '../db.js'
import { getRedis, isRedisAvailable } from '../redis.js'
import { getAllBridges, getPlatformMarketClockState, sendBridgeCommand, sendToBrowsers } from '../bridge-ws.js'
import { prepareAuditRecord } from '../audit-localization.js'
import {
  isWeeklyFlattenWindow,
  weeklyFlattenCycleId,
  weeklyFlattenEnabled,
} from './weekly-risk-window.js'

const SYSTEM_MAGIC = 234000
const LOCK_TTL_MS = 2 * 60 * 1000
const COMPLETED_TTL_SECONDS = 14 * 24 * 60 * 60
const ACTIVE_INTERVAL_MS = 15 * 1000
const IDLE_INTERVAL_MS = 60 * 1000

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

const REMEMBER_CYCLE_RESULT_LUA = `
redis.call("sadd", KEYS[1], ARGV[1])
redis.call("expire", KEYS[1], ARGV[3])
redis.call("set", KEYS[2], ARGV[2], "EX", ARGV[3])
return 1
`

let timer = null
let running = false
let activeCycle = null
const localCycleStates = new Map()
const activeUserRuns = new Set()
const activeUserRunCounts = new Map()

function terminalClockOffset(clock = {}) {
  if (clock.timezone_offset_minutes === null || clock.timezone_offset_minutes === undefined
    || clock.timezone_offset_minutes === '') return null
  const offset = Number(clock.timezone_offset_minutes)
  const status = String(clock.clock_status || '').trim().toLowerCase()
  if (!Number.isInteger(offset) || offset < -720 || offset > 840 || !status
    || ['unknown', 'unavailable', 'unverified', 'calibrating', 'fallback'].includes(status)) return null
  return offset
}

function logTime() {
  return new Date().toISOString()
}

function logCycle(cycle, message) {
  console.log(`[WeeklyFlatten ${cycle}] ${logTime()} ${message}`)
}

function logUser(cycle, userId, message) {
  console.log(`[WeeklyFlatten ${cycle} U${userId}] ${logTime()} ${message}`)
}

function userConcurrency() {
  const configured = Number.parseInt(process.env.WEEKLY_SYSTEM_FLATTEN_CONCURRENCY || '', 10)
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 20) : 5
}

function inventoryExpectedState(item) {
  const rawDirection = String(item?.side || item?.type || '').toLowerCase()
  return {
    ticket:String(item?.ticket ?? ''),
    symbol:String(item?.symbol || ''),
    direction:rawDirection.startsWith('buy') ? 'buy' : (rawDirection.startsWith('sell') ? 'sell' : ''),
    magic:Number(item?.magic || 0),
    volume:Number(item?.volume || 0),
  }
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

function cycleUsersKey(cycle) {
  return `risk:weekly_flatten:${cycle}:users`
}

function cycleStateKey(userId, cycle) {
  return `risk:weekly_flatten:${cycle}:user:${userId}:last_result`
}

function cycleFinalizedKey(cycle) {
  return `risk:weekly_flatten:${cycle}:deadline_finalized`
}

function rememberLocalResult(cycle, userId, result) {
  let states = localCycleStates.get(cycle)
  if (!states) {
    states = new Map()
    localCycleStates.set(cycle, states)
  }
  states.set(Number(userId), result || { status: 'unknown' })
}

async function rememberCycleResult(cycle, userId, result) {
  rememberLocalResult(cycle, userId, result)
  const redis = getRedis()
  if (!redis || !isRedisAvailable()) return
  try {
    await redis.eval(
      REMEMBER_CYCLE_RESULT_LUA,
      2,
      cycleUsersKey(cycle),
      cycleStateKey(userId, cycle),
      String(userId),
      JSON.stringify(result || { status: 'unknown' }),
      String(COMPLETED_TTL_SECONDS)
    )
  } catch (err) {
    console.error(`[WeeklyFlatten] Failed to persist cycle state user=${userId}:`, err.message)
  }
}

function runTrackedUserFlatten(userId, now = new Date(), clock = () => new Date(), timezoneOffsetMinutes = null) {
  const cycle = weeklyFlattenCycleId(now, timezoneOffsetMinutes)
  activeCycle = cycle
  const normalizedUserId = Number(userId)
  activeUserRunCounts.set(normalizedUserId, Number(activeUserRunCounts.get(normalizedUserId) || 0) + 1)
  const run = (async () => {
    const result = await runWeeklySystemFlattenForUser(
      normalizedUserId, now, clock, timezoneOffsetMinutes)
    await rememberCycleResult(cycle, normalizedUserId, result)
    return result
  })()
  activeUserRuns.add(run)
  run.finally(() => {
    activeUserRuns.delete(run)
    const remaining = Number(activeUserRunCounts.get(normalizedUserId) || 1) - 1
    if (remaining > 0) activeUserRunCounts.set(normalizedUserId, remaining)
    else activeUserRunCounts.delete(normalizedUserId)
  }).catch(() => {})
  return run
}

export function getWeeklySystemFlattenState(userIds = []) {
  const requested = new Set((userIds || []).map(Number))
  const activeUserIds = [...activeUserRunCounts.keys()]
  const affectedUserIds = activeUserIds.filter(userId => requested.size === 0 || requested.has(userId))
  return {
    running,
    active_cycle:activeCycle,
    active_user_ids:activeUserIds,
    affected_user_ids:affectedUserIds,
    affected:affectedUserIds.length > 0,
  }
}

async function audit(userId, action, symbol, request, result, status) {
  try {
    const record = prepareAuditRecord(action, request, result, status)
    await queryRun(
      `INSERT INTO trade_audit_logs(user_id, action, symbol, request_json, result_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [userId, record.action, symbol || null, JSON.stringify(record.request), JSON.stringify(record.result), record.status]
    )
    return true
  } catch (err) {
    console.error(`[WeeklyFlatten] Audit failed user=${userId} action=${action}:`, err.message)
    return false
  }
}

async function inventory(userId) {
  return sendBridgeCommand(userId, 'system_trade_inventory', {}, 15000, { noFallback: true })
}

async function notify(userId, status, details = {}) {
  sendToBrowsers(userId, { type: 'weekly_flatten_state', status, ...details })
}

async function reportOnce(redis, key, ttlSeconds, callback) {
  const acquired = await redis.set(key, '1', 'NX', 'EX', ttlSeconds)
  if (acquired) await callback()
  return !!acquired
}

export async function runWeeklySystemFlattenForUser(userId, now = new Date(), clock = () => new Date(), timezoneOffsetMinutes = null) {
  if (timezoneOffsetMinutes === null || timezoneOffsetMinutes === undefined
    || timezoneOffsetMinutes === '' || !Number.isInteger(Number(timezoneOffsetMinutes))) {
    return { status:'terminal_clock_unverified' }
  }
  const offset = Number(timezoneOffsetMinutes)
  if (!isWeeklyFlattenWindow(now, offset)) return { status: 'outside_window' }
  const redis = getRedis()
  const cycle = weeklyFlattenCycleId(now, offset)
  if (!redis || !isRedisAvailable()) {
    logUser(cycle, userId, '终止处理：Redis 不可用')
    return { status: 'redis_unavailable' }
  }

  const doneKey = completedKey(userId, cycle)
  let wasCompleted
  try {
    wasCompleted = !!(await redis.get(doneKey))
  } catch (err) {
    console.error(`[WeeklyFlatten] Redis completion check failed user=${userId}:`, err.message)
    return { status: 'redis_unavailable', error: err.message, cycle }
  }
  if (wasCompleted) {
    return { status: 'already_completed', cycle }
  }

  const key = lockKey(userId, cycle)
  const token = crypto.randomUUID()
  let acquired
  try {
    acquired = await redis.set(key, token, 'NX', 'PX', LOCK_TTL_MS)
  } catch (err) {
    console.error(`[WeeklyFlatten] Redis lock failed user=${userId}:`, err.message)
    return { status: 'redis_unavailable', error: err.message, cycle }
  }
  if (!acquired) {
    logUser(cycle, userId, '跳过处理：已有其他实例正在处理该账户')
    return { status: 'locked', cycle }
  }
  logUser(cycle, userId, '开始处理用户账户')
  logUser(cycle, userId, '已取得 Redis 用户任务锁')

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
    logUser(cycle, userId, '正在获取系统持仓和挂单清单')
    const before = await inventory(userId)
    if (!before || before.status !== 'success') {
      logUser(cycle, userId, `交易清单获取失败：${before?.message || before?.status || '桥接无响应'}`)
      const result = { status: 'failed', reason: 'inventory_unavailable', response: before, cycle }
      await reportOnce(redis, `${doneKey}:inventory:reported`, 300, async () => {
        await audit(userId, 'weekly_flatten_retry', null, { cycle, stage: 'inventory' }, result, 'error')
        await notify(userId, 'retrying', { cycle, reason: 'inventory_unavailable' })
      })
      return result
    }

    const pendingOrders = Array.isArray(before.pending_orders) ? before.pending_orders : []
    const positions = Array.isArray(before.positions) ? before.positions : []
    logUser(cycle, userId, `交易清单获取完成：系统挂单 ${pendingOrders.length} 笔，系统持仓 ${positions.length} 笔`)
    const announced = await redis.set(`${doneKey}:started`, '1', 'NX', 'EX', COMPLETED_TTL_SECONDS)
    if (announced) {
      await audit(userId, 'weekly_flatten_started', null,
        { cycle, magic: SYSTEM_MAGIC, pending_count: pendingOrders.length, position_count: positions.length, account: before.account },
        { status: 'started' }, 'info')
      await notify(userId, 'running', { cycle, pending_count: pendingOrders.length, position_count: positions.length })
    }

    const failures = []
    for (const order of pendingOrders) {
      if (!isWeeklyFlattenWindow(clock(), offset)) {
        logUser(cycle, userId, '停止处理：MT5 周六00:00任务窗口已经结束')
        return { status: 'window_ended', cycle, failures }
      }
      if (!lockOwned) throw new Error('weekly_flatten_lock_lost')
      logUser(cycle, userId, `开始取消系统挂单：品种=${order.symbol || '未知'}，ticket=${order.ticket}`)
      const result = await sendBridgeCommand(userId, 'cancel_system_pending', {
        ticket:order.ticket,
        expected_state:inventoryExpectedState(order),
      }, 15000, { noFallback: true })
      const ok = result?.status === 'success'
      logUser(cycle, userId, `${ok ? '系统挂单取消成功' : '系统挂单取消失败'}：品种=${order.symbol || '未知'}，ticket=${order.ticket}${ok ? '' : `，原因=${result?.message || result?.status || '未知'}`}`)
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
      logUser(cycle, userId, `终止平仓：检测到净持仓账户，剩余系统持仓 ${positions.length} 笔`)
      const result = { status: 'unsupported_netting', cycle, account: before.account, position_count: positions.length }
      await reportOnce(redis, `${doneKey}:netting:reported`, COMPLETED_TTL_SECONDS, async () => {
        await audit(userId, 'weekly_flatten_unsupported_netting', null,
          { cycle, magic: SYSTEM_MAGIC, account: before.account }, result, 'error')
        await notify(userId, 'failed', { cycle, reason: 'unsupported_netting', remaining_positions: positions.length })
      })
      return result
    }

    for (const position of positions) {
      if (!isWeeklyFlattenWindow(clock(), offset)) {
        logUser(cycle, userId, '停止处理：MT5 周六00:00任务窗口已经结束')
        return { status: 'window_ended', cycle, failures }
      }
      if (!lockOwned) throw new Error('weekly_flatten_lock_lost')
      logUser(cycle, userId, `开始平掉系统持仓：品种=${position.symbol || '未知'}，ticket=${position.ticket}，手数=${position.volume ?? '未知'}`)
      const result = await sendBridgeCommand(userId, 'close_system_position', {
        ticket:position.ticket,
        expected_state:inventoryExpectedState(position),
      }, 15000, { noFallback: true })
      const ok = result?.status === 'success'
      logUser(cycle, userId, `${ok ? '系统持仓平仓成功' : '系统持仓平仓失败'}：品种=${position.symbol || '未知'}，ticket=${position.ticket}${ok ? '' : `，原因=${result?.message || result?.status || '未知'}`}`)
      if (!ok) failures.push({ kind: 'position', ticket: position.ticket, result })
      await audit(userId, ok ? 'weekly_position_closed' : 'weekly_flatten_retry', position.symbol,
        { cycle, ticket: position.ticket, volume: position.volume, magic: SYSTEM_MAGIC }, result, ok ? 'success' : 'error')
    }

    if (!isWeeklyFlattenWindow(clock(), offset)) {
      logUser(cycle, userId, '停止处理：MT5 周六00:00任务窗口已经结束')
      return { status: 'window_ended', cycle, failures }
    }
    logUser(cycle, userId, '正在复核清理结果')
    const after = await inventory(userId)
    if (!after || after.status !== 'success') {
      logUser(cycle, userId, `清理结果复核失败：${after?.message || after?.status || '桥接无响应'}`)
      const result = { status: 'failed', reason: 'verification_unavailable', failures, cycle }
      await reportOnce(redis, `${doneKey}:verification:reported`, 300, async () => {
        await audit(userId, 'weekly_flatten_retry', null, { cycle, stage: 'verification' }, result, 'error')
        await notify(userId, 'retrying', { cycle, reason: 'verification_unavailable' })
      })
      return result
    }

    const remainingPending = Array.isArray(after.pending_orders) ? after.pending_orders : []
    const remainingPositions = Array.isArray(after.positions) ? after.positions : []
    logUser(cycle, userId, `清理结果复核完成：剩余系统挂单 ${remainingPending.length} 笔，剩余系统持仓 ${remainingPositions.length} 笔`)
    if (remainingPending.length === 0 && remainingPositions.length === 0) {
      const result = { status: 'completed', cycle, duration_ms: Date.now() - startedAt }
      await redis.set(doneKey, JSON.stringify({ completed_at: new Date().toISOString() }), 'EX', COMPLETED_TTL_SECONDS)
      await audit(userId, 'weekly_flatten_completed', null,
        { cycle, magic: SYSTEM_MAGIC }, result, 'success')
      await notify(userId, 'completed', { cycle })
      logUser(cycle, userId, `账户处理完成，耗时 ${result.duration_ms}ms`)
      return result
    }

    const result = {
      status: 'partial', cycle, failures,
      remaining_pending: remainingPending.map(item => item.ticket),
      remaining_positions: remainingPositions.map(item => item.ticket),
    }
    await reportOnce(redis, `${doneKey}:partial:reported`, 300, async () => {
      await audit(userId, 'weekly_flatten_partial', null,
        { cycle, magic: SYSTEM_MAGIC }, result, 'warning')
      await notify(userId, 'retrying', {
        cycle,
        reason: 'positions_remaining',
        remaining_pending: remainingPending.length,
        remaining_positions: remainingPositions.length,
      })
    })
    logUser(cycle, userId, `账户处理未完成：剩余系统挂单 ${remainingPending.length} 笔，剩余系统持仓 ${remainingPositions.length} 笔，等待下轮重试`)
    return result
  } catch (err) {
    logUser(cycle, userId, `账户处理异常：${err.message}`)
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
  if (running) return { status: 'already_running', users: [] }

  const users = getAllBridges().filter(item => item.connected && item.alive)
    .map(item => ({ ...item, clock:getPlatformMarketClockState(item.userId) }))
    .map(item => ({ ...item, timezoneOffsetMinutes:terminalClockOffset(item.clock) }))
    .filter(item => isWeeklyFlattenWindow(now, item.timezoneOffsetMinutes))
  if (!users.length) return { status: 'outside_window', users: [] }
  const cycle = weeklyFlattenCycleId(now, users[0].timezoneOffsetMinutes)
  activeCycle = cycle
  const cycleStartedAt = Date.now()
  logCycle(cycle, `本轮扫描开始：在线桥接账户 ${users.length} 个，并发数 ${userConcurrency()}`)
  if (!getRedis() || !isRedisAvailable()) {
    logCycle(cycle, '本轮扫描终止：Redis 不可用')
    for (const item of users) rememberLocalResult(cycle, item.userId, { status: 'redis_unavailable', cycle })
    return { status: 'redis_unavailable', users: [] }
  }

  running = true
  try {
    const results = await mapWithConcurrency(users, userConcurrency(), async item => {
      try {
        const result = await runTrackedUserFlatten(
          item.userId, now, () => new Date(), item.timezoneOffsetMinutes)
        return { userId: item.userId, result }
      } catch (err) {
        console.error(`[WeeklyFlatten] Unhandled user failure user=${item.userId}:`, err.message)
        const result = { status: 'failed', error: err.message, cycle }
        await rememberCycleResult(cycle, item.userId, result)
        return { userId: item.userId, result }
      }
    })
    const completed = results.filter(item => ['completed', 'already_completed'].includes(item.result?.status)).length
    const pending = results.length - completed
    logCycle(cycle, `本轮扫描结束：账户总数 ${results.length}，已完成 ${completed}，待处理 ${pending}，耗时 ${Date.now() - cycleStartedAt}ms`)
    return { status: 'completed', users: results }
  } finally {
    running = false
  }
}

export async function finalizeWeeklyFlattenCycle(cycle) {
  if (!cycle) return { status: 'no_cycle', users: [] }

  logCycle(cycle, 'MT5 周六00:00任务窗口结束，开始汇总最终状态')

  if (activeUserRuns.size > 0) {
    await Promise.allSettled([...activeUserRuns])
  }

  const states = new Map(localCycleStates.get(cycle) || [])
  const redis = getRedis()
  let redisStatesLoaded = !redis || !isRedisAvailable()
  if (redis && isRedisAvailable()) {
    try {
      if (await redis.get(cycleFinalizedKey(cycle))) {
        localCycleStates.delete(cycle)
        if (activeCycle === cycle) activeCycle = null
        return { status: 'already_finalized', users: [] }
      }
      const userIds = await redis.smembers(cycleUsersKey(cycle))
      for (const rawUserId of userIds || []) {
        const userId = Number(rawUserId)
        if (!Number.isInteger(userId)) continue
        const rawState = await redis.get(cycleStateKey(userId, cycle))
        if (!rawState) {
          if (!states.has(userId)) {
            states.set(userId, { status: 'unknown', reason: 'missing_persisted_state' })
          }
          continue
        }
        try {
          states.set(userId, JSON.parse(rawState))
        } catch {
          if (!states.has(userId)) {
            states.set(userId, { status: 'unknown', reason: 'invalid_persisted_state' })
          }
        }
      }
      redisStatesLoaded = true
    } catch (err) {
      console.error(`[WeeklyFlatten] Failed to load deadline states cycle=${cycle}:`, err.message)
    }
  }

  const results = []
  let auditsComplete = true
  for (const [userId, lastResult] of states) {
    if (lastResult?.status === 'completed' || lastResult?.status === 'already_completed') {
      results.push({ userId, status: 'completed' })
      continue
    }
    const result = { status: 'failed', reason: 'deadline_reached', cycle, last_result: lastResult || null }
    const audited = await audit(userId, 'weekly_flatten_deadline_ended', null, { cycle, magic: SYSTEM_MAGIC }, result, 'error')
    if (!audited) auditsComplete = false
    await notify(userId, 'failed', { cycle, reason: 'deadline_reached' })
    results.push({ userId, status: 'failed' })
  }

  localCycleStates.delete(cycle)
  if (activeCycle === cycle) activeCycle = null
  if (auditsComplete && redisStatesLoaded && redis && isRedisAvailable()) {
    try {
      await redis.set(cycleFinalizedKey(cycle), JSON.stringify({ finalized_at: new Date().toISOString() }), 'EX', COMPLETED_TTL_SECONDS)
    } catch (err) {
      console.error(`[WeeklyFlatten] Failed to persist deadline finalization cycle=${cycle}:`, err.message)
    }
  }
  const failed = results.filter(item => item.status === 'failed').length
  logCycle(cycle, `最终状态汇总完成：账户总数 ${results.length}，失败 ${failed}`)
  return { status: 'finalized', users: results }
}

function scheduleNext(now = new Date()) {
  if (timer) clearTimeout(timer)
  const anyActive = getAllBridges().some(item => {
    const clock = getPlatformMarketClockState(item.userId)
    const offset = terminalClockOffset(clock)
    return item.connected && item.alive
      && isWeeklyFlattenWindow(now, offset)
  })
  const delay = anyActive ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS
  timer = setTimeout(async () => {
    timer = null
    await runWeeklySystemFlatten().catch(err => console.error('[WeeklyFlatten] Cycle failed:', err.message))
    const afterRun = new Date()
    const stillActive = getAllBridges().some(item => {
      const clock = getPlatformMarketClockState(item.userId)
      const offset = terminalClockOffset(clock)
      return item.connected && item.alive
        && isWeeklyFlattenWindow(afterRun, offset)
    })
    if (activeCycle && !stillActive) {
      await finalizeWeeklyFlattenCycle(activeCycle).catch(err => console.error('[WeeklyFlatten] Deadline finalize failed:', err.message))
    }
    scheduleNext(afterRun)
  }, delay)
  timer.unref?.()
}

export async function triggerWeeklySystemFlattenForUser(userId, now = new Date()) {
  const clock = getPlatformMarketClockState(userId)
  const offset = terminalClockOffset(clock)
  if (offset == null) return { status:'terminal_clock_unverified' }
  if (!isWeeklyFlattenWindow(now, offset)) return { status: 'outside_window' }
  return runTrackedUserFlatten(userId, now, () => new Date(), offset)
}

export function startWeeklySystemFlatten(now = new Date()) {
  if (timer || !weeklyFlattenEnabled()) return
  runWeeklySystemFlatten(now).catch(err => console.error('[WeeklyFlatten] Startup run failed:', err.message))
  scheduleNext(now)
  console.log('[WeeklyFlatten] Scheduled: Friday 23:00-Saturday 00:00 per terminal server time')
}

export function stopWeeklySystemFlatten() {
  if (timer) clearTimeout(timer)
  timer = null
}

export const __weeklyFlattenTest = {
  lockKey, completedKey, cycleUsersKey, cycleStateKey, mapWithConcurrency,
  cycleFinalizedKey, rememberLocalResult, rememberCycleResult, runTrackedUserFlatten,
  REMEMBER_CYCLE_RESULT_LUA, SYSTEM_MAGIC,
}
