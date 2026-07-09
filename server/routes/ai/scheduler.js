// ai/scheduler.js — 统一自动调度 + 智能平仓

import { queryOne, queryAll, queryRun, beijingNow } from '../../db.js'
import { DEFAULT_API_BASE_URL } from '../../config.js'
import { getOwnBridgeMarketState, isBridgeAlive, isTradeEnabled, sendToBrowsers, getAllBridges } from '../../bridge-ws.js'
import { mt5Bridge, calculateMarketData } from './market-data.js'
import { maybeAiSignal } from './llm.js'
import { getGlobalAutoConfig, getCloseConfig, saveCloseConfig, insertAudit, signalOrderPayload, getExecuteRiskConfig, getActiveConfig, getAutoPromptTypeById, getAutoPromptTypes, getUnifiedAutoInferenceConfig, getAutoSubscribers, getDeliveryExecuteRiskConfig, parsePromptSymbols, executeOrderCore } from './config.js'
import { buildStrategyContextFromTags } from './strategy.js'
import { attachSignalTiming, signalTtlSeconds, stripTimeframeTags, round2, parseTimeframeTags } from './utils.js'
import { getRedis, isRedisAvailable } from '../../redis.js'
import crypto from 'crypto'

// === Unified Scheduler State ===
// Key: "promptTypeId:symbol"
export const autoSchedulerState = {}
export const closeSchedulerState = {}

function normalizeSymbolForScheduler(sym) {
  // Strip broker suffixes: .s/.c/.pro/.std/.z/.ecn/m so XAUUSD.s -> XAUUSD
  return String(sym).toUpperCase().replace(/\.?(S|C|PRO|STD|Z|ECN|M)$/i, '')
}

function buildSchedulerKey(promptTypeId, symbol) {
  return `${promptTypeId}:${normalizeSymbolForScheduler(symbol)}`
}

// === Redis Subscription Keys ===
const REDIS_SCHEDULER_KEYS = 'auto:scheduler:keys'
const REDIS_SUBS_PREFIX = 'auto:scheduler:'
const REDIS_SUBS_SUFFIX = ':subs'
const REDIS_USER_PREFIX = 'auto:user:'
const REDIS_USER_SUFFIX = ':auto'

