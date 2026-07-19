// ai/scheduler.js — 统一自动调度 + 智能平仓

import { queryOne, queryAll, queryRun, beijingNow, withTransaction } from '../../db.js'
import { DEFAULT_API_BASE_URL } from '../../config.js'
import { getOwnBridgeMarketState, recordBridgeMarketState, isBridgeAlive, isTradeEnabled, sendToBrowsers, getAllBridges } from '../../bridge-ws.js'
import { mt5Bridge, platformRates, calculateMarketData } from './market-data.js'
import { maybeAiSignal, requestJsonObject } from './llm.js'
import { getGlobalAutoConfig, getCloseConfig, saveCloseConfig, insertAudit, signalOrderPayload, getExecuteRiskConfig, getAutoPromptTypeById, getAutoPromptTypes, getUnifiedAutoInferenceConfig, getAutoSubscribers, getDeliveryExecuteRiskConfig, getDeliverySubscriptionRuntime, parsePromptSymbols, resolveEffectiveSymbols, executeOrderCore, DEFAULT_MAX_POSITION_SIZE } from './config.js'
import { attachAtrAnchor, buildStrategyContextFromTags, resolveChanHistoryCount } from './strategy.js'
import { attachSignalTiming, signalTtlSeconds, stripTimeframeTags, round2, stripBrokerSuffix } from './utils.js'
import { getRedis, isRedisAvailable } from '../../redis.js'
import { currentWeeklyFlattenEnd, isWeeklyFlattenWindow } from '../../jobs/weekly-risk-window.js'
import crypto from 'crypto'
import { buildSharedMarketSnapshot, persistInferenceSnapshotTx } from './inference-snapshots.js'
import { retrievePersonalMemory, attachMemoryInjectionSignal, recordPairedInferenceRun } from './memory-system.js'
import { retrievePlatformExperience } from './platform-experience.js'
import { attachOutcomeDelivery, recordPendingOutcomeFill, startOutcomeMonitor } from './signal-outcomes.js'
import { resolveAiTaskModel } from './model-profiles.js'
import { isSubscriptionScheduleActive } from './subscription-schedule.js'
import { attachSignalPresentation, normalizeDecisionFields, SIGNAL_SCHEMA_VERSION } from './signal-presentation.js'

// === Unified Scheduler State ===
// Key: "promptTypeId:symbol"
export const autoSchedulerState = {}
export const closeSchedulerState = {}

// === Permission gate: can user execute auto trades (cancel/submit) ===
async function isUserEligibleForAutoExecution(userId) {
  if (!isBridgeAlive(userId)) return false
  if (!isTradeEnabled(userId)) return false
  const scheduler = await queryOne('SELECT enabled, enable_auto_trade FROM auto_scheduler WHERE user_id = ?', [userId])
  if (!scheduler || !scheduler.enabled || !scheduler.enable_auto_trade) return false
  const user = await queryOne(`SELECT role,
    (role = 'admin' OR (plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW()))) AS has_pro_access
    FROM users WHERE id = ?`, [userId])
  if (!user?.has_pro_access) return false
  const ubSettings = await queryOne('SELECT trade_send_enabled FROM user_bridge_settings WHERE user_id = ?', [userId])
  if (!ubSettings || !ubSettings.trade_send_enabled) return false
  return true
}

// === Normalize cancel condition (Fix 1) ===
function normalizeCancelCondition(cond, expectedSymbol) {
  if (!cond) return null
  const normalized = {}
  // symbol must match current cycle symbol (broker suffix normalized)
  const condSymbol = String(cond.symbol || '').toUpperCase().trim()
  if (!condSymbol || stripBrokerSuffix(condSymbol) !== stripBrokerSuffix(expectedSymbol)) return null
  normalized.symbol = expectedSymbol
  if (cond.cancel_all) { normalized.cancel_all = true }
  else {
    const validTypes = ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit']
    const pendingType = String(cond.pending_type || '').toLowerCase()
    if (pendingType && validTypes.includes(pendingType)) normalized.pending_type = pendingType
    if (cond.max_price != null) { const p = parseFloat(cond.max_price); if (Number.isFinite(p)) normalized.max_price = p }
    if (cond.min_price != null) { const p = parseFloat(cond.min_price); if (Number.isFinite(p)) normalized.min_price = p }
    if (!normalized.pending_type && normalized.max_price == null && normalized.min_price == null && !normalized.cancel_all) return null
  }
  normalized.reason = String(cond.reason || 'AI cancel')
  return normalized
}

function calculateRecoverySeconds(deadlineMs, nowMs = Date.now()) {
  if (!Number.isFinite(deadlineMs)) return 0
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000))
}

function matchPendingCancelCondition(order, condition) {
  if (stripBrokerSuffix(String(order?.symbol || '')) !== stripBrokerSuffix(String(condition?.symbol || ''))) {
    return { matched: false, reason: 'symbol_mismatch' }
  }
  const ticket = String(order?.ticket ?? '').trim()
  if (!ticket) return { matched: false, reason: 'invalid_pending_ticket' }
  if (condition.cancel_all) return { matched: true, ticket }

  const pendingType = String(order?.pending_type || '').toLowerCase()
  if (condition.pending_type && pendingType !== condition.pending_type) {
    return { matched: false, reason: 'pending_type_mismatch' }
  }
  const hasPriceCondition = condition.max_price != null || condition.min_price != null
  const price = Number.parseFloat(order?.price)
  if (hasPriceCondition && (!Number.isFinite(price) || price <= 0)) {
    return { matched: false, reason: 'invalid_pending_price', ticket }
  }
  if (condition.max_price != null && (!pendingType.startsWith('buy') || price > condition.max_price)) {
    return { matched: false, reason: 'max_price_mismatch', ticket }
  }
  if (condition.min_price != null && (!pendingType.startsWith('sell') || price < condition.min_price)) {
    return { matched: false, reason: 'min_price_mismatch', ticket }
  }
  return { matched: true, ticket }
}

function countPendingForSymbol(orders, symbol) {
  const normalizedSymbol = stripBrokerSuffix(symbol)
  return orders.filter(order => stripBrokerSuffix(String(order?.symbol || '')) === normalizedSymbol).length
}

function countPendingForSymbolDirection(orders, symbol, direction) {
  const normalizedSymbol = stripBrokerSuffix(symbol)
  const buySide = String(direction || '').toLowerCase().startsWith('buy')
  return (Array.isArray(orders) ? orders : []).filter(order => {
    if (stripBrokerSuffix(String(order?.symbol || '')) !== normalizedSymbol) return false
    return String(order?.pending_type || order?.order_type || '').toLowerCase().startsWith('buy') === buySide
  }).length
}

function isFilledHistoryOrder(order) {
  if (!order || typeof order !== 'object') return false
  const state = String(order.state ?? order.status ?? order.order_state ?? '').toLowerCase()
  if (/(cancel|reject|expire|delete)/.test(state)) return false
  if (/(fill|filled|closed|close|executed|complete)/.test(state)) return true
  if (order.deal != null || order.deal_ticket != null || order.position_id != null) return true
  const volume = Number(order.volume ?? order.volume_initial ?? 0)
  return volume > 0 && (order.close_time != null || order.profit != null)
}

function validateInferenceBridgeSnapshot(account, positionsData, pendingData) {
  const balance = Number(account?.balance)
  const equity = Number(account?.equity)
  if (!account || account.status === 'error' || !Number.isFinite(balance) || balance < 0 || !Number.isFinite(equity) || equity <= 0) {
    return { ok: false, reason: 'account_failed' }
  }
  if (!positionsData || positionsData.status === 'error' || !Array.isArray(positionsData.positions)) {
    return { ok: false, reason: 'positions_failed' }
  }
  const pendingOrders = pendingData?.orders ?? pendingData?.pending_list
  if (!pendingData || pendingData.status === 'error' || !Array.isArray(pendingOrders)) {
    return { ok: false, reason: 'pending_list_failed' }
  }
  return { ok: true, account, positions: positionsData.positions, pendingOrders }
}