// === Redis Subscription Helpers ===
export async function syncUserRedisSubscription(userId, promptTypeId, symbols, enabled) {
  const redis = getRedis()
  if (!redis) return

  try {
    const userKey = `${REDIS_USER_PREFIX}${userId}${REDIS_USER_SUFFIX}`

    // Remove old subscriptions for this user
    const oldKeys = await redis.smembers(REDIS_SCHEDULER_KEYS)
    for (const k of oldKeys) {
      await redis.srem(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`, userId)
    }

    if (!enabled || !promptTypeId || !symbols || symbols.length === 0) {
      await redis.del(userKey)
      // Clean up empty subs sets
      for (const k of oldKeys) {
        const count = await redis.scard(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
        if (count === 0) {
          await redis.del(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
          await redis.del(`${REDIS_SUBS_PREFIX}${k}:state`)
          await redis.srem(REDIS_SCHEDULER_KEYS, k)
        }
      }
      return
    }

    // Write user config
    await redis.hset(userKey, {
      prompt_type_id: String(promptTypeId),
      selected_symbols: JSON.stringify(symbols),
      enabled: '1'
    })

    // Add new subscriptions
    for (const sym of symbols) {
      const k = buildSchedulerKey(promptTypeId, sym)
      await redis.sadd(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`, userId)
      await redis.sadd(REDIS_SCHEDULER_KEYS, k)
    }

    // Clean up empty subs sets
    for (const k of oldKeys) {
      const count = await redis.scard(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
      if (count === 0) {
        await redis.del(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
        await redis.del(`${REDIS_SUBS_PREFIX}${k}:state`)
        await redis.srem(REDIS_SCHEDULER_KEYS, k)
      }
    }
  } catch (e) {
    console.error('[Redis] syncUserRedisSubscription error:', e.message)
  }
}

export async function rebuildRedisSubscriptions() {
  const redis = getRedis()
  if (!redis) return

  try {
    // Clear all existing subscription data
    const oldKeys = await redis.smembers(REDIS_SCHEDULER_KEYS)
    for (const k of oldKeys) {
      await redis.del(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
      await redis.del(`${REDIS_SUBS_PREFIX}${k}:state`)
    }
    await redis.del(REDIS_SCHEDULER_KEYS)

    // Query all enabled users from DB
    const rows = await queryAll(`
      SELECT s.user_id, s.prompt_type_id, apt.symbols_json
      FROM auto_scheduler s
      JOIN auto_prompt_types apt ON apt.id = s.prompt_type_id
      JOIN users u ON u.id = s.user_id
      WHERE s.enabled = 1 AND s.prompt_type_id IS NOT NULL AND u.plan = 'pro'
    `)

    let onlineCount = 0
    for (const row of rows) {
      // Only add to runtime subs if bridge is online
      if (!isBridgeAlive(row.user_id)) continue

      let userSymbols = []
      try { userSymbols = JSON.parse(row.symbols_json || '[]') } catch (e) { console.warn('[Scheduler] Failed to parse user symbols:', e.message) }
      if (userSymbols.length === 0) continue

      const userKey = `${REDIS_USER_PREFIX}${row.user_id}${REDIS_USER_SUFFIX}`
      await redis.hset(userKey, {
        prompt_type_id: String(row.prompt_type_id),
        selected_symbols: JSON.stringify(userSymbols),
        enabled: '1'
      })

      for (const sym of userSymbols) {
        const k = buildSchedulerKey(row.prompt_type_id, sym)
        await redis.sadd(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`, row.user_id)
        await redis.sadd(REDIS_SCHEDULER_KEYS, k)
      }
      onlineCount++
    }

    const keysCount = await redis.scard(REDIS_SCHEDULER_KEYS)
    console.log(`[Redis] Rebuilt subscription index: ${keysCount} scheduler keys, ${onlineCount} online users (of ${rows.length} configured)`)
  } catch (e) {
    console.error('[Redis] rebuildRedisSubscriptions error:', e.message)
  }
}

export async function updateSchedulerRedisState(key, state) {
  const redis = getRedis()
  if (!redis) return

  try {
    const fields = {
      running: state.running ? '1' : '0',
      in_flight: state.inFlight ? '1' : '0',
      interval_minutes: String(state.intervalMinutes || 5),
      subscriber_count: String(state.subscriberCount || 0),
      last_error: state.lastError || '',
      wait_reason: state.waitReason || '',
      next_run_in_seconds: String(state.nextRunInSeconds || 0),
      last_run_at: state.lastRunAt || ''
    }
    if (state.marketState) {
      fields.market_reason = state.marketState.reason || ''
      fields.market_trade_mode = String(state.marketState.tradeMode ?? -1)
      fields.market_tick_age_ms = String(state.marketState.tickAgeMs ?? '')
      fields.market_mt5_time = state.marketState.mt5TimeStr || ''
    }
    await redis.hset(`${REDIS_SUBS_PREFIX}${key}:state`, fields)
  } catch (e) { console.error('[updateSchedulerRedisState]', key, e.message) }
}

// === Compatibility: isAutoSchedulerRunning(userId) ===
export function isAutoSchedulerRunning(userId) {
  for (const key in autoSchedulerState) {
    const st = autoSchedulerState[key]
    if (st?.subscribers?.has(userId) && st.running) return true
  }
  return false
}

// === Remove user from runtime subscriptions (bridge disconnect) ===
export async function removeUserRuntimeAutoSubscription(userId) {
  const redis = getRedis()
  try {
    // Remove from Redis
    if (redis) {
      const keys = await redis.smembers(REDIS_SCHEDULER_KEYS)
      for (const k of keys) {
        await redis.srem(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`, userId)
        // Clean up empty sets
        const count = await redis.scard(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
        if (count === 0) {
          await redis.del(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
          await redis.del(`${REDIS_SUBS_PREFIX}${k}:state`)
          await redis.srem(REDIS_SCHEDULER_KEYS, k)
        }
      }
      await redis.del(`${REDIS_USER_PREFIX}${userId}${REDIS_USER_SUFFIX}`)
    }

    // Remove from memory subscribers
    for (const key of Object.keys(autoSchedulerState)) {
      const st = autoSchedulerState[key]
      if (st?.subscribers?.has(userId)) {
        st.subscribers.delete(userId)
        st.subscriberCount = st.subscribers.size
        // Stop scheduler if no subscribers left
        if (st.subscribers.size === 0) {
          await stopUnifiedScheduler(st.promptTypeId, st.symbol)
        } else if (redis) {
          await updateSchedulerRedisState(key, st)
        }
      }
    }
  } catch (e) {
    console.error('[removeUserRuntimeAutoSubscription] Error:', e.message)
  }
}

// === User Auto Runtime Status ===
export async function getUserAutoRuntimeStatus(userId) {
  const scheduler = await queryOne('SELECT * FROM auto_scheduler WHERE user_id = ?', [userId])
  if (!scheduler || !scheduler.enabled) {
    return { enabled: false, running: false, paused_reason: 'disabled', prompt_type_id: null, prompt_type_name: '', selected_symbols: [], active_scheduler_keys: [], subscriber_count: 0, in_flight: false, stage: 'idle', last_error: '', next_run_in_seconds: 0, last_run_at: '', last_signal_id: null, admin_bridge_online: false, market_state: { isOpen: false, reason: 'unknown' }, redis_available: false }
  }

  let selectedSymbols = []
  let promptTypeName = ''
  if (scheduler.prompt_type_id) {
    const pt = await getAutoPromptTypeById(scheduler.prompt_type_id)
    if (pt) {
      promptTypeName = pt.title || ''
      try { selectedSymbols = JSON.parse(pt.symbols_json || '[]') } catch (e) { console.warn('[Scheduler] Failed to parse prompt type symbols:', e.message) }
    }
  }

  const redis = getRedis()
  const redisAvailable = !!redis && isRedisAvailable()
  const adminUserId = await getActiveAdminBridgeUserId()
  const adminBridgeOnline = !!adminUserId
  const marketState = adminUserId ? getOwnBridgeMarketState(adminUserId) : { alive: false, isOpen: false, tradeMode: -1, reason: 'bridge_offline', lastTickMs: null, tickAgeMs: null, mt5TimeStr: null }

  // Find user's active scheduler keys
  const activeKeys = []
  let earliestNextRun = Infinity
  let anyInFlight = false
  let overallLastError = ''
  let overallWaitReason = ''
  let overallLastRunAt = ''
  let overallLastSignalId = null
  let totalSubscribers = 0

  for (const sym of selectedSymbols) {
    const key = buildSchedulerKey(scheduler.prompt_type_id, sym)
    const st = autoSchedulerState[key]
    if (!st || !st.subscribers || !st.subscribers.has(userId)) {
      continue
    }
    activeKeys.push(key)
    totalSubscribers += st.subscribers.size
    if (st.inFlight) anyInFlight = true
    if (st.lastError) overallLastError = st.lastError
    if (st.waitReason && !overallWaitReason) overallWaitReason = st.waitReason
    if (st.lastRunAt && (!overallLastRunAt || st.lastRunAt > overallLastRunAt)) overallLastRunAt = st.lastRunAt
    if (st.lastSignalId) overallLastSignalId = st.lastSignalId

    // Check cooldown TTL
    if (redis) {
      try {
        const ttl = await redis.ttl(`${REDIS_COOLDOWN_PREFIX}${key}`)
        if (ttl > 0 && ttl < earliestNextRun) earliestNextRun = ttl
      } catch {}
    }
  }

  // Determine paused reason — only real errors/blockers, not normal cooldown
  let pausedReason = ''
  if (!scheduler.prompt_type_id) pausedReason = 'no_strategy'
  else if (selectedSymbols.length === 0) pausedReason = 'no_symbols'
  else if (activeKeys.length === 0) {
    const userBridgeAlive = isBridgeAlive(userId)
    if (!userBridgeAlive) pausedReason = 'user_bridge_offline'
    else pausedReason = 'no_runtime_scheduler'
  }
  else if (!adminBridgeOnline) pausedReason = 'admin_bridge_offline'
  else if (!marketState.isOpen) pausedReason = marketState.reason
  else if (!redisAvailable) pausedReason = 'redis_unavailable'
  else if (overallLastError && !anyInFlight) pausedReason = overallLastError

  const running = activeKeys.length > 0 && !pausedReason
  const nextRunSeconds = earliestNextRun === Infinity ? 0 : Math.max(0, earliestNextRun)

  return {
    enabled: true,
    running,
    prompt_type_id: scheduler.prompt_type_id,
    prompt_type_name: promptTypeName,
    selected_symbols: selectedSymbols,
    active_scheduler_keys: activeKeys,
    subscriber_count: totalSubscribers,
    in_flight: anyInFlight,
    stage: anyInFlight ? 'running' : (pausedReason ? 'paused' : 'idle'),
    last_error: overallLastError,
    wait_reason: overallWaitReason,
    paused_reason: pausedReason,
    next_run_in_seconds: nextRunSeconds,
    last_run_at: overallLastRunAt,
    last_signal_id: overallLastSignalId,
    admin_bridge_online: adminBridgeOnline,
    market_state: marketState,
    redis_available: redisAvailable,
  }
}

// === Redis Lock Helpers ===
const REDIS_LOCK_PREFIX = 'auto:scheduler:lock:'
const REDIS_COOLDOWN_PREFIX = 'auto:scheduler:cooldown:'

async function acquireLock(key) {
  const redis = getRedis()
  if (!redis) { console.warn(`[acquireLock] ${key}: Redis unavailable`); return null }
  const token = crypto.randomUUID()
  try {
    const ok = await redis.set(`${REDIS_LOCK_PREFIX}${key}`, token, 'NX', 'PX', 600000)
    if (!ok) console.warn(`[acquireLock] ${key}: lock already held`)
    return ok ? token : null
  } catch (e) { console.error('[acquireLock]', key, e.message); return null }
}

async function releaseLock(key, token) {
  const redis = getRedis()
  if (!redis || !token) return
  try {
    const current = await redis.get(`${REDIS_LOCK_PREFIX}${key}`)
    if (current === token) await redis.del(`${REDIS_LOCK_PREFIX}${key}`)
  } catch (e) { console.error('[releaseLock]', key, e.message) }
}

async function setCooldown(key, intervalSeconds) {
  const redis = getRedis()
  if (!redis) return false
  try {
    await redis.set(`${REDIS_COOLDOWN_PREFIX}${key}`, '1', 'EX', intervalSeconds)
    return true
  } catch (e) { console.error('[setCooldown]', key, e.message); return false }
}

function retryDelayMs(reason) {
  switch (reason) {
    case 'admin_bridge_offline':
    case 'market_closed':
    case 'market_stale_tick':
    case 'market_unknown_no_tick':
    case 'market_unknown':
    case 'redis_unavailable':
      return 5000
    case 'rates_failed':
    case 'rates_empty':
    case 'exception':
      return 20000
    case 'no_api_key':
    case 'strategy_disabled':
    case 'symbol_not_supported':
      return 45000
    default:
      return 15000
  }
}

// === Admin Bridge ===
async function getActiveAdminBridgeUserId() {
  const bridges = getAllBridges()
  const adminBridges = bridges.filter(b => b.connected && b.alive)
    .sort((a, b) => a.userId - b.userId)
  if (adminBridges.length === 0) return null
  // Check if any is actually admin role
  for (const b of adminBridges) {
    const user = await queryOne('SELECT role FROM users WHERE id = ?', [b.userId])
    if (user?.role === 'admin') return b.userId
  }
  return null
}

// === Broadcast progress to all subscribers ===
function broadcastAutoProgress(promptTypeId, symbol, progress) {
  for (const key in autoSchedulerState) {
    const st = autoSchedulerState[key]
    if (st.promptTypeId === promptTypeId && st.symbol === symbol && st.subscribers) {
      for (const uid of st.subscribers) {
        try { sendToBrowsers(uid, { type: 'auto_progress', ...progress }) } catch {}
      }
      break
    }
  }
}

function broadcastAutoProgressDone(promptTypeId, symbol, status, reason, schedulerState) {
  for (const key in autoSchedulerState) {
    const st = autoSchedulerState[key]
    if (st.promptTypeId === promptTypeId && st.symbol === symbol && st.subscribers) {
      for (const uid of st.subscribers) {
        try {
          sendToBrowsers(uid, {
            type: 'auto_progress_done',
            status,
            reason,
            prompt_type_id: promptTypeId,
            symbol,
            next_run_in_seconds: status === 'success' ? (st.intervalMinutes || 5) * 60 : Math.round(retryDelayMs(reason) / 1000),
          })
        } catch (e) { console.warn('[Scheduler] Failed to send progress_done to browser:', e.message) }
      }
    }
  }
}

// === Reconcile: start/stop schedulers based on DB state ===
export async function reconcileAutoSchedulers() {
  try {
    // Auto-assign first strategy to users with enabled=1 but prompt_type_id=NULL
    const unassigned = await queryAll(`
      SELECT s.user_id FROM auto_scheduler s
      JOIN users u ON u.id = s.user_id
      WHERE s.enabled = 1 AND s.prompt_type_id IS NULL AND u.plan = 'pro'
    `)
    if (unassigned.length > 0) {
      const allPt = await getAutoPromptTypes()
      if (allPt.length > 0) {
        const firstPt = allPt[0]
        const symbols = parsePromptSymbols(firstPt.symbols_json || '[]')
        for (const row of unassigned) {
          await queryRun('UPDATE auto_scheduler SET prompt_type_id = ? WHERE user_id = ? AND prompt_type_id IS NULL',
            [firstPt.id, row.user_id])
          console.log(`[Reconciler] Auto-assigned strategy ${firstPt.id} to user ${row.user_id}`)
        }
      }
    }

    const rows = await queryAll(`
      SELECT
        s.prompt_type_id,
        apt.symbols_json,
        apt.interval_minutes
      FROM auto_scheduler s
      JOIN auto_prompt_types apt ON apt.id = s.prompt_type_id
      JOIN users u ON u.id = s.user_id
      WHERE s.enabled = 1
        AND apt.is_active = 1
        AND apt.deleted_at IS NULL
        AND u.plan = 'pro'
    `)

    const neededKeys = new Set()
    const neededKeyMeta = {}

    for (const row of rows) {
      const symbols = parsePromptSymbols(row.symbols_json || '[]')
      for (const sym of symbols) {
        const k = buildSchedulerKey(row.prompt_type_id, sym)
        neededKeys.add(k)
        neededKeyMeta[k] = { promptTypeId: row.prompt_type_id, symbol: sym, intervalMinutes: row.interval_minutes || 5 }
      }
    }

    // Stop schedulers no longer needed
    for (const key of Object.keys(autoSchedulerState)) {
      if (!neededKeys.has(key)) {
        await stopUnifiedScheduler(autoSchedulerState[key].promptTypeId, autoSchedulerState[key].symbol)
      }
    }

    // Start or update schedulers
    for (const k of neededKeys) {
      const meta = neededKeyMeta[k]
      if (autoSchedulerState[k]) {
        autoSchedulerState[k].intervalMinutes = meta.intervalMinutes
        autoSchedulerState[k].subscriberCount = autoSchedulerState[k].subscribers?.size || 0
        await updateSchedulerRedisState(k, autoSchedulerState[k])
      } else {
        await startUnifiedScheduler(meta.promptTypeId, meta.symbol, meta.intervalMinutes)
      }
    }
  } catch (e) {
    console.error('[reconcileAutoSchedulers] Error:', e.message)
  }
}

// === Unified Scheduler Start/Stop ===
async function startUnifiedScheduler(promptTypeId, symbol, intervalMinutes = 5) {
  const key = buildSchedulerKey(promptTypeId, symbol)
  if (autoSchedulerState[key]?.running) return

  const subscribers = await getAutoSubscribers(promptTypeId, symbol, isBridgeAlive)
  if (subscribers.length === 0) return

  const subSet = new Set(subscribers.map(s => s.user_id))
  const intervalMs = intervalMinutes * 60_000
  const tickIntervalMs = 5000 // tick every 5s for Redis lock check

  autoSchedulerState[key] = {
    key,
    promptTypeId,
    symbol,
    intervalMinutes,
    running: true,
    timer: null,
    inFlight: false,
    lastRunAt: null,
    lastError: null,
    waitReason: '',
    nextRunInSeconds: 0,
    subscriberCount: subSet.size,
    subscribers: subSet,
    _waitCount: 0,
  }

  console.log(`[UnifiedScheduler] Started ${key} (subscribers=${subSet.size}, interval=${intervalMinutes}min)`)
  await updateSchedulerRedisState(key, autoSchedulerState[key])

  const tick = async () => {
    const st = autoSchedulerState[key]
    if (!st?.running) return

    // Refresh subscribers
    try {
      const freshSubs = await getAutoSubscribers(promptTypeId, symbol, isBridgeAlive)
      st.subscribers = new Set(freshSubs.map(s => s.user_id))
      st.subscriberCount = st.subscribers.size
      if (st.subscribers.size === 0) {
        console.log(`[UnifiedScheduler] No subscribers for ${key}, stopping`)
        await stopUnifiedScheduler(promptTypeId, symbol)
        return
      }
    } catch (e) { console.error(`[UnifiedScheduler] ${key} subscriber refresh failed:`, e.message) }

    // Check admin bridge
    const adminUserId = await getActiveAdminBridgeUserId()
    if (!adminUserId) {
      st._waitCount = (st._waitCount || 0) + 1
      if (st._waitCount === 1 || st._waitCount % 10 === 0) {
        console.log(`[UnifiedScheduler] ${key}: admin bridge offline, pausing (retry#${st._waitCount})`)
      }
      st.lastError = null
      st.waitReason = 'admin_bridge_offline'
      const delay = retryDelayMs('admin_bridge_offline')
      st.nextRunInSeconds = Math.round(delay / 1000)
      await updateSchedulerRedisState(key, st)
      autoSchedulerState[key].timer = setTimeout(tick, delay)
      return
    }

    // Check admin market status
    const marketState = getOwnBridgeMarketState(adminUserId)
    if (!marketState.isOpen) {
      st._waitCount = (st._waitCount || 0) + 1
      if (st._waitCount === 1 || st._waitCount % 10 === 0) {
        console.log(`[UnifiedScheduler] ${key}: ${marketState.reason}, pausing (retry#${st._waitCount})`)
      }
      st.lastError = null
      st.waitReason = marketState.reason
      st.marketState = marketState
      const delay = retryDelayMs(marketState.reason)
      st.nextRunInSeconds = Math.round(delay / 1000)
      await updateSchedulerRedisState(key, st)
      autoSchedulerState[key].timer = setTimeout(tick, delay)
      return
    }

    st._waitCount = 0
    st.lastError = null
    st.waitReason = ''

    // Preflight: check API key and strategy
    const ptRow = await getAutoPromptTypeById(promptTypeId)
    if (!ptRow || !ptRow.is_active) {
      st.lastError = 'strategy_disabled'
      st.waitReason = ''
      const delay = retryDelayMs('strategy_disabled')
      st.nextRunInSeconds = Math.round(delay / 1000)
      await updateSchedulerRedisState(key, st)
      autoSchedulerState[key].timer = setTimeout(tick, delay)
      return
    }
    // Check API key
    const globalCfg = await getGlobalAutoConfig()
    if (!globalCfg?.api_key_encrypted) {
      st.lastError = 'no_api_key'
      st.waitReason = ''
      const delay = retryDelayMs('no_api_key')
      st.nextRunInSeconds = Math.round(delay / 1000)
      await updateSchedulerRedisState(key, st)
      autoSchedulerState[key].timer = setTimeout(tick, delay)
      return
    }

    // Redis lock + cooldown — fail closed when Redis unavailable
    const redis = getRedis()
    if (!redis || !isRedisAvailable()) {
      st._waitCount = (st._waitCount || 0) + 1
      if (st._waitCount === 1 || st._waitCount % 10 === 0) {
        console.log(`[UnifiedScheduler] ${key}: Redis unavailable, pausing (retry#${st._waitCount})`)
      }
      st.lastError = null
      st.waitReason = 'redis_unavailable'
      const delay = retryDelayMs('redis_unavailable')
      st.nextRunInSeconds = Math.round(delay / 1000)
      await updateSchedulerRedisState(key, st)
      autoSchedulerState[key].timer = setTimeout(tick, delay)
      return
    }

    // Check cooldown TTL — skip if still active
    try {
      const ttl = await redis.ttl(`${REDIS_COOLDOWN_PREFIX}${key}`)
      if (ttl > 0) {
        st.nextRunInSeconds = ttl
        st.waitReason = 'cooldown'
        await updateSchedulerRedisState(key, st)
        autoSchedulerState[key].timer = setTimeout(tick, Math.min(ttl * 1000, tickIntervalMs))
        return
      }
    } catch (e) { console.warn('[Scheduler] Redis TTL check failed:', e.message) }

    if (st.inFlight) {
      autoSchedulerState[key].timer = setTimeout(tick, tickIntervalMs)
      return
    }
    const lockToken = await acquireLock(key)
    if (!lockToken) {
      st.lastError = 'redis_lock_failed'
      autoSchedulerState[key].timer = setTimeout(tick, tickIntervalMs)
      return
    }
    st.inFlight = true
    st._lockToken = lockToken
    st.stage = 'running'
    st.lastError = ''
    st.waitReason = ''

    let cycleStatus = 'error'
    let cycleReason = 'exception'
    try {
      const cycleResult = await runUnifiedAutoCycle(promptTypeId, symbol)
      if (cycleResult?.status === 'success') {
        st.lastError = ''
        st.lastRunAt = cycleResult.createdAt
        st.lastSignalId = cycleResult.signalId
        st.subscriberCount = cycleResult.subscriberCount
        cycleStatus = 'success'
        await setCooldown(key, st.intervalMinutes * 60)
        st.nextRunInSeconds = st.intervalMinutes * 60
      } else if (cycleResult?.status === 'blocked') {
        st.lastError = cycleResult.reason
        cycleStatus = 'blocked'
        cycleReason = cycleResult.reason
        const delay = retryDelayMs(cycleReason)
        st.nextRunInSeconds = Math.round(delay / 1000)
        await setCooldown(key, Math.round(delay / 1000))
      } else {
        cycleReason = cycleResult?.reason || 'unknown'
        const delay = retryDelayMs(cycleReason)
        st.nextRunInSeconds = Math.round(delay / 1000)
        await setCooldown(key, Math.round(delay / 1000))
      }
    } catch (e) {
      console.error(`[UnifiedScheduler] ${key} cycle error:`, e.message)
      st.lastError = 'exception'
      cycleReason = 'exception'
      const delay = retryDelayMs('exception')
      st.nextRunInSeconds = Math.round(delay / 1000)
      await setCooldown(key, Math.round(delay / 1000))
    } finally {
      // Release lock BEFORE clearing inFlight to prevent TOCTOU race
      if (st._lockToken) {
        await releaseLock(key, st._lockToken)
        st._lockToken = null
      }
      st.inFlight = false
      st.stage = 'idle'
      await updateSchedulerRedisState(key, st)
    }

    // Broadcast progress done
    broadcastAutoProgressDone(promptTypeId, symbol, cycleStatus, cycleReason, st)

    if (autoSchedulerState[key]?.running) {
      const delay = cycleStatus === 'success' ? tickIntervalMs : retryDelayMs(cycleReason)
      autoSchedulerState[key].timer = setTimeout(tick, delay)
    }
  }

  autoSchedulerState[key].timer = setTimeout(tick, tickIntervalMs)
}

async function stopUnifiedScheduler(promptTypeId, symbol) {
  const key = buildSchedulerKey(promptTypeId, symbol)
  const state = autoSchedulerState[key]
  if (state?.timer) clearTimeout(state.timer)
  if (autoSchedulerState[key]) autoSchedulerState[key].running = false
  delete autoSchedulerState[key]
  console.log(`[UnifiedScheduler] Stopped ${key}`)
  await updateSchedulerRedisState(key, { running: false, intervalMinutes: 0, subscriberCount: 0, lastError: '', lastRunAt: '' })
}

// === Unified Auto Cycle: shared signal generation ===
async function runUnifiedAutoCycle(promptTypeId, symbol) {
  const key = buildSchedulerKey(promptTypeId, symbol)
  const ts = () => new Date().toISOString()
  const l = (msg) => console.log(`[UnifiedCycle ${key}] ${ts()} ${symbol}: ${msg}`)

  l('>>> cycle start')
  broadcastAutoProgress(promptTypeId, symbol, { stage: 'config', label: '检查配置...' })

  // 1. Read prompt type
  const pt = await getAutoPromptTypeById(promptTypeId)
  if (!pt || !pt.is_active) { l('BLOCKED: prompt type not found or disabled'); return { status: 'blocked', reason: 'strategy_disabled' } }
  const supportedSymbols = parsePromptSymbols(pt.symbols_json)
  if (!supportedSymbols.includes(symbol.toUpperCase())) { l(`BLOCKED: symbol ${symbol} not in strategy symbols`); return { status: 'blocked', reason: 'symbol_not_supported' } }

  // 2. Get unified config (model/API from global, prompt from strategy)
  const config = await getUnifiedAutoInferenceConfig(promptTypeId)
  if (!config || !config.api_key_encrypted) {
    l(`BLOCKED: no API key (hasKey=${!!config?.api_key_encrypted})`)
    return { status: 'blocked', reason: 'no_api_key' }
  }

  // 3. Check admin bridge
  const adminUserId = await getActiveAdminBridgeUserId()
  if (!adminUserId) { l('BLOCKED: admin bridge offline'); return { status: 'blocked', reason: 'admin_bridge_offline' } }

  const marketState = getOwnBridgeMarketState(adminUserId)
  if (!marketState.isOpen) {
    l(`BLOCKED: market not open (${marketState.reason}, tradeMode=${marketState.tradeMode}, tickAgeMs=${marketState.tickAgeMs})`)
    return { status: 'blocked', reason: marketState.reason }
  }

  try {
    broadcastAutoProgress(promptTypeId, symbol, { stage: 'bridge', label: '获取管理员行情数据...' })
    const t0 = Date.now()
    const [account, positionsData, pendingData] = await Promise.all([
      mt5Bridge(adminUserId, 'account', {}),
      mt5Bridge(adminUserId, 'positions', { symbol }),
      mt5Bridge(adminUserId, 'pending_list', { symbol }).catch(() => ({ orders: [] })),
    ])
    const positions = positionsData.positions || []
    const pendingOrders = pendingData.orders || pendingData.pending_list || []
    l(`bridge done (${Date.now()-t0}ms, positions=${positions.length}, pending=${pendingOrders.length})`)

    const prompt = config.system_prompt || ''
    const tags = parseTimeframeTags(prompt, 'auto')
    const primaryTf = tags.length > 0 ? tags[0].tf : 'M5'
    const usedTimeframes = tags.length > 0 ? tags.map(t => t.tf) : ['M5']
    const primaryCount = tags.length > 0 ? tags[0].count : 100
    const t1 = Date.now()
    const ratesResp = await mt5Bridge(adminUserId, 'rates', { symbol, timeframe: primaryTf, count: primaryCount })
    if (!ratesResp || ratesResp.status === 'error') { l(`BLOCKED: rates failed`); return { status: 'blocked', reason: 'rates_failed' } }
    const rates = ratesResp.rates || []
    if (!Array.isArray(rates) || rates.length === 0) { l(`BLOCKED: rates empty`); return { status: 'blocked', reason: 'rates_empty' } }
    l(`rates done (${Date.now()-t1}ms, bars=${rates.length}, tf=${primaryTf})`)

    broadcastAutoProgress(promptTypeId, symbol, { stage: 'market', label: '计算技术指标...' })
    const t2 = Date.now()
    const market = calculateMarketData(symbol, primaryTf, rates, account, positions, { pending_orders: pendingOrders })
    market.strategy_context = await buildStrategyContextFromTags(adminUserId, symbol, account, positions, prompt, primaryTf, rates, 'auto')
    market.primary_timeframe = primaryTf
    const actualUsedTimeframes = Object.keys(market.strategy_context?.timeframes || {})
    market.requested_timeframes = usedTimeframes
    market.used_timeframes = actualUsedTimeframes
    market.missing_timeframes = usedTimeframes.filter(tf => !actualUsedTimeframes.includes(tf))
    l(`market calc done (${Date.now()-t2}ms, price=${market.latest_price})`)

    broadcastAutoProgress(promptTypeId, symbol, { stage: 'ai', label: 'AI 模型推理中...' })
    const t3 = Date.now()
    l(`calling AI (model=${config.model_name})...`)
    const signal = await maybeAiSignal(null, config, market)
    market.inference_source = signal._inference_source || 'unknown'
    const aiSource = signal._inference_source
    delete signal._inference_source
    l(`AI done (${Date.now()-t3}ms, type=${signal.signal_type}, confidence=${signal.confidence}, source=${aiSource})`)

    // 4. Write shared signal to ai_signals
    const createdAt = beijingNow()
    const marketJson = JSON.stringify(market)
    const tokenCount = Math.round(((signal.analysis || '').length + (signal.reasoning || '').length + marketJson.length) / 4)
    const result = await queryRun(`
      INSERT INTO ai_signals(user_id, config_id, prompt_type_id, session_id, source, symbol, timeframe, signal_type, confidence,
        recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price,
        take_profit_2_price, take_profit_3_price, market_data_json, token_count, ai_model, ttl_seconds, is_executed, created_at,
        entry_method, limit_price, stop_limit_price, pending_valid_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `, [
      0, 0, promptTypeId, 'auto_shared', 'auto_shared', symbol, primaryTf,
      signal.signal_type, signal.confidence, signal.recommended_volume,
      signal.analysis, signal.reasoning, signal.stop_loss_price,
      signal.take_profit_1_price, signal.take_profit_2_price, signal.take_profit_3_price,
      marketJson, tokenCount, config.model_name || 'deepseek-chat', signalTtlSeconds(primaryTf), createdAt,
      signal.entry_method || 'market', signal.limit_price || null, signal.stop_limit_price || null, signal.pending_valid_until || null
    ])
    const signalId = result.insertId
    signal.id = signalId
    signal.symbol = symbol
    signal.timeframe = primaryTf
    signal.created_at = createdAt
    signal.market_data = market
    signal.is_executed = false
    signal.config_id = 0
    signal.session_id = 'auto_shared'
    signal.source = 'auto_shared'
    signal.prompt_type_id = promptTypeId
    signal.ai_model = config.model_name || 'deepseek-chat'
    attachSignalTiming(signal)
    l(`shared signal #${signalId} saved`)

    // 5. Filter subscribers by bridge alive
    const st = autoSchedulerState[key]
    const allSubscribers = st?.subscribers || new Set()
    const onlineSubscribers = new Set()
    for (const uid of allSubscribers) {
      if (isBridgeAlive(uid)) onlineSubscribers.add(uid)
    }

    // 6. Batch write deliveries + notify online subscribers only
    const deliveryValues = []
    const deliveryParams = []
    for (const uid of onlineSubscribers) {
      deliveryValues.push('(?, ?, ?, ?, ?, ?, ?, ?)')
      deliveryParams.push(signalId, uid, promptTypeId, symbol, 'delivered', 'not_attempted', 0, createdAt)
    }
    if (deliveryValues.length > 0) {
      await queryRun(
        `INSERT IGNORE INTO auto_signal_deliveries (signal_id, user_id, prompt_type_id, symbol, delivery_status, execution_status, is_executed, created_at)
         VALUES ${deliveryValues.join(',')}`,
        deliveryParams
      )
    }

    // 7. Notify online subscribers
    for (const uid of onlineSubscribers) {
      sendToBrowsers(uid, {
        type: 'new_signal',
        signal_id: signalId,
        signal_type: signal.signal_type,
        symbol,
        timeframe: primaryTf,
        confidence: signal.confidence,
        created_at: createdAt,
        source: 'auto_shared',
        prompt_type_id: promptTypeId,
      })
    }

    // 8. Auto-trade for eligible subscribers (limited concurrency)
    if (signal.signal_type !== 'hold' && aiSource === 'ai' && !signal.is_stale) {
      // Single JOIN query instead of N+1 per subscriber
      const onlineUserIds = [...onlineSubscribers]
      let eligibleSubs = []
      if (onlineUserIds.length > 0) {
        const placeholders = onlineUserIds.map(() => '?').join(',')
        const eligibleRows = await queryAll(`
          SELECT s.user_id, s.enable_auto_trade, s.prompt_type_id
          FROM auto_scheduler s
          JOIN users u ON u.id = s.user_id
          LEFT JOIN user_bridge_settings ubs ON ubs.user_id = s.user_id
          WHERE s.user_id IN (${placeholders})
            AND s.enabled = 1 AND s.enable_auto_trade = 1
            AND u.plan = 'pro'
            AND COALESCE(ubs.trade_send_enabled, 0) = 1
        `, onlineUserIds)
        const eligibleSet = new Set(eligibleRows.map(r => r.user_id))
        eligibleSubs = onlineUserIds.filter(uid => eligibleSet.has(uid) && isBridgeAlive(uid))
      }

      // Run with concurrency limit of 5
      const CONCURRENCY = 5
      for (let i = 0; i < eligibleSubs.length; i += CONCURRENCY) {
        const batch = eligibleSubs.slice(i, i + CONCURRENCY)
        await Promise.allSettled(batch.map(uid =>
          executeDelivery(uid, signalId, signal, config, market, promptTypeId, symbol, createdAt)
        ))
      }
    }

    // 8. Audit
    await insertAudit(null, adminUserId, 'ai_auto_scan', symbol, {
      trigger: 'timer', prompt_type_id: promptTypeId, symbol, timeframe: primaryTf, signal_id: signalId
    }, {
      status: signal.signal_type === 'hold' ? 'skipped_hold' : 'success',
      signal_id: signalId, signal_type: signal.signal_type, confidence: signal.confidence,
      subscriber_count: onlineSubscribers.size, inference_source: aiSource,
    }, 'success')
    l(`<<< cycle complete (signal=#${signalId}, subscribers=${onlineSubscribers.size})`)
    return { status: 'success', signalId, subscriberCount: onlineSubscribers.size, createdAt }
  } catch (err) {
    l(`<<< EXCEPTION: ${err.message}`)
    console.error(`[UnifiedCycle] ${key} error:`, err.message)
    await insertAudit(null, adminUserId || 0, 'ai_auto_scan', symbol, { prompt_type_id: promptTypeId, symbol }, { status: 'error', message: err.message }, 'error')
    return { status: 'error', reason: 'exception', message: err.message }
  }
}

// === Delivery execution for a single subscriber ===
async function executeDelivery(userId, signalId, signal, unifiedConfig, market, promptTypeId, symbol, createdAt) {
  const l = (msg) => console.log(`[Delivery U${userId}] signal=${signalId} ${symbol}: ${msg}`)
  try {
    const riskConfig = await getDeliveryExecuteRiskConfig(userId)
    if (!riskConfig?.enable_auto_trade) {
      l('skipped: enable_auto_trade=false')
      await queryRun('UPDATE auto_signal_deliveries SET execution_status = ? WHERE signal_id = ? AND user_id = ?',
        ['skipped', signalId, userId])
      await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id, reason: 'auto_trade_disabled' },
        { status: 'skipped' }, 'info')
      return
    }

    // Use user's own bridge for execution
    if (!isBridgeAlive(userId)) {
      l('skipped: bridge not alive')
      await queryRun('UPDATE auto_signal_deliveries SET execution_status = ? WHERE signal_id = ? AND user_id = ?',
        ['skipped', signalId, userId])
      await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id, reason: 'bridge_offline' },
        { status: 'skipped' }, 'info')
      return
    }

    // Defense-in-depth: check trade_send_enabled
    const ubSettings = await queryOne('SELECT trade_send_enabled FROM user_bridge_settings WHERE user_id = ?', [userId])
    if (!ubSettings || !ubSettings.trade_send_enabled) {
      l('skipped: trade_send_enabled=0 (or no row)')
      await queryRun('UPDATE auto_signal_deliveries SET execution_status = ? WHERE signal_id = ? AND user_id = ?',
        ['skipped', signalId, userId])
      await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id, reason: 'trade_send_disabled' },
        { status: 'skipped' }, 'info')
      return
    }

    const order = signalOrderPayload(signal, riskConfig, market, true)
    // Scale down volume if it exceeds user's max_position_size
    const userMaxVolume = parseFloat(riskConfig.max_position_size || 0.05)
    if (order.volume > userMaxVolume) {
      const originalVolume = order.volume
      order.volume = round2(userMaxVolume)
      l(`volume scaled: ${originalVolume} → ${order.volume} (user max=${userMaxVolume})`)
    }

    // Supersede: cancel same-direction pending orders before placing new one
    const SUPERSEDE_SAME_DIRECTION = true
    if (SUPERSEDE_SAME_DIRECTION && order.entry_method && order.entry_method !== 'market' && order.entry_method !== 'observe') {
      try {
        const side = (order.order_type || 'buy').startsWith('buy') ? 'buy' : 'sell'
        const pendingList = await mt5Bridge(userId, 'pending_list', { symbol }, { noFallback: true })
        const pendingOrders = pendingList?.orders || pendingList?.pending_list || []
        for (const po of pendingOrders) {
          if (po.symbol === symbol && po.pending_type && po.pending_type.startsWith(side)) {
            try {
              await mt5Bridge(userId, 'cancel_pending', { ticket: po.ticket }, { noFallback: true })
              await queryRun(
                "UPDATE auto_signal_deliveries SET pending_state = 'superseded' WHERE pending_ticket = ? AND user_id = ?",
                [String(po.ticket), userId])
              l(`superseded old pending: ticket=${po.ticket} (${po.pending_type})`)
              await insertAudit(null, userId, 'pending_superseded', symbol,
                { signal_id: signalId, ticket: po.ticket, pending_type: po.pending_type },
                { status: 'superseded' }, 'info')
            } catch (cancelErr) {
              l(`supersede cancel failed: ticket=${po.ticket}: ${cancelErr.message}`)
              await insertAudit(null, userId, 'pending_supersede_failed', symbol,
                { signal_id: signalId, ticket: po.ticket, error: cancelErr.message },
                { status: 'error', message: cancelErr.message }, 'warning')
            }
          }
        }
      } catch (listErr) {
        l(`supersede pending_list failed: ${listErr.message}`)
      }
    }

    const execResult = await executeOrder(userId, riskConfig, order, 'ai_auto_execute', { noFallback: true })

    if (execResult.status === 'success') {
      const ticket = execResult.order || execResult.ticket || null
      const isPending = order.entry_method && order.entry_method !== 'market' && order.entry_method !== 'observe'
      if (isPending) {
        await queryRun(
          `UPDATE auto_signal_deliveries SET execution_status = 'success',
           pending_ticket = ?, pending_state = 'pending', pending_valid_until = ?,
           execution_result = ? WHERE signal_id = ? AND user_id = ?`,
          [String(ticket), signal.pending_valid_until || null, JSON.stringify(execResult), signalId, userId])
        // Sync to ai_signals
        await queryRun('UPDATE ai_signals SET is_executed = 1, executed_at = NOW(), pending_ticket = ? WHERE id = ?', [String(ticket), signalId]).catch(() => {})
        l(`auto-executed pending: ticket=${ticket}, volume=${order.volume}`)
      } else {
        await queryRun(
          `UPDATE auto_signal_deliveries SET execution_status = 'success', is_executed = 1, executed_at = NOW(),
           trade_ticket = ?, execution_result = ? WHERE signal_id = ? AND user_id = ?`,
          [ticket, JSON.stringify(execResult), signalId, userId])
        l(`auto-executed: ticket=${ticket}, volume=${order.volume}`)
      }
      await insertAudit(null, userId, 'ai_auto_execute', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id, ticket, volume: order.volume, is_pending: isPending },
        { status: 'success', ticket, volume: order.volume }, 'success')
    } else {
      const status = execResult.status === 'rejected' ? 'rejected' : 'failed'
      await queryRun(
        `UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE signal_id = ? AND user_id = ?`,
        [status, JSON.stringify(execResult), signalId, userId])
      l(`auto-execute ${status}: ${execResult.message || execResult.status}`)
      await insertAudit(null, userId, status === 'rejected' ? 'ai_auto_execute_rejected' : 'ai_auto_execute', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id, error: execResult.message },
        execResult, status === 'rejected' ? 'warning' : 'error')
    }
  } catch (err) {
    l(`exception: ${err.message}`)
    await queryRun(
      `UPDATE auto_signal_deliveries SET execution_status = 'failed', execution_result = ? WHERE signal_id = ? AND user_id = ?`,
      [JSON.stringify({ error: err.message }), signalId, userId]).catch(() => {})
    await insertAudit(null, userId, 'ai_auto_execute', symbol,
      { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id, error: err.message },
      { status: 'error', message: err.message }, 'error')
  }
}

// === Compatibility wrappers ===
export async function startAutoScheduler(userId) {
  await reconcileAutoSchedulers()
}

// Trigger reconcile after user state change (bridge disconnect/reconnect, config save)
// Actual subscriber removal is handled by removeUserRuntimeAutoSubscription
export async function stopAutoScheduler(userId) {
  await reconcileAutoSchedulers()
}

export async function initAutoSchedulers() {
  console.log('[initAutoSchedulers] Starting unified scheduler reconciliation')
  await rebuildRedisSubscriptions()
  await reconcileAutoSchedulers()
  startAutoSchedulerReconciler()
  startPendingReconciler()
}

let _reconcileInterval = null
export function startAutoSchedulerReconciler() {
  if (_reconcileInterval) return
  _reconcileInterval = setInterval(async () => {
    try { await reconcileAutoSchedulers() } catch (e) { console.error('[Reconciler] Error:', e.message) }
  }, 60_000)
  console.log('[Reconciler] Started periodic reconciliation (every 60s)')
}

// === Pending Order Reconciler ===
const PENDING_RECONCILE_INTERVAL_SEC = 30
let _pendingReconcileInterval = null

export function stopPendingReconciler() {
  if (_pendingReconcileInterval) { clearInterval(_pendingReconcileInterval); _pendingReconcileInterval = null }
}