function normalizeSymbolForScheduler(sym) {
  return stripBrokerSuffix(sym)
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
      SELECT s.user_id, s.prompt_type_id, s.selected_symbols_json, apt.symbols_json as strategy_symbols_json
      FROM auto_scheduler s
      JOIN auto_prompt_types apt ON apt.id = s.prompt_type_id
      JOIN users u ON u.id = s.user_id
      WHERE s.enabled = 1 AND s.prompt_type_id IS NOT NULL
        AND (apt.scope = 'platform' OR (apt.scope = 'private' AND apt.owner_user_id = s.user_id))
         AND (u.role = 'admin' OR (u.plan = 'pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())))
    `)

    let onlineCount = 0
    for (const row of rows) {
      // Only add to runtime subs if bridge is online
      if (!isBridgeAlive(row.user_id)) continue

      const userSymbols = resolveEffectiveSymbols(row.selected_symbols_json, row.strategy_symbols_json)
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
      last_run_at: state.lastRunAt || '',
      stage: state.stage || 'idle',
      stage_label: state.stageLabel || '',
      progress_percent: String(state.progressPercent || 0),
      progress_seq: String(state.progressSeq || 0),
      cycle_id: state.cycleId || '',
      cycle_started_at: state.cycleStartedAt || '',
      stage_updated_at: state.stageUpdatedAt || ''
    }
    if (state.marketState) {
      fields.market_reason = state.marketState.reason || ''
      fields.market_detail_reason = state.marketState.detailReason || ''
      fields.market_state_source = state.marketState.source || ''
      fields.market_symbol = state.marketState.symbol || ''
      fields.market_trade_mode = String(state.marketState.tradeMode ?? -1)
      fields.market_tick_age_ms = String(state.marketState.tickAgeMs ?? '')
      fields.market_tick_age_seconds = String(state.marketState.tickAgeSeconds ?? '')
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
    return { enabled: false, running: false, paused_reason: 'disabled', prompt_type_id: null, prompt_type_name: '', selected_symbols: [], active_scheduler_keys: [], subscriber_count: 0, in_flight: false, active_cycles: [], stage: 'idle', last_error: '', next_run_in_seconds: 0, last_run_at: '', last_signal_id: null, admin_bridge_online: false, market_state: { isOpen: false, reason: 'unknown' }, redis_available: false }
  }

  let selectedSymbols = []
  let promptTypeName = ''
  let promptType = null
  if (scheduler.prompt_type_id) {
    const pt = await getAutoPromptTypeById(scheduler.prompt_type_id)
    if (pt) {
      promptType = pt
      promptTypeName = pt.title || ''
      selectedSymbols = resolveEffectiveSymbols(scheduler.selected_symbols_json, pt.symbols_json || '[]')
    }
  }

  const redis = getRedis()
  const redisAvailable = !!redis && isRedisAvailable()
  const adminUserId = promptType?.scope === 'private' ? null : await getActiveAdminBridgeUserId()
  const marketBridgeUserId = promptType?.scope === 'private' ? Number(promptType.owner_user_id) : adminUserId
  const adminBridgeOnline = !!adminUserId
  const marketBridgeOnline = !!marketBridgeUserId && isBridgeAlive(marketBridgeUserId)
  const marketState = marketBridgeOnline ? getOwnBridgeMarketState(marketBridgeUserId) : { alive: false, isOpen: false, tradeMode: -1, reason: 'bridge_offline', lastTickMs: null, tickAgeMs: null, mt5TimeStr: null }

  // Find user's active scheduler keys
  const activeKeys = []
  let earliestNextRun = Infinity
  let anyInFlight = false
  let overallLastError = ''
  let overallWaitReason = ''
  let overallLastRunAt = ''
  let overallLastSignalId = null
  let totalSubscribers = 0
  const activeCycles = []

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
    if (st.inFlight) {
      activeCycles.push({
        cycle_id: st.cycleId || `${key}:running`,
        prompt_type_id: st.promptTypeId,
        symbol: st.symbol,
        stage: st.stage || 'running',
        stage_label: st.stageLabel || '正在准备推理',
        progress_percent: Number(st.progressPercent || 3),
        progress_seq: Number(st.progressSeq || 0),
        started_at: st.cycleStartedAt || '',
        stage_updated_at: st.stageUpdatedAt || st.cycleStartedAt || '',
      })
    }

    // Check cooldown TTL
    if (redis) {
      try {
        const ttl = await redis.ttl(`${REDIS_COOLDOWN_PREFIX}${key}`)
        if (ttl > 0 && ttl < earliestNextRun) earliestNextRun = ttl
      } catch (e) { console.warn('[Scheduler] Redis TTL check failed:', e.message) }
    }
  }

  // Determine paused reason — only real errors/blockers, not normal cooldown
  let pausedReason = ''
  if (isWeeklyFlattenWindow()) pausedReason = 'weekly_flatten_window'
  else if (!scheduler.prompt_type_id) pausedReason = 'no_strategy'
  else if (selectedSymbols.length === 0) pausedReason = 'no_symbols'
  else {
    const activeSubscription = await queryOne(`SELECT * FROM strategy_subscriptions
      WHERE user_id = ? AND strategy_id = ? AND execution_enabled = 1 AND is_deleted = 0
      ORDER BY updated_at DESC, id DESC LIMIT 1`, [userId, scheduler.prompt_type_id])
    if (activeSubscription && !isSubscriptionScheduleActive(activeSubscription)
      && activeSubscription.outside_window_behavior !== 'signals_only') pausedReason = 'outside_schedule'
  }
  if (!pausedReason && activeKeys.length === 0) {
    const userBridgeAlive = isBridgeAlive(userId)
    if (!userBridgeAlive) pausedReason = 'user_bridge_offline'
    else pausedReason = 'no_runtime_scheduler'
  }
  else if (!marketBridgeOnline) pausedReason = promptType?.scope === 'private' ? 'owner_bridge_offline' : 'admin_bridge_offline'
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
    active_cycles: activeCycles,
    stage: anyInFlight ? 'running' : (pausedReason ? 'paused' : 'idle'),
    last_error: overallLastError,
    wait_reason: overallWaitReason,
    paused_reason: pausedReason,
    next_run_in_seconds: nextRunSeconds,
    last_run_at: overallLastRunAt,
    last_signal_id: overallLastSignalId,
    admin_bridge_online: adminBridgeOnline,
    market_bridge_online: marketBridgeOnline,
    strategy_scope: promptType?.scope || 'platform',
    market_state: marketState,
    redis_available: redisAvailable,
  }
}

// === Redis Lock Helpers ===
const REDIS_LOCK_PREFIX = 'auto:scheduler:lock:'
const REDIS_COOLDOWN_PREFIX = 'auto:scheduler:cooldown:'
const LOCK_TTL_MS = 600000 // 10 minutes
const LOCK_RENEW_INTERVAL_MS = 200000 // renew every ~3.3 min (1/3 of TTL)

// Lua script for atomic finalize: verify token → set cooldown → delete lock
const FINALIZE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  if ARGV[3] == "1" then
    redis.call("set", KEYS[2], "1", "EX", ARGV[2])
  end
  return redis.call("del", KEYS[1])
else
  return 0
end
`

async function acquireLock(key) {
  const redis = getRedis()
  if (!redis) { console.warn(`[acquireLock] ${key}: Redis unavailable`); return null }
  const token = crypto.randomUUID()
  try {
    const ok = await redis.set(`${REDIS_LOCK_PREFIX}${key}`, token, 'NX', 'PX', LOCK_TTL_MS)
    if (!ok) console.warn(`[acquireLock] ${key}: lock already held`)
    return ok ? token : null
  } catch (e) { console.error('[acquireLock]', key, e.message); return null }
}

// Atomic finalize: verify token → set cooldown → delete lock in one Lua eval
async function finalizeLock(key, token, cooldownSeconds) {
  const redis = getRedis()
  if (!redis || !token) return false
  try {
    const result = await redis.eval(FINALIZE_LUA, 2, `${REDIS_LOCK_PREFIX}${key}`, `${REDIS_COOLDOWN_PREFIX}${key}`, token, String(cooldownSeconds || 0), cooldownSeconds ? '1' : '0')
    return result > 0
  } catch (e) { console.error('[finalizeLock]', key, e.message); return false }
}

async function renewLock(key, token) {
  const redis = getRedis()
  if (!redis || !token) return false
  try {
    const result = await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`,
      1, `${REDIS_LOCK_PREFIX}${key}`, token, LOCK_TTL_MS)
    return result === 1
  } catch (e) { console.error('[renewLock]', key, e.message); return false }
}

function createLockGuard(key, token) {
  const guard = { key, token, lost: false, renewTimer: null }
  guard.isOwned = async () => {
    if (guard.lost) return false
    const redis = getRedis()
    if (!redis) return false
    try {
      return await redis.get(`${REDIS_LOCK_PREFIX}${key}`) === token
    } catch (e) {
      console.error('[lockGuard] isOwned check failed:', e.message)
      return false
    }
  }
  guard.assertOwned = async (phase) => {
    if (guard.lost || !(await guard.isOwned())) {
      guard.lost = true
      console.error(`[LockGuard] ${key}: lock lost at phase ${phase}`)
      return false
    }
    return true
  }
  return guard
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
    case 'redis_unavailable':
    case 'weekly_flatten_window':
      return 5000
    case 'market_closed':
    case 'market_restricted':
      return 15000
    case 'market_stale_tick':
    case 'market_unknown_no_tick':
    case 'market_unknown':
      return 15000
    case 'rates_failed':
    case 'rates_empty':
    case 'account_failed':
    case 'positions_failed':
    case 'pending_list_failed':
    case 'ai_failed':
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
async function broadcastAutoProgress(promptTypeId, symbol, progress) {
  const key = buildSchedulerKey(promptTypeId, symbol)
  const st = autoSchedulerState[key]
  if (!st?.subscribers) return
  const nextStage = progress.stage || st.stage || 'running'
  if (nextStage !== st.stage || !st.stageUpdatedAt) st.stageUpdatedAt = new Date().toISOString()
  st.stage = nextStage
  st.stageLabel = progress.label || st.stageLabel || ''
  st.progressPercent = Math.max(Number(st.progressPercent || 0), Math.min(100, Number(progress.progress_percent || 0)))
  st.progressSeq = Number(st.progressSeq || 0) + 1
  await updateSchedulerRedisState(key, st)
  const payload = {
    type: 'auto_progress',
    prompt_type_id: promptTypeId,
    symbol,
    cycle_id: st.cycleId,
    seq: st.progressSeq,
    started_at: st.cycleStartedAt,
    stage_updated_at: st.stageUpdatedAt,
    stage: st.stage,
    label: st.stageLabel,
    progress_percent: st.progressPercent,
  }
  for (const uid of st.subscribers) {
    try { sendToBrowsers(uid, payload) } catch (e) { console.warn('[Scheduler] Failed to send progress to browser:', e.message) }
  }
}

const SCHEDULER_WAIT_LOG_HEARTBEAT_MS = 30 * 60_000

function shouldLogSchedulerWait(state, reason, nowMs = Date.now()) {
  const changed = state._lastLoggedWaitReason !== reason
  const heartbeatDue = !Number.isFinite(state._lastWaitLogAtMs) || nowMs - state._lastWaitLogAtMs >= SCHEDULER_WAIT_LOG_HEARTBEAT_MS
  if (!changed && !heartbeatDue) return false
  state._lastLoggedWaitReason = reason
  state._lastWaitLogAtMs = nowMs
  return true
}

function schedulerWaitLabel(reason) {
  const labels = {
    redis_unavailable: 'Redis 不可用，等待恢复',
    owner_bridge_offline: '策略所属账户桥接离线，等待重连',
    admin_bridge_offline: '管理员行情桥接离线，等待重连',
    market_closed: '市场休市，等待开市',
    market_restricted: '品种交易权限受限，等待恢复',
    market_stale_tick: '行情报价停滞，等待恢复',
    market_unknown_no_tick: '尚未收到行情报价，等待同步',
    market_unknown: '市场状态未知，等待确认',
  }
  return labels[reason] || `等待条件恢复（${reason}）`
}

function broadcastAutoProgressDone(promptTypeId, symbol, status, reason, cycleSnapshot) {
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
            cycle_id: cycleSnapshot?.cycleId || '',
            seq: Number(cycleSnapshot?.progressSeq || 0) + 1,
            progress_percent: status === 'success' ? 100 : Number(cycleSnapshot?.progressPercent || 0),
            next_run_in_seconds: status === 'success' ? (st.intervalMinutes || 5) * 60 : Math.round(retryDelayMs(reason) / 1000),
          })
        } catch (e) { console.warn('[Scheduler] Failed to send progress_done to browser:', e.message) }
      }
      break
    }
  }
}

async function discardSharedSignalForWeeklyWindow(signalId) {
  await withTransaction(async run => {
    await run('DELETE FROM inference_snapshots WHERE signal_id = ?', [signalId])
    await run('DELETE FROM auto_signal_deliveries WHERE signal_id = ?', [signalId])
    await run('DELETE FROM ai_signals WHERE id = ?', [signalId])
  })
}

// === Reconcile: start/stop schedulers based on DB state ===
export async function reconcileAutoSchedulers() {
  try {
    // Auto-assign first strategy to users with enabled=1 but prompt_type_id=NULL
    const unassigned = await queryAll(`
      SELECT s.user_id FROM auto_scheduler s
      JOIN users u ON u.id = s.user_id
      WHERE s.enabled = 1 AND s.prompt_type_id IS NULL
        AND (u.role = 'admin' OR (u.plan = 'pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())))
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
        s.selected_symbols_json,
        apt.symbols_json,
        apt.interval_minutes
      FROM auto_scheduler s
      JOIN auto_prompt_types apt ON apt.id = s.prompt_type_id
      JOIN users u ON u.id = s.user_id
      WHERE s.enabled = 1
        AND apt.is_active = 1
        AND apt.deleted_at IS NULL
        AND (apt.scope = 'platform' OR (apt.scope = 'private' AND apt.owner_user_id = s.user_id))
        AND (u.role = 'admin' OR (u.plan = 'pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())))
    `)

    const neededKeys = new Set()
    const neededKeyMeta = {}

    for (const row of rows) {
      // Fix 4: use user's selected_symbols_json ∩ strategy symbols
      let userSymbols = []
      try {
        if (row.selected_symbols_json) {
          userSymbols = JSON.parse(row.selected_symbols_json)
        } else {
          userSymbols = parsePromptSymbols(row.symbols_json || '[]')
        }
      } catch (e) { userSymbols = parsePromptSymbols(row.symbols_json || '[]') }
      const strategySymbols = parsePromptSymbols(row.symbols_json || '[]')
      const effectiveSymbols = userSymbols.filter(s => strategySymbols.includes(s))
      for (const sym of effectiveSymbols) {
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
    stage: 'idle',
    stageLabel: '',
    progressPercent: 0,
    progressSeq: 0,
    cycleId: '',
    cycleStartedAt: '',
    stageUpdatedAt: '',
    _waitCount: 0,
    _lastLoggedWaitReason: '',
    _lastWaitLogAtMs: 0,
  }

  console.log(`[UnifiedScheduler] Started ${key} (subscribers=${subSet.size}, interval=${intervalMinutes}min)`)
  await updateSchedulerRedisState(key, autoSchedulerState[key])

  const tick = async () => {
    const st = autoSchedulerState[key]
    if (!st?.running) return

    if (isWeeklyFlattenWindow()) {
      const delay = Math.max(1000, currentWeeklyFlattenEnd().getTime() - Date.now())
      st.lastError = null
      st.waitReason = 'weekly_flatten_window'
      st.nextRunInSeconds = Math.round(delay / 1000)
      await updateSchedulerRedisState(key, st)
      autoSchedulerState[key].timer = setTimeout(tick, delay)
      return
    }

    const redis = getRedis()
    if (!redis || !isRedisAvailable()) {
      st._waitCount = (st._waitCount || 0) + 1
      if (shouldLogSchedulerWait(st, 'redis_unavailable')) console.log(`[UnifiedScheduler] ${key}: ${schedulerWaitLabel('redis_unavailable')}`)
      st.lastError = null
      st.waitReason = 'redis_unavailable'
      const delay = retryDelayMs('redis_unavailable')
      st.nextRunInSeconds = Math.round(delay / 1000)
      await updateSchedulerRedisState(key, st)
      autoSchedulerState[key].timer = setTimeout(tick, delay)
      return
    }

    try {
      const ttl = await redis.ttl(`${REDIS_COOLDOWN_PREFIX}${key}`)
      if (ttl > 0) {
        st.nextRunInSeconds = ttl
        st.waitReason = 'cooldown'
        await updateSchedulerRedisState(key, st)
        autoSchedulerState[key].timer = setTimeout(tick, Math.min(ttl * 1000, 30000))
        return
      }
    } catch (e) {
      console.warn('[Scheduler] Redis TTL check failed, failing closed:', e.message)
      st.waitReason = 'redis_error'
      st.lastError = 'cooldown_check_failed'
      autoSchedulerState[key].timer = setTimeout(tick, 15000)
      return
    }

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

    // Resolve the strategy before choosing its market-data bridge. Platform
    // strategies use the platform market bridge; private strategies are
    // strictly owner-only and use the owner's own bridge/model.
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
    const platformBridgeUserId = ptRow.scope === 'private' ? null : await getActiveAdminBridgeUserId()
    const marketUserId = ptRow.scope === 'private' ? Number(ptRow.owner_user_id) : platformBridgeUserId
    if (!marketUserId || !isBridgeAlive(marketUserId)) {
      st._waitCount = (st._waitCount || 0) + 1
      st.lastError = null
      st.waitReason = ptRow.scope === 'private' ? 'owner_bridge_offline' : 'admin_bridge_offline'
      if (shouldLogSchedulerWait(st, st.waitReason)) console.log(`[UnifiedScheduler] ${key}: ${schedulerWaitLabel(st.waitReason)}`)
      const delay = retryDelayMs(st.waitReason)
      st.nextRunInSeconds = Math.round(delay / 1000)
      await updateSchedulerRedisState(key, st)
      autoSchedulerState[key].timer = setTimeout(tick, delay)
      return
    }

    const marketProbe = await mt5Bridge(marketUserId, 'market_state', { symbol }, { timeoutMs: 5000, noFallback: true })
    if (marketProbe?.status === 'success') recordBridgeMarketState(marketUserId, marketProbe)
    const marketState = getOwnBridgeMarketState(marketUserId, symbol)
    st.marketState = marketState
    if (!marketState.isOpen) {
      st._waitCount = (st._waitCount || 0) + 1
      if (shouldLogSchedulerWait(st, marketState.reason)) console.log(`[UnifiedScheduler] ${key}: ${schedulerWaitLabel(marketState.reason)}`)
      st.lastError = null
      st.waitReason = marketState.reason
      const delay = retryDelayMs(marketState.reason)
      st.nextRunInSeconds = Math.round(delay / 1000)
      await updateSchedulerRedisState(key, st)
      autoSchedulerState[key].timer = setTimeout(tick, delay)
      return
    }

    st._waitCount = 0
    st._lastLoggedWaitReason = ''
    st._lastWaitLogAtMs = 0
    st.lastError = null
    st.waitReason = ''

    // Resolve the exact runtime model. Private model failures never switch to
    // another model after a request starts; missing configuration pauses here.
    let resolvedConfig
    try {
      resolvedConfig = await getUnifiedAutoInferenceConfig(promptTypeId, ptRow.scope === 'private' ? marketUserId : null)
    } catch (error) {
      st.lastError = error.message || 'no_api_key'
      st.waitReason = ''
      const delay = retryDelayMs(st.lastError)
      st.nextRunInSeconds = Math.round(delay / 1000)
      await updateSchedulerRedisState(key, st)
      autoSchedulerState[key].timer = setTimeout(tick, delay)
      return
    }

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
    st.stage = 'starting'
    st.stageLabel = '正在启动推理'
    st.progressPercent = 2
    st.progressSeq = 0
    st.cycleStartedAt = new Date().toISOString()
    st.stageUpdatedAt = st.cycleStartedAt
    st.cycleId = `${key}:${Date.now()}`
    st.lastError = ''
    st.waitReason = ''

    // Lock guard: structured lock context passed to cycle (Fix 1: closure, not arrow+this)
    const lockGuard = createLockGuard(key, lockToken)
    lockGuard.renewTimer = setInterval(async () => {
      if (lockGuard.lost || lockGuard.token !== lockToken) { clearInterval(lockGuard.renewTimer); return }
      const renewed = await renewLock(key, lockToken)
      if (!renewed) {
        lockGuard.lost = true
        console.error(`[LockGuard] ${key}: lock renewal failed — lock lost`)
        clearInterval(lockGuard.renewTimer)
      }
    }, LOCK_RENEW_INTERVAL_MS)
    st._lockGuard = lockGuard

    let cycleStatus = 'error'
    let cycleReason = 'exception'
    let cycleSnapshot = null
    try {
      if (lockGuard.lost) { cycleReason = 'lock_lost'; throw new Error('lock lost during renewal') }
      const cycleResult = await runUnifiedAutoCycle(promptTypeId, symbol, lockGuard, {
        strategy: ptRow,
        inferenceUserId: marketUserId,
        config: resolvedConfig,
      })
      if (cycleResult?.status === 'success') {
        st.lastError = ''
        st.lastRunAt = cycleResult.createdAt
        st.lastSignalId = cycleResult.signalId
        st.subscriberCount = cycleResult.subscriberCount
        cycleStatus = 'success'
      } else if (cycleResult?.status === 'blocked') {
        st.lastError = cycleResult.reason
        cycleStatus = 'blocked'
        cycleReason = cycleResult.reason
      } else {
        cycleReason = cycleResult?.reason || 'unknown'
      }
    } catch (e) {
      console.error(`[UnifiedScheduler] ${key} cycle error:`, e.message)
      st.lastError = 'exception'
      cycleReason = 'exception'
    } finally {
      // Stop lock renewal timer
      if (lockGuard.renewTimer) clearInterval(lockGuard.renewTimer)
      // Atomic finalize: cooldown + release lock in one Lua eval
      const cooldownSecs = cycleStatus === 'success' ? st.intervalMinutes * 60
        : cycleStatus === 'blocked' ? Math.round(retryDelayMs(cycleReason) / 1000)
        : Math.round(retryDelayMs(cycleReason) / 1000)
      st.nextRunInSeconds = cooldownSecs
      const finalized = await finalizeLock(key, lockToken, cooldownSecs)
      if (!finalized) {
        st.waitReason = 'finalize_failed'
        st.lastError = 'finalize_failed'
        st._recoveryDeadlineMs = Date.now() + cooldownSecs * 1000
      }
      st._lockToken = null
      st._lockGuard = null
      cycleSnapshot = {
        cycleId: st.cycleId,
        progressSeq: st.progressSeq,
        progressPercent: st.progressPercent,
      }
      st.inFlight = false
      st.stage = 'idle'
      st.stageLabel = ''
      st.progressPercent = 0
      st.cycleId = ''
      st.cycleStartedAt = ''
      st.stageUpdatedAt = ''
      await updateSchedulerRedisState(key, st)
    }

    // Broadcast progress done
    broadcastAutoProgressDone(promptTypeId, symbol, cycleStatus, cycleReason, cycleSnapshot)

    // Schedule next tick (Fix 1+3: finalize failure → recovery, not blind retry)
    if (autoSchedulerState[key]?.running) {
      if (st.waitReason === 'finalize_failed') {
        const recoveryState = st
        const isCurrent = () => autoSchedulerState[key] === recoveryState && recoveryState.running
        const scheduleRecovery = (fn, delayMs) => {
          if (isCurrent()) recoveryState._recoveryTimer = setTimeout(fn, delayMs)
        }
        const resumeNormalTick = async () => {
          if (!isCurrent()) return
          recoveryState._recoveryTimer = null
          recoveryState._recoveryDeadlineMs = null
          recoveryState.waitReason = ''
          recoveryState.lastError = ''
          recoveryState.nextRunInSeconds = 0
          await updateSchedulerRedisState(key, recoveryState)
          if (isCurrent()) recoveryState.timer = setTimeout(tick, 0)
        }
        // Recovery polls Redis state only. It resumes normal tick after the
        // original cooldown deadline instead of extending that deadline.
        const _recoveryFn = async () => {
          if (!isCurrent()) return
          const redis = getRedis()
          if (!redis || !isRedisAvailable()) {
            scheduleRecovery(_recoveryFn, 15000)
            return
          }
          try {
            const lockVal = await redis.get(`${REDIS_LOCK_PREFIX}${key}`)
            if (!isCurrent()) return
            if (lockVal && lockVal !== lockToken) {
              const ttl = await redis.ttl(`${REDIS_LOCK_PREFIX}${key}`)
              if (!isCurrent()) return
              recoveryState.nextRunInSeconds = ttl > 0 ? ttl : 15
              await updateSchedulerRedisState(key, recoveryState)
              scheduleRecovery(_recoveryFn, 15000)
              return
            }
            const cooldownTtl = await redis.ttl(`${REDIS_COOLDOWN_PREFIX}${key}`)
            if (!isCurrent()) return
            if (cooldownTtl > 0) {
              recoveryState.waitReason = 'cooldown_recovered'
              recoveryState.nextRunInSeconds = cooldownTtl
              await updateSchedulerRedisState(key, recoveryState)
              scheduleRecovery(_recoveryFn, Math.min(cooldownTtl * 1000, 30000))
              return
            }

            const remainingSeconds = calculateRecoverySeconds(recoveryState._recoveryDeadlineMs)
            if (remainingSeconds > 0) {
              const wrote = await redis.set(`${REDIS_COOLDOWN_PREFIX}${key}`, '1', 'EX', remainingSeconds, 'NX')
              if (!isCurrent()) return
              if (!wrote) {
                const racedTtl = await redis.ttl(`${REDIS_COOLDOWN_PREFIX}${key}`)
                if (!isCurrent()) return
                if (racedTtl <= 0) throw new Error('cooldown recovery write was not confirmed')
              }
              recoveryState.waitReason = 'cooldown_recovered'
              recoveryState.nextRunInSeconds = remainingSeconds
              await updateSchedulerRedisState(key, recoveryState)
              scheduleRecovery(_recoveryFn, Math.min(remainingSeconds * 1000, 30000))
              return
            }

            // The original cooldown has elapsed. Remove only our stale lock,
            // then return to the normal lock-acquiring tick.
            if (lockVal === lockToken) {
              const released = await finalizeLock(key, lockToken, 0)
              if (!isCurrent()) return
              if (!released) {
                scheduleRecovery(_recoveryFn, 15000)
                return
              }
            }
            await resumeNormalTick()
          } catch (e) {
            console.error(`[UnifiedScheduler] ${key} recovery check error:`, e.message)
            scheduleRecovery(_recoveryFn, 15000)
          }
        }
        scheduleRecovery(_recoveryFn, 10000)
      } else {
        const delay = cycleStatus === 'success' ? tickIntervalMs : retryDelayMs(cycleReason)
        autoSchedulerState[key].timer = setTimeout(tick, delay)
      }
    }
  }

  autoSchedulerState[key].timer = setTimeout(tick, tickIntervalMs)
}

async function stopUnifiedScheduler(promptTypeId, symbol) {
  const key = buildSchedulerKey(promptTypeId, symbol)
  const state = autoSchedulerState[key]
  if (state?.timer) clearTimeout(state.timer)
  if (state?._lockGuard?.renewTimer) clearInterval(state._lockGuard.renewTimer)
  if (state?._recoveryTimer) clearTimeout(state._recoveryTimer)
  if (autoSchedulerState[key]) autoSchedulerState[key].running = false
  delete autoSchedulerState[key]
  console.log(`[UnifiedScheduler] Stopped ${key}`)
  await updateSchedulerRedisState(key, { running: false, intervalMinutes: 0, subscriberCount: 0, lastError: '', lastRunAt: '' })
}

// === Unified Auto Cycle: shared signal generation ===
async function runUnifiedAutoCycle(promptTypeId, symbol, lockGuard, preflight = {}) {
  const key = buildSchedulerKey(promptTypeId, symbol)
  const ts = () => new Date().toISOString()
  const l = (msg) => console.log(`[UnifiedCycle ${key}] ${ts()} ${symbol}: ${msg}`)

  if (isWeeklyFlattenWindow()) return { status: 'blocked', reason: 'weekly_flatten_window' }

  l('>>> cycle start')
  await broadcastAutoProgress(promptTypeId, symbol, { stage: 'config', label: '检查策略与模型', progress_percent: 6 })

  // 1. Read prompt type
  const pt = Number(preflight.strategy?.id) === Number(promptTypeId)
    ? preflight.strategy
    : await getAutoPromptTypeById(promptTypeId)
  if (!pt || !pt.is_active) { l('BLOCKED: prompt type not found or disabled'); return { status: 'blocked', reason: 'strategy_disabled' } }
  const supportedSymbols = parsePromptSymbols(pt.symbols_json)
  if (!supportedSymbols.includes(symbol.toUpperCase())) { l(`BLOCKED: symbol ${symbol} not in strategy symbols`); return { status: 'blocked', reason: 'symbol_not_supported' } }

  const isPrivate = pt.scope === 'private'
  const preflightUserId = Number(preflight.inferenceUserId)
  const platformBridgeUserId = isPrivate || preflightUserId > 0 ? null : await getActiveAdminBridgeUserId()
  const inferenceUserId = preflightUserId > 0
    ? preflightUserId
    : isPrivate ? Number(pt.owner_user_id) : platformBridgeUserId
  const signalSource = isPrivate ? 'auto_private' : 'auto_shared'
  if (!inferenceUserId || !isBridgeAlive(inferenceUserId)) {
    return { status: 'blocked', reason: isPrivate ? 'owner_bridge_offline' : 'admin_bridge_offline' }
  }
  const configuredMemoryMode = isPrivate
    ? (await queryOne(`SELECT memory_mode FROM strategy_subscriptions
        WHERE user_id = ? AND strategy_id = ? AND is_deleted = 0 ORDER BY updated_at DESC LIMIT 1`,
      [inferenceUserId, promptTypeId]))?.memory_mode || 'personal'
    : 'platform_only'

  // 2. Resolve platform-primary or private owner model without runtime fallback.
  let config = preflight.config || null
  if (!config) {
    try {
      config = await getUnifiedAutoInferenceConfig(promptTypeId, isPrivate ? inferenceUserId : null)
    } catch (error) {
      l(`BLOCKED: model resolution failed (${error.message})`)
      return { status: 'blocked', reason: error.message || 'no_model_configured' }
    }
  }
  if (!config || !config.api_key_encrypted) {
    l(`BLOCKED: no API key (hasKey=${!!config?.api_key_encrypted})`)
    return { status: 'blocked', reason: 'no_api_key' }
  }

  // Usage belongs to the private owner. Platform inference remains user 0 and
  // only uses the admin connection as a market-data transport.
  config._userId = isPrivate ? inferenceUserId : 0

  try {
    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'bridge', label: isPrivate ? '获取账户与行情数据' : '获取平台行情数据', progress_percent: 16 })
    const t0 = Date.now()
    let account = null
    let positions = []
    let pendingOrders = []
    l(`bridge done (${Date.now()-t0}ms, positions=${positions.length}, pending=${pendingOrders.length})`)

    const prompt = config.system_prompt || ''
    const tags = Array.isArray(config._market_data_plan?.timeframes) && config._market_data_plan.timeframes.length
      ? config._market_data_plan.timeframes.map(item => ({ tf: item.timeframe, count: item.kline_count }))
      : [{ tf: 'M30', count: 100 }]
    const primaryTf = tags.length > 0 ? tags[0].tf : 'M5'
    const usedTimeframes = tags.length > 0 ? tags.map(t => t.tf) : ['M5']
    const primaryCount = tags.length > 0 ? tags[0].count : 100
    const useChanAnalysis = Boolean(config._use_chan_analysis)
    const primaryHistoryCount = resolveChanHistoryCount(inferenceUserId, symbol, primaryTf, primaryCount, useChanAnalysis)
    const t1 = Date.now()
    const ratesResp = await platformRates(inferenceUserId, { symbol, timeframe: primaryTf, count: primaryHistoryCount })
    if (!ratesResp || ratesResp.status === 'error') { l(`BLOCKED: rates failed`); return { status: 'blocked', reason: 'rates_failed' } }
    const rates = ratesResp.rates || []
    if (!Array.isArray(rates) || rates.length === 0) { l(`BLOCKED: rates empty`); return { status: 'blocked', reason: 'rates_empty' } }
    l(`rates done (${Date.now()-t1}ms, bars=${rates.length}, tf=${primaryTf})`)

    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'market', label: '计算指标与市场结构', progress_percent: 31 })
    const t2 = Date.now()
    let market = calculateMarketData(symbol, primaryTf, rates.slice(-primaryCount), account, positions, { pending_orders: pendingOrders })
    market.strategy_context = await buildStrategyContextFromTags(inferenceUserId, symbol, account, positions, prompt, primaryTf, rates, 'auto', config._market_data_plan, useChanAnalysis, ratesResp.market_meta)
    if (useChanAnalysis) market.chan = market.strategy_context?.timeframes?.[primaryTf]?.summary?.chan
    market.primary_timeframe = primaryTf
    await attachAtrAnchor(inferenceUserId, symbol, market, primaryTf)
    market.requested_timeframes = market.strategy_context.required_timeframes || usedTimeframes
    market.used_timeframes = market.strategy_context.used_timeframes || Object.keys(market.strategy_context?.timeframes || {})
    market.missing_timeframes = market.strategy_context.missing_timeframes || market.requested_timeframes.filter(tf => !market.used_timeframes.includes(tf))
    market = buildSharedMarketSnapshot(market, {
      standardSymbol: symbol,
      volumeMin: config._ai_volume_min,
      volumeMax: config._ai_volume_max,
      marketSource: ratesResp.market_meta?.source || 'platform_admin_bridge',
    })
    l(`market calc done (${Date.now()-t2}ms, price=${market.latest_price})`)

    let memory = { promptBlock: '', mode: 'off', logId: null }
    if (isPrivate && configuredMemoryMode !== 'off' && configuredMemoryMode !== 'platform_only') {
      try {
        memory = await retrievePersonalMemory({ userId: inferenceUserId, strategyId: promptTypeId,
          strategyVersion: Number(pt.version || 1), symbol, timeframe: primaryTf,
          mode: configuredMemoryMode === 'shadow' ? 'shadow' : 'active' })
        config._memoryContext = memory.promptBlock
        config._memoryMode = memory.mode
      } catch (error) {
        l(`personal memory unavailable; continuing without it (${error.message})`)
      }
    } else if (!isPrivate) {
      try {
        memory = await retrievePlatformExperience({ strategyId: promptTypeId, symbol, timeframe: primaryTf,
          market, allowedEntryMethods:config._allowed_entry_methods })
        config._platformExperienceContext = memory.promptBlock
        config._memoryMode = `platform_${memory.mode}`
      } catch (error) {
        l(`platform experience unavailable; continuing without it (${error.message})`)
      }
    }

    config._experienceSelection = { source:isPrivate ? 'personal' : 'platform',
      selectedItemIds:memory.promptBlock ? (memory.selectedItemIds || []) : [],
      selectionDetails:memory.promptBlock ? (memory.selectionDetails || []) : [] }

    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'ai', label: 'AI 模型深度推理', progress_percent: 46 })
    const t3 = Date.now()
    l(`calling AI (model=${config.model_name}, thinking=${config.thinking_enabled !== false}, effort=${config.reasoning_effort || 'max'})...`)
    let renderedEvidence = null
    config._onInferencePrepared = evidence => { renderedEvidence = evidence }
    let signal = await maybeAiSignal(null, config, market)
    delete config._onInferencePrepared
    market.inference_source = signal._inference_source || 'unknown'
    const aiSource = signal._inference_source
    delete signal._inference_source
    l(`AI done (${Date.now()-t3}ms, type=${signal.signal_type}, confidence=${signal.confidence}, source=${aiSource})`)
    if (aiSource === 'ai_error_hold') {
      l(`BLOCKED: AI inference failed (${signal.reasoning || 'unknown error'})`)
      await insertAudit(null, isPrivate ? inferenceUserId : 0, 'ai_auto_scan', symbol,
        { trigger: 'timer', prompt_type_id: promptTypeId, symbol, timeframe: primaryTf },
        { status: 'error', reason: 'ai_failed', message: signal.reasoning || '' }, 'error')
      return { status: 'blocked', reason: 'ai_failed' }
    }

    // An inference started before 04:00 must not persist, broadcast or execute
    // after the weekly flatten window begins.
    if (isWeeklyFlattenWindow()) {
      l('BLOCKED: weekly flatten window began during inference')
      return { status: 'blocked', reason: 'weekly_flatten_window' }
    }

    // Freeze the subscriber set before atomically writing the shared signal
    // and all per-user deliveries.
    const st = autoSchedulerState[key]
    const allSubscribers = st?.subscribers || new Set()
    const onlineSubscribers = new Set()
    for (const uid of allSubscribers) {
      if (isBridgeAlive(uid)) onlineSubscribers.add(uid)
    }

    // 4. Write shared signal and deliveries in one transaction.
    if (lockGuard && !(await lockGuard.assertOwned('signal_write'))) {
      l('BLOCKED: lock lost before signal write')
      return { status: 'error', reason: 'lock_lost' }
    }
    const createdAt = beijingNow()
    const marketJson = JSON.stringify(market)
    const decision = normalizeDecisionFields(signal)
    const decisionJson = JSON.stringify(decision)
    const tokenCount = Math.round(((signal.analysis || '').length + (signal.reasoning || '').length + marketJson.length) / 4)
    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'persist', label: '校验并保存推理结果', progress_percent: 84 })
    const signalId = await withTransaction(async run => {
      const [signalResult] = await run(`
        INSERT INTO ai_signals(user_id, config_id, prompt_type_id, session_id, source, symbol, timeframe, signal_type, confidence,
          recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price,
          take_profit_2_price, take_profit_3_price, recommended_take_profit_tier, market_data_json, token_count, ai_model, ttl_seconds, is_executed, created_at,
          entry_method, limit_price, stop_limit_price, pending_valid_until, schema_version, decision_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
      `, [
        isPrivate ? inferenceUserId : 0, 0, promptTypeId, signalSource, signalSource, symbol, primaryTf,
        signal.signal_type, signal.confidence, signal.recommended_volume,
        signal.analysis, signal.reasoning, signal.stop_loss_price,
        signal.take_profit_1_price, signal.take_profit_2_price, signal.take_profit_3_price, signal.recommended_take_profit_tier || null,
        marketJson, tokenCount, config.model_name || 'deepseek-chat', signalTtlSeconds(primaryTf), createdAt,
        signal.entry_method || 'market', signal.limit_price || null, signal.stop_limit_price || null, signal.pending_valid_until || null,
        SIGNAL_SCHEMA_VERSION, decisionJson
      ])
      const insertedSignalId = signalResult.insertId
      if (!renderedEvidence) throw new Error('inference_evidence_missing')
      await persistInferenceSnapshotTx(run, {
        signalId: insertedSignalId,
        strategyId: promptTypeId,
        strategyVersion: Number(pt.version || 1),
        strategyScope: pt.scope || 'platform',
        ownerUserId: isPrivate ? inferenceUserId : 0,
        standardSymbol: stripBrokerSuffix(symbol).toUpperCase(),
        marketSource: ratesResp.market_meta?.source || 'platform_admin_bridge',
        systemPrompt: renderedEvidence.systemPrompt,
        userPrompt: renderedEvidence.userPrompt,
        outputSchemaVersion: renderedEvidence.outputSchemaVersion,
        marketSnapshot: market,
        modelProfileId: config._model_profile_id,
        provider: config.api_provider,
        modelName: config.model_name,
        credentialSource: config._credential_source,
        memoryMode: isPrivate ? (memory.mode || 'off') : `platform_${memory.mode || 'off'}`,
        createdAt,
      })
      const deliveryValues = []
      const deliveryParams = []
      for (const uid of onlineSubscribers) {
        deliveryValues.push('(?, ?, ?, ?, ?, ?, ?, ?)')
        deliveryParams.push(insertedSignalId, uid, promptTypeId, symbol, 'delivered', 'not_attempted', 0, createdAt)
      }
      if (deliveryValues.length > 0) {
        await run(
          `INSERT INTO auto_signal_deliveries (signal_id, user_id, prompt_type_id, symbol, delivery_status, execution_status, is_executed, created_at)
           VALUES ${deliveryValues.join(',')}`,
          deliveryParams
        )
      }
      return insertedSignalId
    })
    signal.id = signalId
    if (isPrivate && memory.logId) {
      try { await attachMemoryInjectionSignal(memory.logId, inferenceUserId, signalId) }
      catch (error) { l(`memory attribution failed (${error.message})`) }
    }
    signal.symbol = symbol
    signal.timeframe = primaryTf
    signal.created_at = createdAt
    signal.market_data = market
    signal.is_executed = false
    signal.config_id = 0
    signal.session_id = signalSource
    signal.source = signalSource
    signal = attachSignalPresentation({ ...signal, ...decision, decision_json: decisionJson })
    signal.prompt_type_id = promptTypeId
    signal.ai_model = config.model_name || 'deepseek-chat'
    attachSignalTiming(signal, ratesResp.market_meta?.timezone_offset_minutes)
    l(`shared signal #${signalId} saved`)

    if (isWeeklyFlattenWindow()) {
      l('BLOCKED: weekly flatten window began before signal delivery')
      await discardSharedSignalForWeeklyWindow(signalId)
      return { status: 'blocked', reason: 'weekly_flatten_window' }
    }

    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'publish', label: '发布信号与执行建议', progress_percent: 94 })
    // 7. Notify online subscribers
    for (const uid of onlineSubscribers) {
      if (isWeeklyFlattenWindow()) {
        l('BLOCKED: weekly flatten window began during signal delivery')
        return { status: 'blocked', reason: 'weekly_flatten_window' }
      }
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
    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'delivery', label: '同步信号与执行状态', progress_percent: 96 })

    // 7.5 AI cancel_pending: cancel matching pending orders for eligible subscribers only (lock check)
    if (isWeeklyFlattenWindow()) {
      l('BLOCKED: weekly flatten window began before cancel_pending')
      return { status: 'blocked', reason: 'weekly_flatten_window' }
    }
    if (lockGuard && !(await lockGuard.assertOwned('cancel_pending'))) {
      l('BLOCKED: lock lost before cancel_pending')
      return { status: 'error', reason: 'lock_lost' }
    }
    if (Array.isArray(signal.cancel_pending) && signal.cancel_pending.length > 0) {
      // Normalize conditions and filter to valid ones
      const validConds = []
      for (const cond of signal.cancel_pending) {
        const nc = normalizeCancelCondition(cond, symbol)
        if (nc) validConds.push(nc)
        else {
          l(`cancel_pending: ignored invalid condition: ${JSON.stringify(cond)}`)
          await insertAudit(null, 0, 'cancel_pending_invalid', symbol,
            { signal_id: signalId, condition: cond }, { status: 'ignored', reason: 'invalid_condition' }, 'info')
        }
      }
      if (validConds.length > 0) {
        l(`cancel_pending: ${validConds.length} valid condition(s)`)
        for (const uid of onlineSubscribers) {
          if (isWeeklyFlattenWindow()) {
            l('BLOCKED: weekly flatten window began during cancel_pending')
            return { status: 'blocked', reason: 'weekly_flatten_window' }
          }
          // Permission gate: must be eligible for auto execution
          const eligible = await isUserEligibleForAutoExecution(uid)
          if (!eligible) {
            l(`cancel_pending: skipped user=${uid} (not eligible for auto execution)`)
            continue
          }
          // Lock check per user (Fix 2)
          if (lockGuard && !(await lockGuard.assertOwned('cancel_user'))) {
            l(`cancel_pending: skipped user=${uid} (lock lost)`)
            break
          }
          try {
            const pendingResp = await mt5Bridge(uid, 'pending_list', { symbol }, { noFallback: true })
            const pendingOrders = pendingResp?.orders || pendingResp?.pending_list || []
            if (!Array.isArray(pendingOrders) || !pendingOrders.length) continue
            // Collect tickets to cancel (deduplicate by userId+ticket)
            const ticketsToCancel = new Map() // ticket -> condition
            for (const cond of validConds) {
              for (const po of pendingOrders) {
                const match = matchPendingCancelCondition(po, cond)
                if (match.reason === 'invalid_pending_price') {
                  l(`cancel_pending: skipped ticket=${po.ticket} (invalid_pending_price: ${po.price})`)
                  await insertAudit(null, uid, 'cancel_pending_invalid_price', symbol,
                    { signal_id: signalId, ticket: po.ticket, price: po.price },
                    { status: 'skipped', reason: 'invalid_pending_price' }, 'info')
                  continue
                }
                if (match.reason === 'invalid_pending_ticket') {
                  l('cancel_pending: skipped entry with empty ticket')
                  await insertAudit(null, uid, 'cancel_pending_invalid_ticket', symbol,
                    { signal_id: signalId, ticket: po.ticket },
                    { status: 'skipped', reason: 'invalid_pending_ticket' }, 'info')
                  continue
                }
                if (match.matched) ticketsToCancel.set(match.ticket, cond)
              }
            }
            for (const [ticket, cond] of ticketsToCancel) {
              if (isWeeklyFlattenWindow()) {
                l('BLOCKED: weekly flatten window began before cancel ticket')
                return { status: 'blocked', reason: 'weekly_flatten_window' }
              }
              // Re-check bridge and trade state before each cancel
              if (!isBridgeAlive(uid) || !isTradeEnabled(uid)) {
                l(`cancel_pending: skipped ticket=${ticket} (bridge/trade state changed)`)
                continue
              }
              // Lock check per ticket (Fix 2)
              if (lockGuard && !(await lockGuard.assertOwned('cancel_ticket'))) {
                l(`cancel_pending: stopped at ticket=${ticket} (lock lost)`)
                break
              }
              try {
                const cancelResult = await mt5Bridge(uid, 'cancel_pending', { ticket }, { noFallback: true })
                if (cancelResult?.status !== 'success') {
                  l(`cancel_pending failed (MT5): user=${uid} ticket=${ticket}: ${cancelResult?.message || 'unknown'}`)
                  await insertAudit(null, uid, 'ai_cancel_pending_failed', symbol,
                    { signal_id: signalId, prompt_type_id: promptTypeId, ticket, error: cancelResult?.message },
                    { status: 'error', message: cancelResult?.message }, 'warning')
                  continue
                }
                await queryRun(
                  "UPDATE auto_signal_deliveries SET pending_state = 'cancelled' WHERE pending_ticket = ? AND user_id = ?",
                  [ticket, uid]).catch(() => {})
                l(`cancel_pending: user=${uid} ticket=${ticket}`)
                await insertAudit(null, uid, 'ai_cancel_pending', symbol,
                  { signal_id: signalId, prompt_type_id: promptTypeId, ticket, reason: cond.reason },
                  { status: 'cancelled', ticket }, 'success')
              } catch (cancelErr) {
                l(`cancel_pending exception: user=${uid} ticket=${ticket}: ${cancelErr.message}`)
                await insertAudit(null, uid, 'ai_cancel_pending_failed', symbol,
                  { signal_id: signalId, prompt_type_id: promptTypeId, ticket, error: cancelErr.message },
                  { status: 'error', message: cancelErr.message }, 'warning')
              }
            }
          } catch (e) {
            l(`cancel_pending bridge error: user=${uid}: ${e.message}`)
          }
        }
      }
    }

    // 8. Auto-trade for eligible subscribers (limited concurrency) (lock check)
    if (lockGuard && !(await lockGuard.assertOwned('auto_trade'))) {
      l('BLOCKED: lock lost before auto-trade')
      return { status: 'error', reason: 'lock_lost' }
    }
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
            AND (u.role = 'admin' OR (u.plan = 'pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())))
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
          executeDelivery(uid, signalId, signal, config, market, promptTypeId, symbol, createdAt, lockGuard)
        ))
      }
    }

    // Paid paired inference is an explicitly user-enabled experiment. The
    // control run never enters delivery/execution and runs only after the
    // treatment signal has completed its normal trading path.
    if (isPrivate && memory.pairedExperimentEnabled && memory.mode === 'active' && memory.promptBlock) {
      await broadcastAutoProgress(promptTypeId, symbol, { stage: 'verify', label: '完成记忆效果评估', progress_percent: 98 })
      let control = null
      let pairStatus = 'failed'
      let pairError = null
      try {
        const controlConfig = { ...config, _memoryContext: '', _memoryMode: 'off' }
        delete controlConfig._onInferencePrepared
        control = await maybeAiSignal(null, controlConfig, market)
        const controlSource = control?._inference_source
        if (control) delete control._inference_source
        pairStatus = controlSource === 'ai' ? 'succeeded' : 'failed'
        pairError = pairStatus === 'failed' ? (control?.reasoning || 'paired_control_failed') : null
      } catch (error) {
        pairError = error.message || 'paired_control_failed'
      }
      try {
        await recordPairedInferenceRun({ userId: inferenceUserId, strategyId: promptTypeId,
          signalId, memoryLogId: memory.logId, treatment: signal, control,
          status: pairStatus, errorCode: pairError })
      } catch (error) {
        l(`paired inference evidence write failed (${error.message})`)
      }
    }

    // Normal hold signals remain in signal history but do not create audit noise.
    if (signal.signal_type !== 'hold') {
      await insertAudit(null, isPrivate ? inferenceUserId : 0, 'ai_auto_scan', symbol, {
        trigger: 'timer', prompt_type_id: promptTypeId, symbol, timeframe: primaryTf, signal_id: signalId
      }, {
        status: 'success', signal_id: signalId, signal_type: signal.signal_type, confidence: signal.confidence,
        subscriber_count: onlineSubscribers.size, inference_source: aiSource,
      }, 'success')
    }
    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'complete', label: '推理结果已生成', progress_percent: 100 })
    l(`<<< cycle complete (signal=#${signalId}, subscribers=${onlineSubscribers.size})`)
    return { status: 'success', signalId, subscriberCount: onlineSubscribers.size, createdAt }
  } catch (err) {
    l(`<<< EXCEPTION: ${err.message}`)
    console.error(`[UnifiedCycle] ${key} error:`, err.message)
    await insertAudit(null, isPrivate ? inferenceUserId : 0, 'ai_auto_scan', symbol, { prompt_type_id: promptTypeId, symbol }, { status: 'error', message: err.message }, 'error')
    return { status: 'error', reason: 'exception', message: err.message }
  }
}

// === Delivery execution for a single subscriber ===
async function executeDelivery(userId, signalId, signal, unifiedConfig, market, promptTypeId, symbol, createdAt, lockGuard) {
  const l = (msg) => console.log(`[Delivery U${userId}] signal=${signalId} ${symbol}: ${msg}`)
  const setTerminalStatus = (status, reason, details = {}) => queryRun(
    'UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE signal_id = ? AND user_id = ?',
    [status, JSON.stringify({ reason, ...details }), signalId, userId])
  try {
    if (isWeeklyFlattenWindow()) {
      await setTerminalStatus('skipped', 'weekly_flatten_window')
      return
    }
    // Lock check before claiming (Fix 2)
    if (lockGuard && !(await lockGuard.assertOwned('delivery_claim'))) {
      l('skipped: lock lost before claim')
      return
    }
    const subscriptionRuntime = await getDeliverySubscriptionRuntime(userId, promptTypeId, symbol)
    if (!subscriptionRuntime) {
      await setTerminalStatus('skipped', 'subscription_inactive')
      return
    }
    if (!subscriptionRuntime.in_schedule) {
      await setTerminalStatus('skipped', 'outside_schedule', { subscription_id: subscriptionRuntime.id })
      return
    }
    // Atomic delivery claiming: only one executor can proceed (Fix 3)
    const claimed = await queryRun(
      `UPDATE auto_signal_deliveries SET execution_status = 'executing', execution_claimed_at = NOW()
       WHERE signal_id = ? AND user_id = ? AND execution_status = 'not_attempted'`,
      [signalId, userId])
    if (!claimed || claimed.changes !== 1) {
      l('skipped: already claimed or terminal state')
      return
    }

    const riskConfig = await getDeliveryExecuteRiskConfig(userId)
    if (riskConfig) riskConfig.take_profit_mode = subscriptionRuntime.take_profit_mode || 'ai_recommended'
    if (!riskConfig?.enable_auto_trade) {
      l('skipped: enable_auto_trade=false')
      await queryRun('UPDATE auto_signal_deliveries SET execution_status = ? WHERE signal_id = ? AND user_id = ?',
        ['skipped', signalId, userId])
      await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'auto_trade_disabled' },
        { status: 'skipped' }, 'info')
      return
    }

    // Use user's own bridge for execution
    if (!isBridgeAlive(userId)) {
      l('skipped: bridge not alive')
      await queryRun('UPDATE auto_signal_deliveries SET execution_status = ? WHERE signal_id = ? AND user_id = ?',
        ['skipped', signalId, userId])
      await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'bridge_offline' },
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
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'trade_send_disabled' },
        { status: 'skipped' }, 'info')
      return
    }

    const order = signalOrderPayload(signal, riskConfig, market, true)
    // Scale down volume if it exceeds user's max_position_size
    const userMaxVolume = parseFloat(riskConfig.max_position_size || DEFAULT_MAX_POSITION_SIZE)
    if (order.volume > userMaxVolume) {
      const originalVolume = order.volume
      order.volume = round2(userMaxVolume)
      l(`volume scaled: ${originalVolume} → ${order.volume} (user max=${userMaxVolume})`)
    }

    // TP/SL validation: strict fail-closed (Fix 5)
    const isBuyOrder = order.order_type === 'buy'
    // Get user's own quote — fail-closed if unavailable
    let entryRef = order.limit_price || 0
    if (!entryRef && order.order_type) {
      try {
        const quoteResp = await mt5Bridge(userId, 'quote', { symbol }, { noFallback: true })
        if (quoteResp && quoteResp.status !== 'error') {
          const ask = parseFloat(quoteResp.ask)
          const bid = parseFloat(quoteResp.bid)
          if (Number.isFinite(ask) && ask > 0 && Number.isFinite(bid) && bid > 0) {
            entryRef = isBuyOrder ? ask : bid
          }
        }
      } catch (e) { l(`quote fetch failed: ${e.message}`) }
    }
    // Strict: entryRef must be valid
    if (!entryRef || !Number.isFinite(entryRef) || entryRef <= 0) {
      l('rejected: user_quote_unavailable — no valid entry reference')
      await queryRun('UPDATE auto_signal_deliveries SET execution_status = ? WHERE signal_id = ? AND user_id = ?',
        ['rejected', signalId, userId])
      await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'user_quote_unavailable' },
        { status: 'rejected', message: 'user_quote_unavailable' }, 'warning')
      return
    }
    // SL must exist and be valid
    const slVal = order.sl != null ? parseFloat(order.sl) : null
    if (slVal == null || !Number.isFinite(slVal) || slVal <= 0) {
      l(`rejected: stop_loss_missing sl=${order.sl}`)
      await queryRun('UPDATE auto_signal_deliveries SET execution_status = ? WHERE signal_id = ? AND user_id = ?',
        ['rejected', signalId, userId])
      await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'stop_loss_missing', sl: order.sl },
        { status: 'rejected', message: 'stop_loss_missing' }, 'warning')
      return
    }
    // SL direction
    const slOk = isBuyOrder ? slVal < entryRef : slVal > entryRef
    if (!slOk) {
      l(`rejected: invalid_stop_loss_direction sl=${slVal} for ${order.order_type} at ${entryRef}`)
      await queryRun('UPDATE auto_signal_deliveries SET execution_status = ? WHERE signal_id = ? AND user_id = ?',
        ['rejected', signalId, userId])
      await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'invalid_stop_loss_direction', sl: slVal, entry: entryRef },
        { status: 'rejected', message: 'invalid_stop_loss_direction' }, 'warning')
      return
    }
    // Selected TP must exist and be valid
    const tpVal = order.tp != null ? parseFloat(order.tp) : null
    if (tpVal == null || !Number.isFinite(tpVal) || tpVal <= 0) {
      l(`rejected: take_profit_target_missing tp=${order.tp} mode=${order.tp_selection_mode} tier=${order.tp_tier_requested}`)
      await queryRun('UPDATE auto_signal_deliveries SET execution_status = ? WHERE signal_id = ? AND user_id = ?',
        ['rejected', signalId, userId])
      await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'take_profit_target_missing', tp: order.tp, mode: order.tp_selection_mode, tier: order.tp_tier_requested },
        { status: 'rejected', message: 'take_profit_target_missing' }, 'warning')
      return
    }
    // TP direction
    const tpOk = isBuyOrder ? tpVal > entryRef : tpVal < entryRef
    if (!tpOk) {
      l(`rejected: invalid_take_profit_direction tp=${tpVal} for ${order.order_type} at ${entryRef}`)
      await queryRun('UPDATE auto_signal_deliveries SET execution_status = ? WHERE signal_id = ? AND user_id = ?',
        ['rejected', signalId, userId])
      await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'invalid_take_profit_direction', tp: tpVal, entry: entryRef },
        { status: 'rejected', message: 'invalid_take_profit_direction' }, 'warning')
      return
    }

    // Supersede: cancel same-symbol SAME-DIRECTION pending orders before placing new one
    const SUPERSEDE_SAME_SYMBOL = true
    let remainingPendingCount = 0
    let remainingSameDirectionCount = 0
    const newOrderDirection = order.order_type || 'buy'
    if (SUPERSEDE_SAME_SYMBOL && order.entry_method && order.entry_method !== 'market' && order.entry_method !== 'observe') {
      try {
        const pendingList = await mt5Bridge(userId, 'pending_list', { symbol }, { noFallback: true })
        // Fix 4: pending_list failure = fail-closed
        if (!pendingList || pendingList.status === 'error' || !Array.isArray(pendingList?.orders || pendingList?.pending_list)) {
          l('rejected: pending_list_unavailable')
          await queryRun('UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE signal_id = ? AND user_id = ?',
            ['rejected', JSON.stringify({ reason: 'pending_list_unavailable' }), signalId, userId])
          await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
            { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'pending_list_unavailable' },
            { status: 'rejected', message: 'pending_list_unavailable' }, 'warning')
          return
        }
        const pendingOrders = pendingList.orders || pendingList.pending_list || []
        // Cancel same-direction orders
        for (const po of pendingOrders) {
          if (stripBrokerSuffix(String(po.symbol || '')) !== stripBrokerSuffix(symbol)) continue
          const poType = String(po.pending_type || '').toLowerCase()
          const poIsBuy = poType.startsWith('buy')
          const newIsBuy = newOrderDirection === 'buy'
          if (poIsBuy !== newIsBuy) continue // skip opposite direction
          if (isWeeklyFlattenWindow()) {
            l('skipped: weekly flatten window began before supersede cancel')
            await setTerminalStatus('skipped', 'weekly_flatten_window').catch(() => {})
            return
          }
          if (lockGuard && !(await lockGuard.assertOwned('supersede_cancel'))) {
            l(`skipped: lock lost before supersede cancel ticket=${po.ticket}`)
            await setTerminalStatus('skipped', 'lock_lost_before_supersede_cancel', { ticket: po.ticket })
            await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
              { signal_id: signalId, prompt_type_id: promptTypeId, ticket: po.ticket, reason: 'lock_lost_before_supersede_cancel' },
              { status: 'skipped', reason: 'lock_lost_before_supersede_cancel' }, 'warning')
            return
          }
          try {
            const cancelResult = await mt5Bridge(userId, 'cancel_pending', { ticket: po.ticket }, { noFallback: true })
            if (cancelResult?.status !== 'success') {
              l(`supersede cancel failed: ticket=${po.ticket}: ${cancelResult?.message || 'unknown'}`)
              await insertAudit(null, userId, 'pending_supersede_failed', symbol,
                { signal_id: signalId, ticket: po.ticket, error: cancelResult?.message },
                { status: 'error', message: cancelResult?.message }, 'warning')
              continue
            }
            await queryRun(
              "UPDATE auto_signal_deliveries SET pending_state = 'superseded' WHERE pending_ticket = ? AND user_id = ?",
              [String(po.ticket), userId])
            l(`superseded old pending: ticket=${po.ticket} (${po.pending_type})`)
            await insertAudit(null, userId, 'pending_superseded', symbol,
              { signal_id: signalId, ticket: po.ticket, pending_type: po.pending_type },
              { status: 'superseded', ticket: po.ticket }, 'info')
          } catch (cancelErr) {
            l(`supersede cancel failed: ticket=${po.ticket}: ${cancelErr.message}`)
            await insertAudit(null, userId, 'pending_supersede_failed', symbol,
              { signal_id: signalId, ticket: po.ticket, error: cancelErr.message },
              { status: 'error', message: cancelErr.message }, 'warning')
          }
        }
        // Fix 3: re-query pending_list to get real remaining count (all directions)
        try {
          if (lockGuard && !(await lockGuard.assertOwned('pending_confirm'))) {
            l('skipped: lock lost before pending_list confirmation')
            await setTerminalStatus('skipped', 'lock_lost_before_pending_confirm')
            await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
              { signal_id: signalId, prompt_type_id: promptTypeId, reason: 'lock_lost_before_pending_confirm' },
              { status: 'skipped', reason: 'lock_lost_before_pending_confirm' }, 'warning')
            return
          }
          const confirmResp = await mt5Bridge(userId, 'pending_list', { symbol }, { noFallback: true })
          if (!confirmResp || confirmResp.status === 'error' || !Array.isArray(confirmResp?.orders || confirmResp?.pending_list)) {
            l('rejected: pending_list confirm unavailable')
            await queryRun('UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE signal_id = ? AND user_id = ?',
              ['rejected', JSON.stringify({ reason: 'pending_list_confirm_unavailable' }), signalId, userId])
            await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
              { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'pending_list_confirm_unavailable' },
              { status: 'rejected', message: 'pending_list_confirm_unavailable' }, 'warning')
            return
          }
          const confirmOrders = confirmResp.orders || confirmResp.pending_list || []
          remainingPendingCount = countPendingForSymbol(confirmOrders, symbol)
          remainingSameDirectionCount = countPendingForSymbolDirection(confirmOrders, symbol, newOrderDirection)
        } catch (confirmErr) {
          l(`rejected: pending_list confirm failed: ${confirmErr.message}`)
          await queryRun('UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE signal_id = ? AND user_id = ?',
            ['rejected', JSON.stringify({ reason: 'pending_list_confirm_failed', error: confirmErr.message }), signalId, userId])
          await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
            { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'pending_list_confirm_failed' },
            { status: 'rejected', message: 'pending_list_confirm_failed' }, 'warning')
          return
        }
        if (remainingSameDirectionCount > 0) {
          l(`rejected: ${remainingSameDirectionCount} same-direction pending order(s) remain after supersede`)
          await queryRun('UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE signal_id = ? AND user_id = ?',
            ['rejected', JSON.stringify({ reason: 'pending_supersede_incomplete', remaining_same_direction: remainingSameDirectionCount }), signalId, userId])
          await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
            { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'pending_supersede_incomplete', remaining_same_direction: remainingSameDirectionCount },
            { status: 'rejected', message: 'pending_supersede_incomplete' }, 'warning')
          return
        }
      } catch (listErr) {
        l(`supersede pending_list failed: ${listErr.message}`)
        // Fix 6: pending_list exception = fail-closed
        await setTerminalStatus('rejected', 'pending_list_unavailable', { error: listErr.message })
        await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
          { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'pending_list_unavailable', error: listErr.message },
          { status: 'rejected', message: 'pending_list_unavailable' }, 'warning')
        return
      }
    }

    // Hard limit: skip if too many pending orders (including new order = 1 more)
    const MAX_PENDING_PER_SYMBOL = 2
    if (remainingPendingCount + 1 > MAX_PENDING_PER_SYMBOL && order.entry_method && order.entry_method !== 'market' && order.entry_method !== 'observe') {
      l(`skipped: ${remainingPendingCount} pending orders remain + 1 new > max ${MAX_PENDING_PER_SYMBOL}`)
      await queryRun('UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE signal_id = ? AND user_id = ?',
        ['skipped', JSON.stringify({ reason: 'pending_limit_reached', remaining: remainingPendingCount, max: MAX_PENDING_PER_SYMBOL }), signalId, userId])
      await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'pending_limit_reached', pending_count: remainingPendingCount },
        { status: 'skipped' }, 'info')
      return
    }

    // Final lock check before sending MT5 order (Fix 2)
    if (isWeeklyFlattenWindow()) {
      l('skipped: weekly flatten window began before order send')
      await setTerminalStatus('skipped', 'weekly_flatten_window').catch(() => {})
      return
    }
    if (lockGuard && !(await lockGuard.assertOwned('order_send'))) {
      l('skipped: lock lost before order send')
      await setTerminalStatus('skipped', 'lock_lost_before_send').catch(() => {})
      await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'lock_lost_before_send' },
        { status: 'skipped', reason: 'lock_lost_before_send' }, 'warning')
      return
    }
    const execResult = await executeOrder(userId, riskConfig, order, 'ai_auto_execute', {
      noFallback: true,
      sourceType: 'auto_delivery',
      signalId,
      deliveryId: `${signalId}:${userId}`,
    })

    const riskDecisionId = executionRiskDecisionId(execResult)
    await queryRun(
      `UPDATE auto_signal_deliveries SET order_intent_id = ?, risk_decision_id = ?, approved_order_json = ?
       WHERE signal_id = ? AND user_id = ?`,
      [execResult.order_intent_id || null, riskDecisionId,
        execResult.risk?.approved_order ? JSON.stringify(execResult.risk.approved_order) : null, signalId, userId]
    )
    const deliveryRow = await queryOne('SELECT id FROM auto_signal_deliveries WHERE signal_id = ? AND user_id = ? LIMIT 1', [signalId, userId])
    await attachOutcomeDelivery(execResult.order_intent_id, deliveryRow?.id)

    if (execResult.status === 'success') {
      const ticket = execResult.order || execResult.ticket || null
      const isPending = order.entry_method && order.entry_method !== 'market' && order.entry_method !== 'observe'
      const executionResult = JSON.stringify({ ...execResult, tp_tier_requested: order.tp_tier_requested, tp_tier_used: order.tp_tier_used, normalization_info: order.normalization_info })
      if (isPending) {
        await queryRun(
          `UPDATE auto_signal_deliveries SET execution_status = 'success',
           pending_ticket = ?, pending_state = 'pending', pending_valid_until = ?,
           execution_result = ? WHERE signal_id = ? AND user_id = ?`,
          [String(ticket), signal.pending_valid_until || null, executionResult, signalId, userId])
        // Fix 6: shared signals — do NOT write user ticket to ai_signals root
        l(`auto-executed pending: ticket=${ticket}, volume=${order.volume}`)
      } else {
        await queryRun(
          `UPDATE auto_signal_deliveries SET execution_status = 'success', is_executed = 1, executed_at = NOW(),
           trade_ticket = ?, execution_result = ? WHERE signal_id = ? AND user_id = ?`,
          [ticket, executionResult, signalId, userId])
        l(`auto-executed: ticket=${ticket}, volume=${order.volume}`)
      }
      await insertAudit(null, userId, 'ai_auto_execute', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, ticket, volume: order.volume, is_pending: isPending, tp_tier_requested: order.tp_tier_requested, tp_tier_used: order.tp_tier_used, normalization_info: order.normalization_info },
        { status: 'success', ticket, volume: order.volume, tp_tier_used: order.tp_tier_used }, 'success')
      sendToBrowsers(userId, {
        type: 'signal_execution_updated', signal_id: signalId, status: 'success',
        pending_ticket: isPending ? String(ticket) : null, trade_ticket: isPending ? null : ticket,
      })
    } else {
      const status = execResult.status === 'rejected' ? 'rejected' : execResult.status === 'uncertain' ? 'uncertain' : 'failed'
      await queryRun(
        `UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE signal_id = ? AND user_id = ?`,
        [status, JSON.stringify(execResult), signalId, userId])
      l(`auto-execute ${status}: ${execResult.message || execResult.status}`)
      await insertAudit(null, userId, status === 'rejected' ? 'ai_auto_execute_rejected' : 'ai_auto_execute', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, error: execResult.message },
        execResult, status === 'rejected' ? 'warning' : 'error')
      sendToBrowsers(userId, { type: 'signal_execution_updated', signal_id: signalId, status })
    }
  } catch (err) {
    l(`exception: ${err.message}`)
    await queryRun(
      `UPDATE auto_signal_deliveries SET execution_status = 'failed', execution_result = ? WHERE signal_id = ? AND user_id = ?`,
      [JSON.stringify({ error: err.message }), signalId, userId]).catch(() => {})
    await insertAudit(null, userId, 'ai_auto_execute', symbol,
      { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, error: err.message },
      { status: 'error', message: err.message }, 'error')
    sendToBrowsers(userId, { type: 'signal_execution_updated', signal_id: signalId, status: 'failed' })
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
  startOutcomeMonitor()
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
  // Fix 7+8: handle stale executing deliveries (stuck > 5 min → uncertain, conditional UPDATE)
  try {
    const staleRows = await queryAll(
      "SELECT id, user_id, signal_id, execution_claimed_at FROM auto_signal_deliveries WHERE execution_status = 'executing' AND execution_claimed_at IS NOT NULL AND execution_claimed_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)"
    )
    for (const row of staleRows) {
      const updateResult = await queryRun(
        `UPDATE auto_signal_deliveries SET execution_status = 'uncertain', execution_result = ?
         WHERE id = ? AND execution_status = 'executing' AND execution_claimed_at = ?`,
        [JSON.stringify({ reason: 'stale_executing_timeout', claimed_at: row.execution_claimed_at }), row.id, row.execution_claimed_at])
      if (updateResult && updateResult.changes === 1) {
        await insertAudit(null, row.user_id, 'delivery_stale_executing', null,
          { signal_id: row.signal_id, delivery_id: row.id, claimed_at: row.execution_claimed_at },
          { status: 'uncertain', reason: 'stale_executing_timeout' }, 'warning')
        console.warn(`[PendingReconciler] Delivery ${row.id} user=${row.user_id} stuck in executing > 5min → uncertain`)
      }
      // changes=0 means status was already updated by normal flow, silently skip
    }
  } catch (e) { console.error('[PendingReconciler] stale executing check error:', e.message) }

  const deliveryRows = await queryAll(
    "SELECT id, user_id, signal_id, order_intent_id, pending_ticket, pending_valid_until, 'delivery' as src FROM auto_signal_deliveries WHERE pending_state = 'pending'"
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
      const collectRefs = rows => new Set(rows.flatMap(item => [
        item?.ticket, item?.order, item?.order_ticket, item?.position_id, item?.identifier,
      ]).filter(value => value != null && String(value).trim() !== '').map(String))
      const itemHasRef = (item, ref) => [item?.ticket, item?.order, item?.order_ticket, item?.position_id, item?.identifier]
        .some(value => value != null && String(value) === ref)
      const positionSet = collectRefs(positionList)
      let historyOrders
      let historySet
      const getHistorySet = async () => {
        if (historySet !== undefined) return historySet
        const historyResp = await mt5Bridge(userId, 'history', { page: 1, page_size: 200, include_deals: true }, { noFallback: true })
        const historyItems = historyResp?.status === 'success' && Array.isArray(historyResp.orders)
          ? [...historyResp.orders, ...(Array.isArray(historyResp.deals) ? historyResp.deals : [])]
          : null
        historyOrders = historyItems
          ? historyItems.filter(isFilledHistoryOrder)
          : null
        historySet = historyOrders ? collectRefs(historyOrders) : null
        return historySet
      }

      for (const row of rows) {
        const ticket = String(row.pending_ticket)
        const nowUtc = Date.now()
        let validUntilUtc = 0
        if (row.pending_valid_until) {
          const d = new Date(row.pending_valid_until.replace(' ', 'T') + 'Z')
          if (!isNaN(d.getTime())) validUntilUtc = d.getTime()
        }

        if (pendingSet.has(ticket)) {
          if (validUntilUtc <= 0 || nowUtc <= validUntilUtc) continue
          const cancelResult = await mt5Bridge(userId, 'cancel_pending', { ticket }, { noFallback: true })
          if (cancelResult?.status !== 'success') {
            await insertAudit(null, userId, 'pending_expire_cancel_failed', null,
              { signal_id: row.signal_id, ticket, src: row.src }, cancelResult || { status: 'error' }, 'warning')
            continue
          }
          if (row.src === 'delivery') {
            await queryRun("UPDATE auto_signal_deliveries SET pending_state = 'expired' WHERE id = ? AND pending_state = 'pending'", [row.id])
          } else {
            await queryRun("UPDATE ai_signals SET pending_state = 'expired' WHERE id = ? AND pending_state = 'pending'", [row.signal_id])
          }
          await insertAudit(null, userId, 'pending_expired', null,
            { signal_id: row.signal_id, ticket, src: row.src }, { status: 'expired', cancel_result: cancelResult }, 'info')
          continue
        }

        const confirmedHistorySet = positionSet.has(ticket) ? null : await getHistorySet()
        if (positionSet.has(ticket) || confirmedHistorySet?.has(ticket)) {
          const matchedPosition = positionList.find(item => itemHasRef(item, ticket))
          const matchedHistory = historyOrders?.find(item => itemHasRef(item, ticket))
          const resolvedTradeTicket = String(matchedPosition?.ticket ?? matchedPosition?.position_id ?? matchedHistory?.position_id ?? matchedHistory?.ticket ?? ticket)
          if (row.src === 'delivery') {
            await queryRun(
              "UPDATE auto_signal_deliveries SET pending_state = 'filled', is_executed = 1, trade_ticket = ?, executed_at = NOW() WHERE id = ?",
              [resolvedTradeTicket, row.id])
            await recordPendingOutcomeFill({
              orderIntentId: row.order_intent_id,
              deliveryId: row.id,
              positionId: matchedPosition?.position_id ?? matchedPosition?.ticket ?? matchedHistory?.position_id,
              orderTicket: ticket,
              dealTicket: matchedHistory?.deal_ticket,
            })
            // Fix 6: do NOT sync user ticket to shared root ai_signals
          } else {
    await queryRun(
              "UPDATE ai_signals SET pending_state = 'filled', is_executed = 1, trade_ticket = ?, executed_at = NOW() WHERE id = ?",
              [resolvedTradeTicket, row.signal_id])
          }
          await insertAudit(null, userId, 'pending_filled', null,
            { signal_id: row.signal_id, ticket, src: row.src }, { status: 'filled', ticket: resolvedTradeTicket }, 'success')
          sendToBrowsers(userId, { type: 'pending_filled', ticket: resolvedTradeTicket, signal_id: row.signal_id })
          continue
        }

        // A pending ticket can disappear briefly while MT5 moves it into a
        // position/history record. Keep it pending until that transition can
        // be confirmed, or until its configured validity has elapsed.
        if (validUntilUtc > 0 && nowUtc > validUntilUtc) {
          if (!confirmedHistorySet) {
            console.warn(`[PendingReconciler] User ${userId}: history unavailable for expired ticket=${ticket}, defer classification`)
            continue
          }
          if (row.src === 'delivery') {
            await queryRun("UPDATE auto_signal_deliveries SET pending_state = 'expired' WHERE id = ?", [row.id])
          } else {
            await queryRun("UPDATE ai_signals SET pending_state = 'expired' WHERE id = ?", [row.signal_id])
          }
          await insertAudit(null, userId, 'pending_expired', null,
            { signal_id: row.signal_id, ticket, src: row.src }, { status: 'expired' }, 'info')
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
    } catch (e) { console.warn(`[SmartClose] Market state check failed for user ${userId}:`, e.message); closeSchedulerState[userId].timer = setTimeout(tick, 5000); return }
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
    let matched = false
    if (cfg.rule_soft_sl != null && profit < 0 && Math.abs(profit) >= cfg.rule_soft_sl) {
      results.push({ ticket: pos.ticket, symbol: pos.symbol, rule: 'soft_sl', reason: `亏损 $${Math.abs(profit).toFixed(2)} >= 软止损 $${cfg.rule_soft_sl}` })
      matched = true
    }
    if (!matched && cfg.rule_soft_tp != null && profit > 0 && profit >= cfg.rule_soft_tp) {
      results.push({ ticket: pos.ticket, symbol: pos.symbol, rule: 'soft_tp', reason: `盈利 $${profit.toFixed(2)} >= 软止盈 $${cfg.rule_soft_tp}` })
      matched = true
    }
    if (!matched && cfg.rule_timeout_minutes != null && pos.time) {
      const durationMin = (Date.now() / 1000 - pos.time) / 60
      if (durationMin >= cfg.rule_timeout_minutes && profit <= 0) {
        results.push({ ticket: pos.ticket, symbol: pos.symbol, rule: 'timeout', reason: `持仓 ${Math.floor(durationMin)} 分钟且浮亏，超时平仓` })
        matched = true
      }
    }
    if (!matched && cfg.rule_max_loss_pct != null && account?.balance && profit < 0) {
      const lossPct = (Math.abs(profit) / account.balance) * 100
      if (lossPct >= cfg.rule_max_loss_pct) {
        results.push({ ticket: pos.ticket, symbol: pos.symbol, rule: 'max_loss_pct', reason: `亏损 ${lossPct.toFixed(1)}% >= 最大亏损 ${cfg.rule_max_loss_pct}%` })
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
  const resolvedModel = await resolveAiTaskModel({ userId, strategyId: null, usage: 'manual' })
  if (!resolvedModel.model?.api_key_encrypted) return []
  const model = resolvedModel.model.model_name || 'deepseek-chat'

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

  const apiKey = resolvedModel.model.api_key_encrypted
  const baseUrl = String(resolvedModel.model.api_base_url || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
  const temperature = resolvedModel.model.temperature ?? closeConfig.temperature ?? 0.3
  let maxTokens = resolvedModel.model.max_tokens || closeConfig.max_tokens || 4000
  if (/reason|think|flash/i.test(model) && maxTokens < 8000) {
    maxTokens = Math.min(maxTokens * 2, 8000)
  }

  // Read global thinking config
  const globalCfg = await getGlobalAutoConfig()
  const thinkingEnabled = globalCfg?.thinking_enabled !== 0
  const reasoningEffort = globalCfg?.reasoning_effort || 'max'

  try {
    const provider = resolvedModel.model.provider || resolvedModel.model.api_provider || 'deepseek'
    const protocol = provider === 'volcengine_agent_plan' ? 'responses' : 'chat_completions'
    const parsed = await requestJsonObject({
      url: `${baseUrl}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`,
      apiKey, provider, model, temperature, maxTokens,
      thinkingEnabled: provider === 'kimi_code' ? true : thinkingEnabled,
      reasoningEffort: provider === 'kimi_code' && model === 'k3' ? 'max' : reasoningEffort,
      protocol,
      messages: [
        { role: 'system', content: stripTimeframeTags(prompt) },
        { role: 'user', content: JSON.stringify(contextPayload) },
      ],
      usageContext: { userId, profileId: resolvedModel.model_profile_id,
        credentialSource: resolvedModel.credential_source, usage: 'manual', strategyId: null },
    })

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

function executionRiskDecisionId(result) {
  return result?.risk?.risk_decision_id
    || result?.risk_decision_id
    || result?.details?.risk_decision_id
    || null
}


// Test-only exports (not for production use)
export const __schedulerTest = {
  normalizeCancelCondition,
  isUserEligibleForAutoExecution,
  calculateRecoverySeconds,
  matchPendingCancelCondition,
  countPendingForSymbol,
  countPendingForSymbolDirection,
  isFilledHistoryOrder,
  validateInferenceBridgeSnapshot,
  createLockGuard,
  discardSharedSignalForWeeklyWindow,
  executionRiskDecisionId,
  retryDelayMs,
  shouldLogSchedulerWait,
  schedulerWaitLabel,
}