export function startPendingReconciler() {
  if (_pendingReconcileInterval) return
  _pendingReconcileInterval = setInterval(async () => {
    try { await reconcilePendingOrders() } catch (e) { console.error('[PendingReconciler] Error:', e.message) }
  }, PENDING_RECONCILE_INTERVAL_SEC * 1000)
  console.log(`[PendingReconciler] Started (every ${PENDING_RECONCILE_INTERVAL_SEC}s)`)
}

export async function reconcilePendingOrders() {
  const deliveryRows = await queryAll(
    "SELECT id, user_id, signal_id, pending_ticket, pending_valid_until, 'delivery' as src FROM auto_signal_deliveries WHERE pending_state = 'pending'"
  )

  const signalRows = await queryAll(
    "SELECT id, user_id, id as signal_id, pending_ticket, pending_valid_until, 'signal' as src FROM ai_signals WHERE pending_state = 'pending'"
  )

  const allRows = [...deliveryRows, ...signalRows]
  if (!allRows.length) return

  const byUser = {}
  for (const row of allRows) {
    if (!byUser[row.user_id]) byUser[row.user_id] = []
    byUser[row.user_id].push(row)
  }

  for (const [userIdStr, rows] of Object.entries(byUser)) {
    const userId = Number(userIdStr)
    if (!isBridgeAlive(userId)) continue

    try {
      const [pendingResp, positionsResp] = await Promise.all([
        mt5Bridge(userId, 'pending_list', {}, { noFallback: true }),
        mt5Bridge(userId, 'positions', {}, { noFallback: true }),
      ])

      const pendingOrders = pendingResp?.orders ?? pendingResp?.pending_list
      const positionList = positionsResp?.positions
      if (!Array.isArray(pendingOrders) || !Array.isArray(positionList)) {
        console.error(`[PendingReconciler] User ${userId}: invalid bridge response, skip this round`)
        continue
      }

      const pendingSet = new Set(pendingOrders.map(o => String(o.ticket)))
      const positionSet = new Set(positionList.map(p => String(p.ticket)))

      for (const row of rows) {
        const ticket = String(row.pending_ticket)
        if (pendingSet.has(ticket)) continue

        if (positionSet.has(ticket)) {
          if (row.src === 'delivery') {
            await queryRun(
              "UPDATE auto_signal_deliveries SET pending_state = 'filled', is_executed = 1, trade_ticket = ?, executed_at = NOW() WHERE id = ?",
              [ticket, row.id])
            await queryRun('UPDATE ai_signals SET is_executed = 1, trade_ticket = ? WHERE pending_ticket = ?', [ticket, ticket]).catch(() => {})
          } else {
            await queryRun(
              "UPDATE ai_signals SET pending_state = 'filled', is_executed = 1, trade_ticket = ?, executed_at = NOW() WHERE id = ?",
              [ticket, row.signal_id])
          }
          await insertAudit(null, userId, 'pending_filled', null,
            { signal_id: row.signal_id, ticket, src: row.src }, { status: 'filled', ticket }, 'success')
          sendToBrowsers(userId, { type: 'pending_filled', ticket, signal_id: row.signal_id })
          continue
        }

        const nowUtc = Date.now()
        let validUntilUtc = 0
        if (row.pending_valid_until) {
          const d = new Date(row.pending_valid_until.replace(' ', 'T') + 'Z')
          if (!isNaN(d.getTime())) validUntilUtc = d.getTime()
        }

        if (validUntilUtc > 0 && nowUtc > validUntilUtc) {
          if (row.src === 'delivery') {
            await queryRun("UPDATE auto_signal_deliveries SET pending_state = 'expired' WHERE id = ?", [row.id])
          } else {
            await queryRun("UPDATE ai_signals SET pending_state = 'expired' WHERE id = ?", [row.signal_id])
          }
          await insertAudit(null, userId, 'pending_expired', null,
            { signal_id: row.signal_id, ticket, src: row.src }, { status: 'expired' }, 'info')
        } else {
          if (row.src === 'delivery') {
            await queryRun("UPDATE auto_signal_deliveries SET pending_state = 'cancelled' WHERE id = ?", [row.id])
          } else {
            await queryRun("UPDATE ai_signals SET pending_state = 'cancelled' WHERE id = ?", [row.signal_id])
          }
          await insertAudit(null, userId, 'pending_cancelled', null,
            { signal_id: row.signal_id, ticket, src: row.src }, { status: 'cancelled' }, 'warning')
        }
      }
    } catch (err) {
      console.error(`[PendingReconciler] User ${userId} error:`, err.message)
    }
  }
}

export async function startSmartCloseScheduler(userId) {
  if (closeSchedulerState[userId]?.timer) return
  const cfg = await getCloseConfig(userId)
  if (!cfg || !cfg.enabled) return

  const intervalMs = (cfg.check_interval_seconds || 30) * 1000
  closeSchedulerState[userId] = { running: true, timer: null }

  const tick = async () => {
    if (!closeSchedulerState[userId]?.running) return
    try {
      const marketState = getOwnBridgeMarketState(userId)
      if (!marketState.isOpen) { closeSchedulerState[userId].timer = setTimeout(tick, 5000); return }
    } catch { closeSchedulerState[userId].timer = setTimeout(tick, 5000); return }
    try { await runSmartCloseCycle(userId) } catch (e) { console.error(`[SmartClose] User ${userId} tick error:`, e.message) }
    if (closeSchedulerState[userId]?.running) {
      closeSchedulerState[userId].timer = setTimeout(tick, intervalMs)
    }
  }
  closeSchedulerState[userId].timer = setTimeout(tick, 5000)
}

export function stopSmartCloseScheduler(userId) {
  const state = closeSchedulerState[userId]
  if (state?.timer) clearTimeout(state.timer)
  closeSchedulerState[userId] = null
}

export async function runSmartCloseCycle(userId) {
  const closeCfg = await getCloseConfig(userId)
  if (!closeCfg || !closeCfg.enabled) return

  const user = await queryOne('SELECT plan FROM users WHERE id = ?', [userId])
  if (!user || user.plan !== 'pro') return

  const marketState = getOwnBridgeMarketState(userId)
  if (!marketState.isOpen) { return }

  const positionsData = await mt5Bridge(userId, 'positions', {})
  const positions = positionsData?.positions || []
  if (positions.length === 0) return

  let account = null
  try {
    const accountData = await mt5Bridge(userId, 'account', {})
    account = accountData?.account || null
  } catch (e) { console.error('[SmartClose] Failed to get account:', e.message) }

  const ruleResults = runCloseRules(closeCfg, positions, account)
  if (ruleResults.length > 0) {
    const canTrade = isTradeEnabled(userId)
    for (const r of ruleResults) {
      try {
        if (!canTrade) {
          await insertAudit(null, userId, 'smart_close_rule', r.symbol || 'XAUUSD', { ticket: r.ticket, rule: r.rule, reason: r.reason }, { status: 'rejected', message: '交易发送已关闭' }, 'rejected')
          continue
        }
        const closeResult = await mt5Bridge(userId, 'close', { ticket: r.ticket })
        await insertAudit(null, userId, 'smart_close_rule', r.symbol || 'XAUUSD', { ticket: r.ticket, rule: r.rule, reason: r.reason }, closeResult, 'success')
      } catch (e) {
        await insertAudit(null, userId, 'smart_close_rule', r.symbol || 'XAUUSD', { ticket: r.ticket, error: e.message }, null, 'error')
      }
    }
  }

  const remainingData = await mt5Bridge(userId, 'positions', {})
  const remaining = remainingData?.positions || []
  if (remaining.length === 0) return

  try {
    await runSmartClose(userId, closeCfg, account, remaining)
  } catch (e) {
    console.error(`[SmartClose] User ${userId} AI cycle error:`, e.message)
  }
}

function runCloseRules(cfg, positions, account) {
  const results = []
  for (const pos of positions) {
    const profit = pos.profit || 0
    if (cfg.rule_soft_sl != null && profit < 0 && Math.abs(profit) >= cfg.rule_soft_sl) {
      results.push({ ticket: pos.ticket, symbol: pos.symbol, rule: 'soft_sl', reason: `亏损 $${Math.abs(profit).toFixed(2)} >= 软止损 $${cfg.rule_soft_sl}` })
      continue
    }
    if (cfg.rule_soft_tp != null && profit > 0 && profit >= cfg.rule_soft_tp) {
      results.push({ ticket: pos.ticket, symbol: pos.symbol, rule: 'soft_tp', reason: `盈利 $${profit.toFixed(2)} >= 软止盈 $${cfg.rule_soft_tp}` })
      continue
    }
    if (cfg.rule_timeout_minutes != null && pos.time) {
      const durationMin = (Date.now() / 1000 - pos.time) / 60
      if (durationMin >= cfg.rule_timeout_minutes && profit <= 0) {
        results.push({ ticket: pos.ticket, symbol: pos.symbol, rule: 'timeout', reason: `持仓 ${Math.floor(durationMin)} 分钟且浮亏，超时平仓` })
        continue
      }
    }
    if (cfg.rule_max_loss_pct != null && account?.balance && profit < 0) {
      const lossPct = (Math.abs(profit) / account.balance) * 100
      if (lossPct >= cfg.rule_max_loss_pct) {
        results.push({ ticket: pos.ticket, symbol: pos.symbol, rule: 'max_loss_pct', reason: `亏损 ${lossPct.toFixed(1)}% >= 最大亏损 ${cfg.rule_max_loss_pct}%` })
        continue
      }
    }
  }
  return results
}

async function runSmartClose(userId, closeConfig, account, positions) {
  if (!positions || positions.length === 0) return []
  if (!isTradeEnabled(userId)) return []

  const symbol = positions[0].symbol || 'XAUUSD'
  const prompt = closeConfig.system_prompt
  if (!prompt) { console.error('[SmartClose] No system_prompt configured'); return [] }
  const model = closeConfig.model_name || 'deepseek-chat'

  let strategyContext = {}
  try {
    strategyContext = await buildStrategyContextFromTags(userId, symbol, account, positions, prompt, 'M5', null, 'close')
  } catch (e) {
    console.error('[SmartClose] Failed to build strategy context:', e.message)
  }

  const recentSignal = await queryOne(
    "SELECT signal_type, analysis FROM ai_signals WHERE user_id = ? AND signal_type IN ('buy', 'sell') ORDER BY id DESC LIMIT 1",
    [userId]
  )

  const details = (positions || []).map(p => ({
    ticket: p.ticket, symbol: p.symbol,
    type: p.type === 'buy' ? 'BUY' : 'SELL',
    volume: p.volume,
    open_price: p.open_price || p.price_open,
    current_price: p.price_current,
    profit: round2(p.profit || 0),
    sl: p.sl || null, tp: p.tp || null,
    duration_minutes: p.time ? Math.floor((Date.now() / 1000 - p.time) / 60) : null,
  }))
  const closeContext = {
    positions: { total: details.length, details },
    account: account ? { balance: account.balance, equity: account.equity, profit: account.profit } : null,
    recent_signal: recentSignal ? { type: recentSignal.signal_type, analysis: recentSignal.analysis } : null,
  }
  const contextPayload = { ...strategyContext, ...closeContext, latest_price: positions[0].price_current || 0 }

  let apiKey, baseUrl
  if (closeConfig.api_key_encrypted) {
    apiKey = closeConfig.api_key_encrypted
    baseUrl = closeConfig.api_base_url || DEFAULT_API_BASE_URL
  } else {
    const config = await getActiveConfig(null, userId)
    if (!config) return []
    apiKey = config.api_key_encrypted
    baseUrl = closeConfig.api_base_url || config.api_base_url || DEFAULT_API_BASE_URL
  }
  const temperature = closeConfig.temperature ?? 0.3
  let maxTokens = closeConfig.max_tokens || 4000
  if (/reason|think|flash/i.test(model) && maxTokens < 8000) {
    maxTokens = Math.min(maxTokens * 2, 8000)
  }

  try {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, temperature, max_tokens: maxTokens,
        messages: [
          { role: 'system', content: stripTimeframeTags(prompt) },
          { role: 'user', content: JSON.stringify(contextPayload) },
        ],
      }),
    })
    const data = await resp.json()
    let content = data.choices?.[0]?.message?.content || ''
    if (!content) {
      const reasoning = data.choices?.[0]?.message?.reasoning_content || ''
      if (reasoning) {
        const jsonMatch = reasoning.match(/\{[\s\S]*"positions"[\s\S]*\]/)
        if (jsonMatch) {
          let candidate = jsonMatch[0]
          const openBraces = (candidate.match(/\{/g) || []).length
          const closeBraces = (candidate.match(/\}/g) || []).length
          if (openBraces > closeBraces) candidate += '}'.repeat(openBraces - closeBraces)
          content = candidate
        } else {
          console.error('[SmartClose] No JSON found in reasoning_content (first 500):', reasoning.substring(0, 500))
          return []
        }
      } else {
        console.error('[SmartClose] Empty AI response. Status:', resp.status, 'Response:', JSON.stringify(data).substring(0, 300))
        return []
      }
    }

    let jsonStr = content.replace(/```json\n?|```/g, '').trim()
    const firstBrace = jsonStr.indexOf('{')
    const lastBrace = jsonStr.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = jsonStr.substring(firstBrace, lastBrace + 1)
    }
    let parsed
    try {
      parsed = JSON.parse(jsonStr)
    } catch (e) {
      console.error('[SmartClose] JSON parse error:', e.message, '\nRaw content (first 500):', content.substring(0, 500))
      return []
    }

    if (!Array.isArray(parsed.positions) || parsed.positions.length === 0) return []

    const avgConfidence = parsed.positions.reduce((s, p) => s + (p.confidence || 0.5), 0) / parsed.positions.length
    const analysisJson = JSON.stringify(parsed.positions)
    const reasoningText = `智能平仓分析：${positions.length}笔持仓`
    const contextJson = JSON.stringify(contextPayload)

    const createdAt = beijingNow()
    const tokenCount = Math.round((analysisJson.length + reasoningText.length + contextJson.length) / 4)
    const closeSignalResult = await queryRun(
      `INSERT INTO ai_signals(user_id, session_id, symbol, timeframe, signal_type, confidence, recommended_volume,
        analysis, reasoning, market_data_json, token_count, ai_model, ttl_seconds, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, 'smart_close', symbol, 'CLOSE', 'close', avgConfidence, 0,
        analysisJson, reasoningText, contextJson, tokenCount, model, 3600, createdAt]
    )
    const closeSignalId = closeSignalResult?.insertId

    const validTickets = new Set(positions.map(p => String(p.ticket)))
    const results = []
    for (const item of parsed.positions) {
      if (!validTickets.has(String(item.ticket))) continue
      if (item.action !== 'close') continue

      const pos = positions.find(p => String(p.ticket) === String(item.ticket))
      if (!pos) continue

      try {
        const closeResult = await mt5Bridge(userId, 'close', { ticket: pos.ticket })
        results.push({ ticket: pos.ticket, success: true, price: closeResult?.price, reason: item.reason })

        if (closeSignalId) {
          await queryRun(
            'INSERT IGNORE INTO close_signal_tickets (user_id, original_ticket, close_signal_id, close_price) VALUES (?, ?, ?, ?)',
            [userId, String(pos.ticket), closeSignalId, closeResult?.price || pos.price_current]
          )
        }

        await insertAudit(null, userId, 'smart_close', symbol, { ticket: pos.ticket, reason: item.reason, confidence: item.confidence }, closeResult, 'success')
      } catch (e) {
        results.push({ ticket: pos.ticket, success: false, error: e.message })
        await insertAudit(null, userId, 'smart_close', symbol, { ticket: pos.ticket, error: e.message }, null, 'error')
      }
    }

    const successCount = results.filter(r => r.success).length
    if (closeSignalId && successCount > 0) {
      await queryRun('UPDATE ai_signals SET is_executed = 1, execution_result = ? WHERE id = ?',
        [JSON.stringify({ closed: successCount, total: results.length, results }), closeSignalId])
    }

    return results
  } catch (e) {
    console.error('[SmartClose] AI error:', e.message)
    return []
  }
}

async function executeOrder(userId, config, request, action, options = {}) {
  if (!isTradeEnabled(userId)) {
    const result = { status: 'rejected', message: '交易发送已关闭，请先开启' }
    await insertAudit(null, userId, action, request.symbol, request, result, 'rejected')
    return result
  }
  return executeOrderCore(userId, config, request, action, options)
}

// getActiveConfig is now imported from config.js directly
