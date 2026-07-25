import { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'
import { queryOne, queryAll, queryRun, withTransaction, beijingNow, parseBeijing } from './db.js'
import { ADMIN_CACHE_TTL_MS, CORS_ORIGINS } from './config.js'
import { isCorsOriginAllowed } from './cors-origin.js'
import { getRedis, isRedisAvailable } from './redis.js'
import { stripBrokerSuffix, utcToMt5Time } from './routes/ai/utils.js'
import { DEFAULT_MAX_POSITION_SIZE } from './routes/ai/defaults.js'
import { getRegisteredAutoSchedulerState } from './routes/ai/runtime-state-registry.js'
import { setWeeklyMarketTimezoneOffset, weeklyRiskLockResult } from './jobs/weekly-risk-window.js'
import { localizeAuditRow } from './audit-localization.js'
import { buildAiAccessContext, observerAccessError, observerWsActionAllowed } from './routes/ai/observer-access.js'
import { getDefaultObserverSource, resolveObserverSourceForUser } from './routes/ai/observer-channels.js'
import { tokenVersionMatches } from './middleware/auth.js'
import { consumeBridgeConnectionTicket } from './bridge-auth-session.js'

import { JWT_SECRET } from './config.js'

// Per-user state
const bridges = new Map()       // userId -> { ws, lastSeen }
const browsers = new Map()      // userId -> Set<ws>
const adminBrowsers = new Set() // authenticated admin console sockets
const pendingCommands = new Map() // commandId -> { resolve, timer, userId }
const performanceSyncJobs = new Set()
let adminUserId = null          // cached admin userId for fallback
let adminUserIdLastCheck = 0
const ADMIN_CACHE_TTL = ADMIN_CACHE_TTL_MS
const _bridgeInitGen = new Map() // userId -> generation number (防并发 init 污染状态)

let cmdCounter = 0
let wss = null
let adminEventSeq = 0
const adminEventThrottle = new Map()

const PERFORMANCE_SYNC_INTERVAL_MS = 15 * 60 * 1000
const PERFORMANCE_SYNC_CHUNKS_PER_RUN = 3
export const BRIDGE_WS_LIMITS = Object.freeze({
  maxPayloadBytes: 32 * 1024 * 1024,
  maxBrowserMessageBytes: 256 * 1024,
  maxInitQueueMessages: 32,
  maxInitQueueBytes: 4 * 1024 * 1024,
})

export function wsMessageByteLength(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8')
  if (Buffer.isBuffer(data)) return data.byteLength
  if (ArrayBuffer.isView(data)) return data.byteLength
  if (data instanceof ArrayBuffer) return data.byteLength
  return Buffer.byteLength(String(data ?? ''), 'utf8')
}

export function isAllowedBrowserWsOrigin(req, type) {
  if (type !== 'browser' && type !== 'admin') return true
  const origin = String(req?.headers?.origin || '').trim()
  if (!origin) return false
  return isCorsOriginAllowed(origin, CORS_ORIGINS)
}

export function createBridgeInitMessageQueue(ws) {
  let messages = []
  let queuedBytes = 0
  let overflowed = false
  let attached = true
  const detach = () => {
    if (!attached) return
    attached = false
    ws.off('message', enqueue)
  }
  const enqueue = data => {
    if (overflowed) return
    const messageBytes = wsMessageByteLength(data)
    if (messages.length >= BRIDGE_WS_LIMITS.maxInitQueueMessages
      || queuedBytes + messageBytes > BRIDGE_WS_LIMITS.maxInitQueueBytes) {
      overflowed = true
      messages = []
      queuedBytes = 0
      detach()
      try { ws.close(1009, 'Bridge initialization payload limit exceeded') } catch {}
      return
    }
    messages.push(data)
    queuedBytes += messageBytes
  }
  ws.on('message', enqueue)
  return {
    get overflowed() { return overflowed },
    detach,
    drain() {
      detach()
      const queued = messages
      messages = []
      queuedBytes = 0
      return queued
    },
  }
}

function scheduleAccountPerformanceSync(userId, accountId, { recent = false, delayMs = 0 } = {}) {
  const bridge = bridges.get(Number(userId))
  if (!bridge || bridge.ws?.readyState !== 1 || Number(bridge.tradingAccountId || 0) !== Number(accountId)) return
  if (bridge._performanceSyncTimer) clearTimeout(bridge._performanceSyncTimer)
  bridge._performanceSyncTimer = setTimeout(() => {
    bridge._performanceSyncTimer = null
    runAccountPerformanceSync(Number(userId), Number(accountId), { recent }).catch(error => {
      console.warn(`[AccountPerformance] Background sync failed user=${userId} account=${accountId}:`, error.message)
    })
  }, Math.max(0, Number(delayMs) || 0))
}

async function runAccountPerformanceSync(userId, accountId, { recent = false } = {}) {
  const jobKey = `${userId}:${accountId}`
  if (performanceSyncJobs.has(jobKey)) return { status:'busy' }
  performanceSyncJobs.add(jobKey)
  let processed = 0
  let caughtUp = false
  let failed = false
  try {
    const ai = await import('./routes/ai/index.js')
    const maxChunks = recent ? 1 : PERFORMANCE_SYNC_CHUNKS_PER_RUN
    for (let index = 0; index < maxChunks; index++) {
      const bridge = bridges.get(userId)
      if (!bridge || bridge.ws?.readyState !== 1 || Number(bridge.tradingAccountId || 0) !== accountId) break
      const window = await ai.getAccountPerformanceSyncWindow(userId, accountId, { recent })
      if (!window) { caughtUp = true; break }
      try {
        const result = await sendBridgeCommand(userId, 'performance_daily', {
          date_from:window.date_from, date_to:window.date_to,
        }, 30_000, { noFallback:true })
        if (!result || result.status !== 'success') throw new Error(result?.message || result?.error || 'performance_sync_failed')
        await ai.saveAccountPerformanceChunk(userId, accountId, result, { advanceCursor:!recent })
        processed++
      } catch (error) {
        failed = true
        await ai.recordAccountPerformanceSyncFailure(userId, accountId, error).catch(() => {})
        throw error
      }
      if (recent) { caughtUp = true; break }
    }
    return { status:'success', processed, caught_up:caughtUp }
  } catch (error) {
    if (!failed) {
      const ai = await import('./routes/ai/index.js')
      await ai.recordAccountPerformanceSyncFailure(userId, accountId, error).catch(() => {})
    }
    failed = true
    throw error
  } finally {
    performanceSyncJobs.delete(jobKey)
    const bridge = bridges.get(userId)
    if (bridge?.ws?.readyState === 1 && Number(bridge.tradingAccountId || 0) === accountId) {
      scheduleAccountPerformanceSync(userId, accountId, failed
        ? { recent:false, delayMs:5 * 60 * 1000 }
        : caughtUp
          ? { recent:true, delayMs:PERFORMANCE_SYNC_INTERVAL_MS }
          : { recent:false, delayMs:2_000 })
    }
  }
}

export function queueAccountPerformanceSync(userId, accountId, options = {}) {
  scheduleAccountPerformanceSync(Number(userId), Number(accountId), options)
}

const TRADE_REF_KEYS = new Set([
  'ticket', 'order', 'order_id', 'order_ticket', 'position', 'position_id',
  'position_ticket', 'deal', 'deal_id', 'deal_ticket', 'trade_ticket', 'pending_ticket'
])

function addTradeRef(refs, value) {
  if (value === null || value === undefined || value === '') return
  const normalized = String(value).trim()
  if (normalized && normalized !== '0') refs.add(normalized)
}

function collectTradeRefsFromValue(value, refs, depth = 0) {
  if (!value || depth > 4) return
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return
    try { collectTradeRefsFromValue(JSON.parse(trimmed), refs, depth + 1) } catch {}
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTradeRefsFromValue(item, refs, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (TRADE_REF_KEYS.has(key.toLowerCase())) addTradeRef(refs, item)
    if (item && typeof item === 'object') collectTradeRefsFromValue(item, refs, depth + 1)
  }
}

export function collectTradeRefs(record) {
  const refs = new Set()
  collectTradeRefsFromValue(record, refs)
  if (record?.execution_result) collectTradeRefsFromValue(record.execution_result, refs)
  return [...refs]
}

export function buildSignalRefIndex(rows, toSignal = row => row) {
  const index = new Map()
  for (const row of rows || []) {
    const signal = toSignal(row)
    for (const ref of collectTradeRefs(row)) {
      if (!index.has(ref)) index.set(ref, [])
      const bucket = index.get(ref)
      if (!bucket.some(item => String(item.id) === String(signal.id))) bucket.push(signal)
    }
  }
  return index
}

const SIGNAL_PENDING_ACTIONS = new Set([
  'ai_cancel_pending',
  'ai_cancel_pending_failed',
  'pending_superseded',
  'pending_supersede_failed',
])

const SIGNAL_PENDING_ACTION_ALIASES = new Map([
  ['AI 取消挂单', 'ai_cancel_pending'],
  ['AI 取消挂单失败', 'ai_cancel_pending_failed'],
  ['旧挂单已替换', 'pending_superseded'],
  ['旧挂单替换失败', 'pending_supersede_failed'],
])

function parseAuditPayload(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return {} }
}

export function buildSignalPendingActions(rows = [], executionResult = null) {
  const actions = rows
    .map(row => ({ ...row, action:SIGNAL_PENDING_ACTION_ALIASES.get(String(row?.action || '')) || String(row?.action || '') }))
    .filter(row => SIGNAL_PENDING_ACTIONS.has(row.action))
    .map(row => {
      const request = parseAuditPayload(row.request_json ?? row.request)
      const result = parseAuditPayload(row.result_json ?? row.result)
      const failed = String(row.action).endsWith('_failed') || ['error', 'failed'].includes(String(row.status || result.status || '').toLowerCase())
      const superseded = row.action === 'pending_superseded'
      return {
        ticket: String(request.ticket ?? result.ticket ?? '').trim() || null,
        pending_type: String(request.pending_type || '').trim() || null,
        status: failed ? 'failed' : superseded ? 'superseded' : 'cancelled',
        reason: String(request.reason || '').trim() || null,
        message: failed ? String(request.error || result.message || result.error || '').trim() || null : null,
        created_at: row.created_at || null,
      }
    })
  const execution = parseAuditPayload(executionResult)
  const reason = String(execution.reason || '')
  if (reason === 'pending_cancelled' && !actions.some(action => action.status === 'cancelled')) {
    actions.push({
      ticket:null,
      pending_type:null,
      status:'cancelled',
      count:Number(execution.details?.count || 0),
      reason:String(execution.details?.pending_action_reason || '').trim() || '策略判断原挂单逻辑已经失效，系统已取消当前策略对应的挂单',
      message:null,
      created_at:null,
    })
  } else if (reason === 'pending_cancel_failed' && !actions.some(action => action.status === 'failed')) {
    actions.push({
      ticket:String(execution.details?.ticket || '').trim() || null,
      pending_type:null,
      status:'failed',
      count:0,
      reason:null,
      message:'取消当前策略挂单失败，本次未继续执行',
      created_at:null,
    })
  }
  return actions.slice(0, 20)
}

async function loadSignalPendingActions(userId, signalId, executionResult = null) {
  try {
    const rows = await queryAll(
      `SELECT action, request_json, result_json, status, created_at
       FROM trade_audit_logs
       WHERE user_id = ?
         AND JSON_VALID(request_json)
         AND CAST(JSON_UNQUOTE(JSON_EXTRACT(request_json, '$.signal_id')) AS UNSIGNED) = ?
       ORDER BY id ASC
       LIMIT 20`,
      [userId, signalId]
    )
    return buildSignalPendingActions(rows, executionResult)
  } catch (error) {
    console.warn(`[SignalDetail] Failed to load pending actions for signal ${signalId}:`, error.message)
    return []
  }
}

export function normalizeBridgeMarketState(payload, receivedAt = Date.now()) {
  if (Number(payload?.market_state_version) !== 1) return null
  const state = String(payload?.market_state || '').toLowerCase()
  if (!['open', 'closed', 'restricted', 'stale', 'unknown'].includes(state)) return null
  const optionalNumber = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
  const symbolTradeMode = optionalNumber(payload?.symbol_trade_mode)
  const tradeMode = state === 'open' ? 4
    : state === 'closed' ? 0
      : state === 'restricted' && [1, 2, 3].includes(symbolTradeMode) ? symbolTradeMode : -1
  const reasons = {
    open: 'market_open', closed: 'market_closed', restricted: 'market_restricted',
    stale: 'market_stale_tick', unknown: 'market_unknown',
  }
  return {
    state, reason: reasons[state], detailReason: String(payload.market_reason || ''), tradeMode,
    symbolTradeMode: symbolTradeMode ?? -1,
    symbol: String(payload.symbol || ''), terminalConnected: payload.terminal_connected !== false,
    tickProgressing: Boolean(payload.tick_progressing),
    tickUnchangedSeconds: optionalNumber(payload.tick_unchanged_seconds),
    tickAgeSeconds: optionalNumber(payload.tick_age_seconds),
    checkedAtUtcMsc: optionalNumber(payload.market_checked_at_utc_msc),
    receivedAt,
  }
}

function applyBridgeMarketState(bridge, payload, userId, receivedAt = Date.now()) {
  const normalized = normalizeBridgeMarketState(payload, receivedAt)
  if (!bridge || !normalized) return null
  const previous = bridge.marketState?.state
  bridge.marketState = normalized
  if (!bridge.marketStates) bridge.marketStates = new Map()
  if (normalized.symbol) bridge.marketStates.set(stripBrokerSuffix(normalized.symbol), normalized)
  bridge.lastTradeMode = normalized.tradeMode
  if (previous && previous !== normalized.state) {
    console.log(`[BridgeWS] User ${userId}: market ${previous} -> ${normalized.state} (${normalized.detailReason || normalized.reason})`)
    broadcastAdminEvent('market', 'state_changed', {
      user_id: Number(userId),
      market_state: normalized.state,
      trade_mode: normalized.tradeMode,
      symbol: normalized.symbol || null,
      reason: normalized.detailReason || normalized.reason,
    }, { scopes:['overview', 'ai-operations', 'risk-audit'] })
  }
  return normalized
}

export function recordBridgeMarketState(userId, payload, receivedAt = Date.now()) {
  const bridge = bridges.get(Number(userId))
  if (!bridge || bridge.ws?.readyState !== 1) return null
  return applyBridgeMarketState(bridge, payload, Number(userId), receivedAt)
}

const _broadcastThrottle = new Map() // userId -> lastBroadcastTime (定期清理防内存泄漏)

// 每 10 分钟清理超过 30 秒未使用的广播节流条目
setInterval(() => {
  const cutoff = Date.now() - 30000
  for (const [uid, last] of _broadcastThrottle) {
    if (last < cutoff) _broadcastThrottle.delete(uid)
  }
  for (const [key, last] of adminEventThrottle) {
    if (last < cutoff) adminEventThrottle.delete(key)
  }
}, 10 * 60 * 1000)

async function getAdminUserId() {
  const now = Date.now()
  if ((now - adminUserIdLastCheck) < ADMIN_CACHE_TTL) return adminUserId
  const row = await queryOne('SELECT id FROM users WHERE role = ? ORDER BY id LIMIT 1', ['admin'])
  adminUserId = row?.id || null
  adminUserIdLastCheck = now
  return adminUserId
}

export async function getActivePlatformBridgeUserId() {
  const channelSource = await getDefaultObserverSource().catch(error => {
    // Compatibility for deployments where migration 118 has not run yet.
    if (!String(error?.message || '').includes("doesn't exist")) {
      console.error('[BridgeWS] default observer channel lookup failed:', error.message)
    }
    return null
  })
  if (channelSource?.bridge_user_id) {
    const channelUserId = Number(channelSource.bridge_user_id)
    // A configured channel is authoritative. Never silently show another
    // account when its source is offline.
    return bridges.get(channelUserId)?.ws?.readyState === 1 ? channelUserId : null
  }
  const configured = await queryOne(`SELECT value FROM system_config
    WHERE category = 'market_data' AND \`key\` = 'platform_market_bridge_user_id' LIMIT 1`).catch(() => null)
  const configuredId = Number(configured?.value)
  if (configuredId > 0 && bridges.get(configuredId)?.ws?.readyState === 1) {
    const configuredUser = await queryOne('SELECT role FROM users WHERE id = ?', [configuredId]).catch(() => null)
    if (configuredUser?.role === 'admin') return configuredId
  }
  const cachedAdminId = await getAdminUserId()
  if (cachedAdminId && bridges.get(cachedAdminId)?.ws?.readyState === 1) return cachedAdminId
  const connectedIds = [...bridges.entries()].filter(([, bridge]) => bridge.ws?.readyState === 1).map(([id]) => Number(id))
  if (!connectedIds.length) return null
  const rows = await queryAll(`SELECT id FROM users WHERE role = 'admin' AND id IN (${connectedIds.map(() => '?').join(',')}) ORDER BY id`, connectedIds)
  return rows[0]?.id || null
}

async function resolveObserverBridgeContext(userId, user, requestedChannelId = null, { strict = true } = {}) {
  let channel
  try {
    channel = await resolveObserverSourceForUser(userId, user?.plan, requestedChannelId)
  } catch (error) {
    if (strict) throw error
    return { bridgeUserId:null, channel:null, error:String(error?.message || 'observer_channel_access_denied') }
  }
  if (channel) {
    const bridgeUserId = Number(channel.bridge_user_id)
    return {
      bridgeUserId:bridges.get(bridgeUserId)?.ws?.readyState === 1 ? bridgeUserId : null,
      channel:{ id:Number(channel.id), name:channel.name, slug:channel.slug,
        source_id:Number(channel.source_id), source_name:channel.source_name },
    }
  }
  return { bridgeUserId:null, channel:null }
}

export function getPlatformMarketClockState(userId) {
  const bridge = bridges.get(Number(userId))
  const hb = bridge?._clientHeartbeat || {}
  return {
    bridge_user_id: Number(userId) || null,
    connected: bridge?.ws?.readyState === 1,
    timezone_offset_minutes: bridge?.timezoneOffsetMinutes ?? hb.timezone_offset_minutes ?? null,
    clock_status: bridge?.clockStatus || hb.clock_status || 'unknown',
    clock_residual_ms: bridge?.clockResidualMs ?? hb.clock_residual_ms ?? null,
    last_seen_at_utc_msc: bridge?.lastSeen || null,
    broker_server: bridge?.brokerServer || null,
    account_login: bridge?.accountLogin || null,
  }
}

async function getLabTimezoneOffsetMinutes() {
  const platformUserId = await getActivePlatformBridgeUserId()
  const offset = platformUserId ? Number(getPlatformMarketClockState(platformUserId).timezone_offset_minutes) : NaN
  return Number.isFinite(offset) && offset >= -720 && offset <= 840 ? Math.trunc(offset) : 180
}


export function initBridgeWS(server) {
  // Cache admin userId at startup
  getAdminUserId().catch(() => {})
  wss = new WebSocketServer({ noServer: true, maxPayload: BRIDGE_WS_LIMITS.maxPayloadBytes })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    const type = url.searchParams.get('type')
    const tokenPresent = Boolean(url.searchParams.get('token') || readCookie(req, 'ws_token'))
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress

    if (req.url.startsWith('/aurum-api/bridge/ws')) {
      if (!isAllowedBrowserWsOrigin(req, type)) {
        console.warn(`[BridgeWS] rejected ${type || 'unknown'} websocket origin`)
        try { socket.write?.('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') } catch {}
        socket.destroy()
        return
      }
      if (process.env.DEBUG_BRIDGE_WS === '1') {
        console.log(`[BridgeWS] upgrade path=/aurum-api/bridge/ws type=${type} tokenPresent=${tokenPresent} ip=${ip}`)
      }
      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req)
        })
      } catch (e) {
        console.error(`[BridgeWS] upgrade failed path=/aurum-api/bridge/ws type=${type} ip=${ip} error=${e.message}`)
        try { socket.destroy() } catch {}
      }
    } else {
      socket.destroy()
    }
  })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost')
    const type = url.searchParams.get('type')

    if (type === 'admin') return handleAdmin(ws, url, req)
    if (type === 'browser') return handleBrowser(ws, url, req)
    if (type === 'bridge') {
      handleBridge(ws, url).catch(error => {
        console.error('[BridgeWS] bridge initialization failed:', error.message)
        try { ws.close(4002, 'Bridge authentication failed') } catch {}
      })
      return
    }
    ws.close(4000, 'Unknown type')
  })


  return wss
}

function readCookie(req, name) {
  const raw = String(req?.headers?.cookie || '')
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    try { return decodeURIComponent(part.slice(index + 1).trim()) } catch { return '' }
  }
  return ''
}

export function browserSessionToken(req, url) {
  const cookieToken = readCookie(req, 'ws_token')
  if (cookieToken) return cookieToken
  return process.env.ALLOW_LEGACY_WS_QUERY_TOKEN === '1' ? url.searchParams.get('token') : null
}

// ============ Admin Console Connection ============

async function handleAdmin(ws, url, req) {
  const token = browserSessionToken(req, url)
  if (!token) {
    console.warn('[BridgeWS] Admin websocket auth failed: ws_token cookie missing')
    ws.close(4002, 'Session cookie required')
    return
  }
  let decoded = null
  try { decoded = jwt.verify(token, JWT_SECRET) } catch (e) { console.error('[BridgeWS] Admin JWT verify failed:', e.message) }
  const userId = decoded?.userId
  if (!userId) { ws.close(4002, 'Invalid token'); return }

  const user = await queryOne('SELECT id, role, token_version FROM users WHERE id = ?', [userId]).catch(() => null)
  if (!tokenVersionMatches(decoded, user) || String(user?.role || '').toLowerCase() !== 'admin') {
    ws.close(4003, 'Admin access required')
    return
  }

  ws._userId = Number(userId)
  adminBrowsers.add(ws)
  const send = payload => {
    if (ws.readyState !== 1) return false
    try { ws.send(JSON.stringify(payload)); return true } catch { return false }
  }
  const bridgesSnapshot = getBridgeDiagnostics()
  send({
    type:'admin_ready',
    protocol:1,
    user_id:Number(userId),
    server_time:new Date().toISOString(),
    bridge_count:bridgesSnapshot.length,
    bridges:bridgesSnapshot,
  })

  ws.on('message', data => {
    if (wsMessageByteLength(data) > BRIDGE_WS_LIMITS.maxBrowserMessageBytes) {
      ws.close(1009, 'Message too large')
      return
    }
    let msg
    try { msg = JSON.parse(data) } catch { return }
    if (msg.type === 'hb') {
      send({ type:'admin_pong', seq:msg.seq ?? null, server_time:new Date().toISOString() })
    } else if (msg.type === 'ping') {
      send({ type:'pong', ts:msg.ts ?? Date.now() })
    } else if (msg.type === 'subscribe') {
      send({
        type:'admin_subscribed',
        scopes:Array.isArray(msg.scopes) ? msg.scopes.filter(scope => typeof scope === 'string').slice(0, 20) : [],
      })
    }
  })

  const remove = () => adminBrowsers.delete(ws)
  ws.on('close', remove)
  ws.on('error', remove)
}

// ============ Browser Connection ============

async function handleBrowser(ws, url, req) {
  const token = browserSessionToken(req, url)
  if (!token) {
    console.warn('[BridgeWS] Browser websocket auth failed: ws_token cookie missing')
    ws.close(4002, 'Session cookie required')
    return
  }
  let decoded = null
  try { decoded = jwt.verify(token, JWT_SECRET) } catch (e) { console.error('[BridgeWS] Browser JWT verify failed:', e.message) }
  const userId = decoded?.userId
  if (!userId) { ws.close(4002, 'Invalid token'); return }
  const sessionUser = await queryOne(`SELECT id, token_version FROM users
    WHERE id = ? AND deletion_status = 'active' AND deleted_at IS NULL`, [userId]).catch(() => null)
  if (!sessionUser || !tokenVersionMatches(decoded, sessionUser)) {
    ws.close(4002, 'Session revoked')
    return
  }

  // Register
  ws._userId = Number(userId)
  if (!browsers.has(userId)) browsers.set(userId, new Set())
  browsers.get(userId).add(ws)

  // Handle messages from browser
  ws.on('message', async (data) => {
    if (wsMessageByteLength(data) > BRIDGE_WS_LIMITS.maxBrowserMessageBytes) {
      ws.close(1009, 'Message too large')
      return
    }
    let msg
    try { msg = JSON.parse(data) } catch { return }

    if (msg.type === 'hb') {
      // Heartbeat uses the same access decision as command handling. Plus is
      // always an observer, even if an old bridge connection still exists.
      const accessUser = await queryOne('SELECT role, plan, plan_expires_at FROM users WHERE id = ?', [userId]).catch(() => null)
      const access = buildAiAccessContext(accessUser, { ownBridgeConnected:isBridgeAlive(userId) })
      const observerContext = access.mode === 'observer'
        ? await resolveObserverBridgeContext(userId, accessUser, msg.observer_channel_id, { strict:false })
        : null
      const dataUserId = access.mode === 'observer' ? observerContext.bridgeUserId : access.mode === 'full' ? userId : null
      ws._observerBridgeUserId = access.mode === 'observer' ? Number(dataUserId) || null : null
      ws._observerStrategyId = access.mode === 'observer'
        ? Number(observerContext?.channel?.strategy_id || 0) || null : null
      const bridge = dataUserId ? bridges.get(dataUserId) : null
      const usingFallback = access.mode === 'observer'
      const connected = !!(bridge && bridge.ws.readyState === 1)
      const alive = connected && (Date.now() - bridge.lastSeen < 20000)
      // In observer mode the visible switches describe the platform observer
      // account. Mutations remain blocked by the observer action allowlist.
      const tradeEnabled = alive ? !!bridge.tradeEnabled : undefined
      const autoReasoningEnabled = alive ? !!bridge.autoReasoningEnabled : undefined
      ws.send(JSON.stringify({
        type: 'hb',
        seq: msg.seq,
        mt5_connected: connected,
        mt5_alive: alive,
        using_fallback: usingFallback,
        trade_enabled: tradeEnabled,
        auto_reasoning_enabled: autoReasoningEnabled,
        observer_channel: observerContext?.channel || null,
        access,
      }))
    } else if (msg.type === 'command' && msg.action) {
      handleBrowserCommand(ws, userId, msg)
    }
  })

  ws.on('close', () => {
    const set = browsers.get(userId)
    if (set) { set.delete(ws); if (set.size === 0) browsers.delete(userId) }
  })
  ws.on('error', () => {
    const set = browsers.get(userId)
    if (set) { set.delete(ws); if (set.size === 0) browsers.delete(userId) }
  })
}

// ============ Bridge Connection ============

async function handleBridge(ws, url) {
  const initQueue = createBridgeInitMessageQueue(ws)
  // Buffer early messages through authentication and runtime setup, with strict bounds.

  let userId = null
  let credentialTokenVersion = null
  const ticket = url.searchParams.get('ticket')
  if (ticket) {
    try {
      const payload = await consumeBridgeConnectionTicket(ticket)
      userId = payload.userId
      credentialTokenVersion = Number(payload.tokenVersion || 0)
    } catch (error) {
      initQueue.detach()
      console.warn(`[BridgeWS] bridge ticket rejected: ${error.code || 'invalid'}`)
      ws.close(4002, 'Invalid or expired bridge ticket')
      return
    }
  } else if (process.env.ALLOW_LEGACY_BRIDGE_QUERY_TOKEN === '1') {
    const token = url.searchParams.get('token')
    let decoded = null
    try { decoded = jwt.verify(token, JWT_SECRET) } catch (error) {
      console.error('[BridgeWS] legacy bridge auth failed:', error.message)
    }
    userId = decoded?.userId
    credentialTokenVersion = Number(decoded?.tokenVersion || 0)
    if (userId) console.warn(`[BridgeWS] legacy query-token authentication used user=${userId}`)
  }
  if (!userId) {
    initQueue.detach()
    console.log('[BridgeWS] bridge auth failed: no valid credential')
    ws.close(4002, 'Bridge ticket required')
    return
  }

  // Check user plan — only Pro allowed (async, blocks bridge setup)
  try {
    const user = await queryOne(`SELECT plan, plan_expires_at, role, token_version,
    (role = 'admin' OR (plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW()))) AS has_pro_access
    FROM users WHERE id = ? AND deletion_status = 'active' AND deleted_at IS NULL`, [userId])
    if (initQueue.overflowed || ws.readyState !== 1) { initQueue.detach(); return }
    if (!user) { initQueue.detach(); ws.close(4002, 'User not found'); return }
    if (Number(user.token_version || 0) !== credentialTokenVersion) { initQueue.detach(); ws.close(4002, 'Session revoked'); return }
    if (!user.has_pro_access) {
      const now = new Date()
      const expired = user.plan_expires_at && new Date(user.plan_expires_at) < now
      const reason = expired ? '会员已过期，请续费后重试' : `当前会员等级(${user.plan})不可使用桥接，请升级Pro会员`
      console.log(`[BridgeWS] User ${userId} rejected: ${reason}`)
      initQueue.detach()
      ws.close(4003, reason)
      return
    }
    await _initBridge(ws, userId, user, initQueue)
    // 重放缓存消息
  } catch (err) {
    initQueue.detach()
    console.error('[BridgeWS] Plan check error:', err)
    ws.close(4002, 'Server error')
  }
}

async function _initBridge(ws, userId, user, initQueue = null) {
  // Generation counter — prevents stale async init from corrupting a newer bridge's state
  const gen = (_bridgeInitGen.get(userId) || 0) + 1
  _bridgeInitGen.set(userId, gen)
  const abortStaleInit = () => {
    initQueue?.detach()
    try { if (ws.readyState === 1) ws.close(4001, 'Replaced by newer connection') } catch {}
  }

  // Close old bridge connection if still open (one bridge per account)
  const existing = bridges.get(userId)
  if (existing) {
    if (existing._pingInterval) clearInterval(existing._pingInterval)
    if (existing._performanceSyncTimer) clearTimeout(existing._performanceSyncTimer)
    if (existing.ws && existing.ws.readyState === 1) {
      try { existing.ws.close(4001, 'Replaced by new connection') } catch {}
    }
    for (const [commandId, pending] of pendingCommands) {
      if (pending.userId === Number(userId) && pending.ws === existing.ws) {
        clearTimeout(pending.timer)
        pendingCommands.delete(commandId)
        pending.resolve({ status:'error', error:'Bridge connection replaced before command result' })
      }
    }
  }

  let initComplete = false

  // Register close + error handlers BEFORE any await (so close during init is caught)
  ws.on('close', async (code, reason) => {
    const reasonStr = reason?.toString() || ''
    if (!initComplete) {
      console.log(`[BridgeWS] close during init user=${userId} code=${code} reason=${reasonStr}`)
      const current = bridges.get(userId)
      if (current && current.ws !== ws) {
        console.log(`[BridgeWS] stale init close user=${userId}, newer bridge remains active`)
        return
      }
      if (current && current.ws === ws) {
        if (current._pingInterval) clearInterval(current._pingInterval)
        if (current._performanceSyncTimer) clearTimeout(current._performanceSyncTimer)
        bridges.delete(userId)
      }
      sendToBrowsers(userId, { type: 'disconnect', reason: 'bridge_closed' })
      broadcastAdminEvent('bridge', 'disconnected', {
        user_id:Number(userId), connected:false, alive:false,
      }, { scopes:['overview', 'users', 'ai-operations', 'risk-audit'] })
      return
    }
    const bridge = bridges.get(userId)
    if (bridge) {
      if (bridge._pingInterval) clearInterval(bridge._pingInterval)
      if (bridge._performanceSyncTimer) clearTimeout(bridge._performanceSyncTimer)
    }
    if (!bridge || bridge.ws !== ws) {
      console.log(`[BridgeWS] stale close user=${userId}, new bridge already connected — skipping cleanup`)
      return
    }
    // Detailed close logging
    const now = Date.now()
    const duration = bridge._connectTime ? Math.round((now - bridge._connectTime) / 1000) : '?'
    const lastSeenAge = bridge.lastSeen ? Math.round((now - bridge.lastSeen) / 1000) : '?'
    const lastPongAge = bridge.lastPong ? Math.round((now - bridge.lastPong) / 1000) : '?'
    const lastType = bridge._lastMessageType || '?'
    let pendingCount = 0
    for (const [, p] of pendingCommands) { if (p.userId === userId) pendingCount++ }
    console.log(`[BridgeWS] bridge closed user=${userId} code=${code} reason=${reasonStr} duration=${duration}s lastSeenAge=${lastSeenAge}s lastPongAge=${lastPongAge}s lastType=${lastType} pending=${pendingCount}`)

    bridges.delete(userId)
    sendToBrowsers(userId, { type: 'disconnect', reason: 'bridge_closed' })
    broadcastAdminEvent('bridge', 'disconnected', {
      user_id:Number(userId), connected:false, alive:false,
    }, { scopes:['overview', 'users', 'ai-operations', 'risk-audit'] })
    // Persist close status to DB
    try {
      await queryRun(
        `INSERT INTO bridge_connection_status (user_id, connected, disconnected_at, last_close_code, last_close_reason, updated_at)
         VALUES (?, 0, NOW(), ?, ?, NOW())
         ON DUPLICATE KEY UPDATE connected=0, disconnected_at=NOW(), last_close_code=?, last_close_reason=?, updated_at=NOW()`,
        [userId, code, reasonStr.slice(0, 255), code, reasonStr.slice(0, 255)]
      )
    } catch (e) { console.error(`[BridgeWS] Failed to persist close status user=${userId}:`, e.message) }
    for (const [cmdId, pending] of pendingCommands) {
      if (pending.userId === userId) {
        clearTimeout(pending.timer)
        pendingCommands.delete(cmdId)
        pending.resolve({ status: 'error', error: 'Bridge disconnected' })
      }
    }
    try {
      const ai = await import('./routes/ai/index.js')
      await ai.stopAutoScheduler(userId)
      await ai.removeUserRuntimeAutoSubscription(userId)
      // Query actual DB state instead of hardcoding enabled: false
      let schedulerEnabled = false
      try {
        const schedRow = await queryOne('SELECT enabled FROM auto_scheduler WHERE user_id = ?', [userId])
        schedulerEnabled = !!schedRow?.enabled
      } catch (e) { console.warn('[BridgeWS] Failed to read scheduler state on disconnect:', e.message) }
      sendToBrowsers(userId, { type: 'auto_state', enabled: schedulerEnabled, runtime_subscribed: false, reason: 'user_bridge_offline' })
    } catch (e) {
      console.error('[BridgeWS] Failed to stop auto-reasoning on disconnect:', e.message)
    }
  })

  ws.on('error', (err) => {
    console.error(`[BridgeWS] Bridge error user=${userId}:`, err.message)
    try {
      queryRun(
        `UPDATE bridge_connection_status SET last_error=?, updated_at=NOW() WHERE user_id=?`,
        [err.message?.slice(0, 255) || '', userId]
      ).catch((e) => console.warn('[BridgeWS] Failed to log bridge error:', e.message))
    } catch {}
  })

  // Read bridge settings from DB (trade_send / auto_reasoning state)
  let dbTradeEnabled = false
  let hasDbRow = false
  try {
    const row = await queryOne('SELECT trade_send_enabled FROM user_bridge_settings WHERE user_id = ?', [userId])
    if (_bridgeInitGen.get(userId) !== gen) {
      console.log(`[BridgeWS] Stale init for user ${userId}, aborting`)
      abortStaleInit()
      return
    }
    if (row) {
      hasDbRow = true
      dbTradeEnabled = !!row.trade_send_enabled
    }
  } catch (e) {
    console.error(`[BridgeWS] Failed to read user_bridge_settings for user ${userId}:`, e.message)
  }
  // Read auto_scheduler.enabled as the source of truth (must match auto_status endpoint)
  let schedulerAutoEnabled = false
  try {
    const schedRow = await queryOne('SELECT enabled FROM auto_scheduler WHERE user_id = ?', [userId])
    if (_bridgeInitGen.get(userId) !== gen) { abortStaleInit(); return }
    schedulerAutoEnabled = !!(schedRow?.enabled)
  } catch (e) { console.error('[BridgeWS] Failed to read auto_scheduler:', e.message) }

  if (initQueue?.overflowed || ws.readyState !== 1) {
    initQueue?.detach()
    return
  }

  // Admin defaults to tradeEnabled=true if no DB record exists, but respects explicit DB value of 0
  // Non-admin: use DB value as-is (defaults to false when no row)
  const isAdmin = userId === (adminUserId || -1)
  const defaultTrade = isAdmin ? (hasDbRow ? dbTradeEnabled : true) : dbTradeEnabled
  const replacedOld = !!existing
  const bridgeEntry = { ws, generation:gen, lastSeen: Date.now(), tradeEnabled: defaultTrade, autoReasoningEnabled: schedulerAutoEnabled, lastPong: Date.now(), lastTradeMode: -1, marketState: null, marketStates: new Map(), _pingInterval: null, _connectTime: Date.now() }
  bridges.set(userId, bridgeEntry)
  ws._userId = userId
  console.log(`[BridgeWS] bridge connected user=${userId} role=${user?.role || 'unknown'} plan=${user?.plan || 'unknown'} replacedOld=${replacedOld}`)
  broadcastAdminEvent('bridge', 'connected', {
    user_id:Number(userId),
    connected:true,
    alive:true,
    trade_enabled:Boolean(defaultTrade),
    auto_reasoning_enabled:Boolean(schedulerAutoEnabled),
  }, { scopes:['overview', 'users', 'ai-operations', 'risk-audit'] })
  // Persist connection status to DB
  try {
    await queryRun(
      `INSERT INTO bridge_connection_status (user_id, connected, connected_at, last_close_code, last_close_reason, last_error, updated_at)
       VALUES (?, 1, NOW(), NULL, NULL, NULL, NOW())
       ON DUPLICATE KEY UPDATE connected=1, connected_at=NOW(), last_close_code=NULL, last_close_reason=NULL, last_error=NULL, updated_at=NOW()`,
      [userId]
    )
  } catch (e) { console.error(`[BridgeWS] Failed to persist connect status user=${userId}:`, e.message) }

  // Notify browsers with current trade/auto state — use auto_scheduler.enabled as single source of truth
  sendToBrowsers(userId, { type: 'hb', mt5_connected: true, mt5_alive: true, trade_enabled: defaultTrade, auto_reasoning_enabled: schedulerAutoEnabled, trade_mode: -1 })

  // A bridge reconnecting during the weekend risk window must immediately
  // reconcile any system-owned positions left from the Friday session.
  import('./jobs/weekly-system-flatten.js')
    .then(({ triggerWeeklySystemFlattenForUser }) => triggerWeeklySystemFlattenForUser(userId))
    .catch(e => console.error(`[WeeklyFlatten] Reconnect trigger failed user=${userId}:`, e.message))

  // Restore auto-reasoning — use auto_scheduler.enabled as source of truth
  if (process.env.DEBUG_BRIDGE_WS === '1') {
    console.log(`[BridgeWS] _initBridge user ${userId}: autoScheduler=${schedulerAutoEnabled} hasDbRow=${hasDbRow}`)
  }
  if (schedulerAutoEnabled) {
    try {
      const ai = await import('./routes/ai/index.js')
      if (_bridgeInitGen.get(userId) !== gen) { abortStaleInit(); return }
      await ai.stopAutoScheduler(userId)
      await ai.startAutoScheduler(userId)
      // Sync Redis subscription
      const restoredCfg = await ai.getAutoConfig(null, userId)
      if (restoredCfg?.enabled) {
        await ai.syncUserRedisSubscription(userId, restoredCfg.prompt_type_id, restoredCfg.selected_symbols || [], true)
        await ai.reconcileAutoSchedulers()
      }
      console.log(`[BridgeWS] Auto-reasoning restored for user ${userId}`)
      sendToBrowsers(userId, { type: 'auto_state', enabled: true, runtime_subscribed: true, reason: 'bridge_connected' })
    } catch (e) {
      console.error(`[BridgeWS] Failed to restore auto-reasoning for user ${userId}:`, e.message)
    }
  }

  // Server-side ping every 15s — if bridge doesn't reply within 45s, close
  bridgeEntry._pingInterval = setInterval(() => {
    const bridge = bridges.get(userId)
    if (!bridge || bridge.ws !== ws) { clearInterval(bridgeEntry._pingInterval); return }
    // Check last activity (any message or pong)
    const lastActivity = Math.max(bridge.lastPong || 0, bridge.lastSeen || 0, bridge.lastMessageAt || 0)
    if (Date.now() - lastActivity > 45000) {
      const lastPongAge = bridge.lastPong ? Math.round((Date.now() - bridge.lastPong) / 1000) : '?'
      const lastSeenAge = bridge.lastSeen ? Math.round((Date.now() - bridge.lastSeen) / 1000) : '?'
      console.log(`[BridgeWS] ping timeout user=${userId} lastPongAge=${lastPongAge}s lastSeenAge=${lastSeenAge}s readyState=${ws.readyState}`)
      try { ws.close(4003, 'Ping timeout') } catch (e) {
        console.error(`[BridgeWS] ping timeout close failed user=${userId} error=${e.message}`)
      }
      clearInterval(bridgeEntry._pingInterval)
      return
    }
    // Send both protocol-level ping and application-level ping
    try { ws.ping() } catch {}
    try { ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })) } catch {}
  }, 15000)

  ws.on('pong', () => {
    const bridge = bridges.get(userId)
    if (bridge) { bridge.lastSeen = Date.now(); bridge.lastPong = Date.now() }
  })

  const onBridgeMessage = (data) => {
    let msg
    try { msg = JSON.parse(data) } catch(e) { return }

    const bridge = bridges.get(userId)
    if (bridge) {
      bridge.lastSeen = Date.now()
      bridge.lastMessageAt = Date.now()
      bridge._lastMessageType = msg.type || '?'
    }

    // Regular status write (throttled)
    if (bridge && (!bridge._lastDbWrite || Date.now() - bridge._lastDbWrite > 60000)) {
      bridge._lastDbWrite = Date.now()
      queryRun('UPDATE users SET bridge_heartbeat = NOW() WHERE id = ?', [userId]).catch(() => {})
      const hb = bridge._clientHeartbeat || {}
      queryRun(
        `UPDATE bridge_connection_status SET last_seen_at=NOW(), last_message_type=?, client_version=?, mt5_collect_timeout_count=?, updated_at=NOW() WHERE user_id=?`,
        [msg.type || '?', hb.client_version || null, hb.mt5_collect_timeout_count || 0, userId]
      ).catch(() => {})
    }

    // Heartbeat time write (independent throttle)
    const isHeartbeat = msg.type === 'hb' || msg.type === 'pong'
    if (bridge && isHeartbeat && (!bridge._lastPongDbWrite || Date.now() - bridge._lastPongDbWrite > 60000)) {
      bridge._lastPongDbWrite = Date.now()
      queryRun(
        `UPDATE bridge_connection_status SET last_pong_at=NOW(), updated_at=NOW() WHERE user_id=?`,
        [userId]
      ).catch(() => {})
    }

    // Store client heartbeat data
    if (msg.type === 'hb' && bridge) {
      bridge._clientHeartbeat = {
        ts: msg.ts,
        client_version: msg.client_version,
        mt5_collect_timeout_count: msg.mt5_collect_timeout_count || 0,
        last_data_sent_age_sec: msg.last_data_sent_age_sec ?? -1,
        last_quote_time: msg.last_quote_time || null,
        timezone_offset_minutes: msg.timezone_offset_minutes ?? null,
        clock_status: msg.clock_status || 'unknown',
        clock_residual_ms: msg.clock_residual_ms ?? null,
        receivedAt: Date.now(),
      }
      applyBridgeMarketState(bridge, msg, userId)
      broadcastAdminEvent('bridge', 'heartbeat', {
        user_id:Number(userId),
        connected:true,
        alive:Boolean(bridge.ws?.readyState === 1 && Date.now() - bridge.lastSeen < 20_000),
        last_seen_at_utc_msc:bridge.lastSeen || null,
        mt5_time:bridge.mt5TimeStr || msg.last_quote_time || null,
        timezone_offset_minutes:bridge.timezoneOffsetMinutes ?? msg.timezone_offset_minutes ?? null,
        market_state:bridge.marketState?.state || null,
        trade_mode:typeof bridge.lastTradeMode === 'number' ? bridge.lastTradeMode : -1,
      }, {
        scopes:['overview', 'users', 'ai-operations', 'risk-audit'],
        refresh:false,
        throttleKey:`admin-bridge-heartbeat:${userId}`,
        minIntervalMs:5000,
      })
      if (userId === adminUserId && Number.isFinite(Number(msg.timezone_offset_minutes))) setWeeklyMarketTimezoneOffset(msg.timezone_offset_minutes)
    }

    if (msg.type === 'data') {
      if (bridge && msg.quote) {
        bridge.timezoneOffsetMinutes = msg.quote.timezone_offset_minutes ?? bridge.timezoneOffsetMinutes ?? null
        bridge.clockStatus = msg.quote.clock_status || bridge.clockStatus || 'unknown'
        bridge.clockResidualMs = msg.quote.clock_residual_ms ?? bridge.clockResidualMs ?? null
        bridge.brokerServer = msg.account?.server || bridge.brokerServer || null
        bridge.accountLogin = msg.account?.login || bridge.accountLogin || null
        if (userId === adminUserId && Number.isFinite(Number(msg.quote.timezone_offset_minutes))) setWeeklyMarketTimezoneOffset(msg.quote.timezone_offset_minutes)
      }
      const explicitMarketState = bridge && msg.quote ? applyBridgeMarketState(bridge, { symbol: msg.quote.symbol, ...msg.quote }, userId) : null
      if (bridge && msg.quote && typeof msg.quote.time === 'string') {
        const now = Date.now()
        bridge.lastTickMs = now
        const prev = bridge.mt5TimeStr
        bridge.mt5TimeStr = msg.quote.time
        if (!explicitMarketState && prev !== undefined) {
          if (msg.quote.time !== prev) {
            if (bridge.lastTradeMode !== 4) {
              console.log(`[BridgeWS] User ${userId}: market OPENED (tick=${msg.quote.time}, was tradeMode=${bridge.lastTradeMode})`)
            }
            bridge.lastTradeMode = 4
            bridge._sameTickStart = null
          } else {
            if (!bridge._sameTickStart) bridge._sameTickStart = now
            if (now - bridge._sameTickStart > MARKET_SAME_TICK_CLOSED_MS) {
              if (bridge.lastTradeMode !== 0) {
                console.log(`[BridgeWS] User ${userId}: market CLOSED (tick stuck at ${msg.quote.time} for >5s, was tradeMode=${bridge.lastTradeMode})`)
              }
              bridge.lastTradeMode = 0
            }
          }
        }
      }
      const tradeMode = bridge ? bridge.lastTradeMode : -1
      sendToBrowsers(userId, { type: 'data', trade_mode: tradeMode, ...msg })
      broadcastAdminEvent('market', 'tick', {
        user_id:Number(userId),
        trade_mode:tradeMode,
        quote:msg.quote ? {
          symbol:msg.quote.symbol || null,
          bid:msg.quote.bid ?? null,
          ask:msg.quote.ask ?? null,
          time:msg.quote.time || null,
          market_state:msg.quote.market_state || bridge?.marketState?.state || null,
          market_reason:msg.quote.market_reason || bridge?.marketState?.detailReason || null,
        } : null,
      }, {
        scopes:['ai-operations', 'risk-audit'],
        refresh:false,
        throttleKey:`admin-market-tick:${userId}`,
        minIntervalMs:1000,
      })

      if (bridge && msg.positions) {
        const curTickets = msg.positions.map(p => p.ticket).sort().join(',')
        const prevTickets = bridge._lastPositionTickets || ''
        if (curTickets !== prevTickets) {
          bridge._lastPositionTickets = curTickets
        }
      }
    } else if (msg.type === 'hb' || msg.type === 'pong') {
      if (bridge) bridge.lastPong = Date.now()
    } else if (msg.type === 'result') {
      if (msg.command_id) {
        const pending = pendingCommands.get(msg.command_id)
        if (pending && pending.userId === Number(userId) && pending.ws === ws
          && pending.bridgeGeneration === Number(bridge?.generation || 0)) {
          clearTimeout(pending.timer)
          pendingCommands.delete(msg.command_id)
          pending.resolve(msg.result)
        }
      }
    }
  }
  ws.on('message', onBridgeMessage)
  // Register then detach synchronously so no message can fall into an init gap.
  for (const data of initQueue?.drain() || []) onBridgeMessage(data)

  initComplete = true
  try {
    const syncResult = await sendBridgeCommand(userId, 'toggle_trade', { enable: defaultTrade }, 5000, { noFallback: true })
    if (syncResult?.status !== 'success') {
      console.warn(`[BridgeWS] Failed to synchronize trade state user=${userId}:`, syncResult?.message || syncResult?.error || 'unknown_error')
    }
  } catch (error) {
    console.warn(`[BridgeWS] Trade state synchronization failed user=${userId}:`, error.message)
  }
  try {
    const account = await sendBridgeCommand(userId, 'account', {}, 5000, { noFallback: true })
    if (account?.status === 'success' && account.server && account.login !== undefined) {
      const currentBridge = bridges.get(userId)
      if (currentBridge?.ws === ws) {
        currentBridge.brokerServer = account.server
        currentBridge.accountLogin = account.login
      }
      const ai = await import('./routes/ai/index.js')
      const identity = await ai.syncTradingAccountIdentity(userId, account)
      if (currentBridge?.ws === ws) currentBridge.tradingAccountId = identity.accountId
      if (identity.verified) queueAccountPerformanceSync(userId, identity.accountId, { recent:false, delayMs:250 })
      sendToBrowsers(userId, {
        type: 'account_switched',
        account: { id:identity.accountId, server:account.server, login:account.login },
        switched: Boolean(identity.switched),
        ownership_transferred: Boolean(identity.ownershipTransferred),
        verified: Boolean(identity.verified),
        anomaly_code: identity.anomalyCode || null,
      })
      for (const previousUserId of identity.previousOwnerUserIds || []) {
        sendToBrowsers(previousUserId, {
          type: 'account_transferred',
          account: { server:account.server, login:account.login },
          reason: 'new_trade_authorized_bridge_connected',
        })
        await ai.stopAutoScheduler(previousUserId).catch(() => {})
        await ai.removeUserRuntimeAutoSubscription(previousUserId).catch(() => {})
        const previousBridge = bridges.get(Number(previousUserId))
        if (previousBridge?.ws?.readyState === 1) {
          previousBridge.tradeEnabled = false
          previousBridge.autoReasoningEnabled = false
          try { await sendBridgeCommand(previousUserId, 'toggle_trade', { enable:false }, 2000, { noFallback:true }) } catch {}
          try { previousBridge.ws.close(4004, 'MT5 account ownership transferred') } catch {}
        }
      }
    } else {
      console.warn(`[BridgeWS] Account identity synchronization skipped user=${userId}:`, account?.message || account?.error || 'identity_unavailable')
    }
  } catch (error) {
    console.warn(`[BridgeWS] Account identity synchronization failed user=${userId}:`, error.message)
  }
}

// ============ Helpers ============

function validHistoryDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
}

export function normalizeBridgePage(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 1_000_000) : 1
}

export function normalizeBridgePageSize(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : 20
}

async function resolveHistoryRange(userId, params = {}) {
  const scope = ['all', 'platform', 'custom'].includes(params.history_scope) ? params.history_scope : 'all'
  if (scope === 'all') return { scope, date_from: null, date_to: null }
  if (scope === 'custom') {
    const dateFrom = validHistoryDate(params.close_from) ? params.close_from : null
    const dateTo = validHistoryDate(params.close_to) ? params.close_to : null
    if (!dateFrom && !dateTo) throw new Error('custom_history_range_required')
    if (dateFrom && dateTo && dateFrom > dateTo) throw new Error('invalid_history_range')
    return { scope, date_from: dateFrom, date_to: dateTo }
  }
  const account = await queryOne(`SELECT DATE_FORMAT(COALESCE(ownership.started_at, ta.first_verified_at), '%Y-%m-%d') AS platform_connected_date
    FROM trading_accounts ta
    JOIN mt5_account_bindings bindings ON bindings.current_trading_account_id = ta.id
      AND bindings.current_user_id = ta.user_id
    LEFT JOIN mt5_account_ownership_history ownership ON ownership.trading_account_id = ta.id
      AND ownership.user_id = ta.user_id AND ownership.ended_at IS NULL
    WHERE ta.user_id = ? AND ta.is_deleted = 0
    ORDER BY ta.identity_verified_at DESC, ta.id DESC LIMIT 1`, [userId])
  if (!account?.platform_connected_date) throw new Error('platform_connection_time_unavailable')
  const dateFrom = account.platform_connected_date
  return { scope, date_from: dateFrom, date_to: null }
}

export function sendToAdminBrowsers(data) {
  let json
  try { json = JSON.stringify(data) } catch { return 0 }
  let delivered = 0
  for (const ws of adminBrowsers) {
    if (ws.readyState === 1) {
      try { ws.send(json); delivered++ } catch {}
    } else {
      adminBrowsers.delete(ws)
    }
  }
  return delivered
}

export function disconnectUserSockets(userId, reason = 'Session revoked') {
  const id = Number(userId)
  const browserSet = browsers.get(id)
  if (browserSet) {
    for (const ws of browserSet) {
      try { ws.close(4002, reason) } catch {}
    }
    browsers.delete(id)
  }
  const bridge = bridges.get(id)
  if (bridge) {
    if (bridge._pingInterval) clearInterval(bridge._pingInterval)
    if (bridge._performanceSyncTimer) clearTimeout(bridge._performanceSyncTimer)
    try { bridge.ws?.close(4002, reason) } catch {}
    bridges.delete(id)
  }
  for (const ws of adminBrowsers) {
    if (Number(ws._userId) !== id) continue
    try { ws.close(4002, reason) } catch {}
    adminBrowsers.delete(ws)
  }
}

export function broadcastAdminEvent(scope, reason, data = {}, options = {}) {
  const scopes = [...new Set((Array.isArray(options.scopes) ? options.scopes : [scope])
    .map(value => String(value || '').trim()).filter(Boolean))]
  const now = Date.now()
  const throttleKey = String(options.throttleKey || '')
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 0)
  if (throttleKey && minIntervalMs > 0) {
    const previous = adminEventThrottle.get(throttleKey) || 0
    if (now - previous < minIntervalMs) return false
    adminEventThrottle.set(throttleKey, now)
  }
  return sendToAdminBrowsers({
    type:'admin_event',
    event_id:`${now}-${++adminEventSeq}`,
    scope:String(scope || 'system'),
    scopes,
    reason:String(reason || 'updated'),
    refresh:options.refresh !== false,
    changed_at:new Date(now).toISOString(),
    data:data && typeof data === 'object' ? data : {},
  })
}

function sendToBrowsers(userId, data) {
  const set = browsers.get(userId)
  if (set) {
    const json = JSON.stringify(data)
    for (const ws of set) {
      if (ws.readyState === 1) {
        try { ws.send(json) } catch {}
      } else {
        set.delete(ws)
      }
    }
  }
  // Forward sanitized market-only data exclusively to browsers whose resolved
  // observer channel points at this exact source. Never use a global admin fallback.
  if (data.type === 'data' && browsers.size > 0) {
    const observerJson = JSON.stringify({
      type: 'platform_market_tick',
      quote: data.quote || null,
      trade_mode: typeof data.trade_mode === 'number' ? data.trade_mode : -1,
      _source: 'observer_channel',
    })
    const now = Date.now()
    for (const [uid, browserSet] of browsers) {
      const last = _broadcastThrottle.get(uid) || 0
      if (now - last < 250) continue // skip if < 250ms since last broadcast
      let delivered = false
      for (const ws of browserSet) {
        if (Number(ws._observerBridgeUserId || 0) !== Number(userId)) continue
        if (ws.readyState === 1) {
          try { ws.send(observerJson); delivered = true }
          catch (e) { console.error('[BridgeWS] observer broadcast send failed:', uid, e.message) }
        } else {
          browserSet.delete(ws)
        }
      }
      if (delivered) _broadcastThrottle.set(uid, now)
    }
  }
}

// Handle browser commands — route to bridge
async function handleBrowserCommand(ws, userId, msg) {
  const { command_id, action, params = {} } = msg
  const reply = (data) => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'result', command_id, ...data })) } catch {}
    }
  }

  try {
    const ai = await import('./routes/ai/index.js')
    const user = await queryOne('SELECT plan, role, plan_expires_at FROM users WHERE id = ?', [userId])
    const access = buildAiAccessContext(user, { ownBridgeConnected:isBridgeAlive(userId) })
    if (!observerWsActionAllowed(access, action)) {
      const code = access.mode === 'blocked' ? access.reason : 'observer_read_only'
      return reply({ status:'error', code, message:observerAccessError(access), access })
    }
    const observerContext = access.mode === 'observer'
      ? await resolveObserverBridgeContext(userId, user, params.observer_channel_id)
      : null
    const dataUserId = access.mode === 'observer' ? observerContext.bridgeUserId : userId
    const observerStrategyId = access.mode === 'observer'
      ? Number(observerContext?.channel?.strategy_id || 0) || null
      : null
    ws._observerBridgeUserId = access.mode === 'observer' ? Number(dataUserId) || null : null
    ws._observerStrategyId = observerStrategyId
    if (access.mode === 'observer' && action !== 'health' && !dataUserId) {
      return reply({ status:'error', code:'observer_source_offline', message:'管理员观摩账户当前未连接' })
    }

    // Block trade operations when bridge is offline or trading is disabled
    const tradeActions = ['open', 'close', 'execute']
    if (tradeActions.includes(action)) {
      const bridge = bridges.get(userId)
      if (!bridge || bridge.ws.readyState !== 1) {
        return reply({ status: 'error', message: '请先连接您的 MT5 账户' })
      }
      if (bridge.tradeEnabled === false) {
        return reply({ status: 'error', message: '交易发送已关闭，请先开启' })
      }
    }

    let result
    switch (action) {
      case 'health': {
        const bridge = dataUserId ? bridges.get(dataUserId) : null
        const usingFallback = access.read_only
        const connected = !!(bridge && bridge.ws.readyState === 1)
        const alive = connected && (Date.now() - bridge.lastSeen < 20000)
        const tradeEnabled = usingFallback
          ? (alive ? bridge?.tradeEnabled !== false : null)
          : alive && bridge?.tradeEnabled !== false
        const autoReasoningEnabled = usingFallback
          ? (alive ? !!bridge?.autoReasoningEnabled : null)
          : (alive ? !!bridge?.autoReasoningEnabled : false)
        result = {
          status: 'success',
          gateway: {
            mode: alive ? 'live' : 'mock',
            mt5_package_available: true,
            live_trading_enabled: tradeEnabled,
            auto_reasoning_enabled: autoReasoningEnabled,
            using_fallback: usingFallback,
            trade_mode: dataUserId ? await getBridgeTradeMode(dataUserId) : -1,
            access:{ ...access, observer_source_available:Boolean(dataUserId),
              observer_channel:observerContext?.channel || null },
          },
        }
        break
      }
      case 'account': {
        const hasDataBridge = dataUserId && bridges.get(dataUserId)?.ws?.readyState === 1
        if (hasDataBridge) {
          result = await ai.mt5Bridge(dataUserId, 'account', {}, { noFallback:true })
          if (access.read_only && result && typeof result === 'object') result.observer_source = true
        } else {
          result = { status: 'error', message: 'MT5桥接未连接' }
        }
        break
      }
      case 'symbols':
        result = await ai.mt5Bridge(dataUserId, 'symbols', {}, { noFallback:true })
        break
      case 'quote': {
        if (dataUserId && bridges.get(dataUserId)?.ws?.readyState === 1) {
          result = await ai.mt5Bridge(dataUserId, 'quote', { symbol: params.symbol }, { noFallback:true })
        } else {
          result = { status: 'error', message: 'MT5桥接未连接' }
        }
        break
      }
      case 'positions': {
        if (dataUserId && bridges.get(dataUserId)?.ws?.readyState === 1) {
          result = await ai.mt5Bridge(dataUserId, 'positions', {}, { noFallback:true })
          if (access.read_only && result && typeof result === 'object') result.observer_source = true
        } else {
          result = { status: 'error', message: 'MT5桥接未连接' }
        }
        break
      }
      case 'open': {
        // Check trade send enabled
        const openBridge = bridges.get(userId)
        if (!openBridge || openBridge.ws?.readyState !== 1 || openBridge.tradeEnabled === false) {
          result = { status: 'rejected', message: !openBridge || openBridge.ws?.readyState !== 1 ? 'MT5 桥接未连接' : '交易发送已关闭，请先开启', details: {} }
          await ai.insertAudit(null, userId, 'manual_open', params.symbol, params, result, 'rejected')
          break
        }
        const manualConfig = await ai.getInferencePreference(userId, params.session_id || 'default')
        result = await ai.executeOrderCore(userId, {
          ...manualConfig,
          max_position_size: manualConfig.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
        }, params, 'manual_open', { sourceType: 'manual' })
        break
      }
      case 'close': {
        const clBridge = bridges.get(userId)
        const closeParams = {
          ticket:params.ticket,
          confirm:params.confirm === true,
          expected_state:params.expected_state,
        }
        if (!closeParams.confirm) {
          result = { status:'rejected', message:'manual_confirmation_required' }
          await ai.insertAudit(null, userId, 'manual_close', null, closeParams, result, 'rejected')
          break
        }
        if (!clBridge || clBridge.ws?.readyState !== 1 || clBridge.tradeEnabled === false) {
          result = { status: 'rejected', message: !clBridge || clBridge.ws?.readyState !== 1 ? 'MT5 桥接未连接' : '交易发送已关闭，请先开启', details: {} }
          await ai.insertAudit(null, userId, 'manual_close', null, closeParams, result, 'rejected')
          break
        }
        result = await ai.mt5Bridge(userId, 'close', closeParams)
        await ai.insertAudit(null, userId, 'manual_close', null, closeParams, result, result?.status || 'unknown')
        break
      }
      case 'toggle_trade': {
        result = await ai.mt5Bridge(userId, 'toggle_trade', { enable: !!params.enable })
        // Update local trade state
        const bridge = bridges.get(userId)
        if (bridge && result.status === 'success') bridge.tradeEnabled = !!params.enable
        // Persist to DB
        const newEnabled = !!params.enable
        try {
          await queryRun(
            'INSERT INTO user_bridge_settings (user_id, trade_send_enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE trade_send_enabled = ?, updated_at = NOW()',
            [userId, newEnabled ? 1 : 0, newEnabled ? 1 : 0]
          )
        } catch (e) { console.error('[BridgeWS] Failed to persist trade_send_enabled:', e.message) }
        break
      }
      case 'set_quote_symbol': {
        const symbol = params.symbol || 'XAUUSD'
        result = await ai.mt5Bridge(userId, 'set_quote_symbol', { symbol })
        // Persist to user config so bridge reconnects with this symbol
        if (result.status === 'success') {
          const key = `quote_symbol_${userId}`
          const existing = await queryOne('SELECT id FROM system_config WHERE `key` = ?', [key])
          if (existing) await queryRun('UPDATE system_config SET `value` = ? WHERE `key` = ?', [symbol, key])
          else await queryRun('INSERT INTO system_config (category, `key`, `value`) VALUES (?, ?, ?)', ['quote_symbol', key, symbol])
        }
        break
      }
      case 'history': {
        const bridgeOk = dataUserId && bridges.get(dataUserId)?.ws?.readyState === 1
        if (bridgeOk) {
          // 直接透传前端参数给桥接软件（含分页、过滤）
          const bridgeParams = {
            page: normalizeBridgePage(params.page),
            page_size: normalizeBridgePageSize(params.page_size),
            direction: params.direction || '',
            profit_filter: params.profit_filter || '',
            force_refresh: params.force_refresh === true,
          }
          if (validHistoryDate(params.entry_from)) bridgeParams.entry_from = params.entry_from
          if (validHistoryDate(params.entry_to)) bridgeParams.entry_to = params.entry_to
          const range = await resolveHistoryRange(dataUserId, params)
          if (range.date_from) bridgeParams.date_from = range.date_from
          if (range.date_to) bridgeParams.date_to = range.date_to

          result = await ai.mt5Bridge(dataUserId, 'history', bridgeParams, { timeoutMs: 30000, noFallback: true })
          if (result && typeof result === 'object') {
            result.history_range = range
            result.observer_source = access.read_only
          }
        } else {
          result = { status: 'error', message: 'MT5桥接未连接' }
        }
        break
      }
      case 'history_chart_data': {
        const bridgeOk = dataUserId && bridges.get(dataUserId)?.ws?.readyState === 1
        if (bridgeOk) {
          // 直接调用桥接的 chart_data 命令，返回聚合后的图表数据
          const chartParams = { force_refresh: params.force_refresh === true }
          const range = await resolveHistoryRange(dataUserId, params)
          if (range.date_from) chartParams.date_from = range.date_from
          if (range.date_to) chartParams.date_to = range.date_to
          if (params.direction) chartParams.direction = params.direction
          if (params.profit_filter) chartParams.profit_filter = params.profit_filter
          result = await ai.mt5Bridge(dataUserId, 'chart_data', chartParams, { timeoutMs: 30000, noFallback: true })
          if (result && typeof result === 'object') {
            result.history_range = range
            result.observer_source = access.read_only
          }
        } else {
          result = { status: 'error', message: 'MT5桥接未连接' }
        }
        break
      }
      case 'rates':
        result = await ai.platformRates(userId, { symbol: params.symbol, timeframe: params.timeframe || 'M30', count: params.count || 100 })
        break
      case 'diagnostics':
        result = await ai.mt5Bridge(userId, 'diagnostics', {})
        break
      case 'analyze':
        result = await ai.handleAnalyze(userId, params)
        if (result?.signal) {
          result.signal = ai.attachSignalPresentation(ai.restrictSignalExperienceUsage(result.signal, {
            requesterUserId: userId, requesterRole: user?.role || 'user',
          }))
        }
        break
      case 'compare':
        result = await ai.handleAnalyzeCompare(userId, params)
        break
      case 'signals_latest_id': {
        const sessionFilter = params.session_id ? 'AND session_id = ?' : ''
        const sessionParam = params.session_id ? [params.session_id] : []
        const observerSignalFilter = observerStrategyId ? 'AND prompt_type_id = ?' : ''
        const observerSignalParam = observerStrategyId ? [observerStrategyId] : []

        // 观摩模式：用 admin 的信号
        const queryUserId = dataUserId || userId

        // Old user signals
        const oldRow = await queryOne(
          `SELECT id, signal_type, is_executed, created_at, ttl_seconds, timeframe, 'manual' as signal_source FROM ai_signals WHERE user_id = ? ${sessionFilter} ${observerSignalFilter} ORDER BY created_at DESC, id DESC LIMIT 1`,
          [queryUserId, ...sessionParam, ...observerSignalParam]
        )

        // Shared delivery signals
        const delivSessionFilter = params.session_id ? 'AND s.session_id = ?' : ''
        const delivRow = await queryOne(
          `SELECT s.id, s.signal_type, d.is_executed, s.created_at, s.ttl_seconds, s.timeframe, 'auto_shared' as signal_source, d.execution_status
           FROM auto_signal_deliveries d
           JOIN ai_signals s ON s.id = d.signal_id
           WHERE d.user_id = ? ${delivSessionFilter} ${observerStrategyId ? 'AND d.prompt_type_id = ?' : ''} ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
          [queryUserId, ...sessionParam, ...observerSignalParam]
        )

        // Pick the newest of both
        let row = null
        if (oldRow && delivRow) {
          row = (oldRow.created_at >= delivRow.created_at) ? oldRow : delivRow
        } else {
          row = oldRow || delivRow
        }

        if (row) {
          const now = Date.now()
          const createdAt = parseBeijing(row.created_at)?.getTime() ?? 0
          const ttl = (row.ttl_seconds || 3600) * 1000
          row.is_stale = (now - createdAt) > ttl
          row.age_seconds = Math.floor((now - createdAt) / 1000)
          delete row.signal_source
          if (row.execution_status !== undefined) delete row.execution_status
        }
        result = { status: 'success', signal: row || null }
        break
      }
      case 'signal_detail': {
        const signalId = Number(params.signal_id)
        if (!signalId) return reply({ status: 'error', message: 'signal_id required' })

        // In observation mode, delivery is stored under admin's userId
        const detailUserId = dataUserId || userId

        // Check if user has a delivery for this signal
        const delivery = await queryOne(
          `SELECT * FROM auto_signal_deliveries WHERE signal_id = ? AND user_id = ?
            ${observerStrategyId ? 'AND prompt_type_id = ?' : ''}`,
          [signalId, detailUserId, ...(observerStrategyId ? [observerStrategyId] : [])]
        )
        if (delivery) {
          const row = await queryOne('SELECT * FROM ai_signals WHERE id = ?', [signalId])
          if (row) {
            const item = { ...row }
            try { item.market_data = JSON.parse(item.market_data_json) } catch { item.market_data = {} }
            delete item.market_data_json
            item.is_executed = !!delivery.is_executed
            item.executed_at = delivery.executed_at
            item.trade_ticket = delivery.trade_ticket
            item.pending_ticket = delivery.pending_ticket
            item.pending_state = delivery.pending_state
            item.pending_valid_until = delivery.pending_valid_until || item.pending_valid_until
            item.execution_result = delivery.execution_result
            item.approved_order_json = delivery.approved_order_json
            item.execution_status = delivery.execution_status
            item.delivery_id = delivery.id
            item.prompt_type_id = delivery.prompt_type_id
            item.source = 'auto_shared'
            item.pending_actions = await loadSignalPendingActions(detailUserId, signalId, delivery.execution_result)
            item.inference_snapshot = await ai.getInferenceVisualizationSnapshot(signalId)
            if (item.inference_snapshot?.market_snapshot && !item.inference_snapshot.market_snapshot.evidence_ref) item.market_data = item.inference_snapshot.market_snapshot
            ai.attachSignalTiming(item, await getLabTimezoneOffsetMinutes())
            Object.assign(item, ai.attachSignalPresentation(ai.restrictSignalExperienceUsage(item, {
              requesterUserId: userId, requesterRole: user?.role || 'user',
            })))
            result = { status: 'success', signal: item }
          } else {
            result = { status: 'error', message: 'signal not found' }
          }
          break
        }

        // Fallback: old signal check
        const row = await queryOne(`SELECT * FROM ai_signals WHERE id = ? AND (user_id = ? OR user_id = 0)
          ${observerStrategyId ? 'AND prompt_type_id = ?' : ''}`,
        [signalId, detailUserId, ...(observerStrategyId ? [observerStrategyId] : [])])
        if (row) {
          const item = { ...row }
          try { item.market_data = JSON.parse(item.market_data_json) } catch { item.market_data = {} }
          delete item.market_data_json
          item.is_executed = !!item.is_executed
          item.pending_actions = await loadSignalPendingActions(detailUserId, signalId, item.execution_result)
          item.inference_snapshot = await ai.getInferenceVisualizationSnapshot(signalId)
          if (item.inference_snapshot?.market_snapshot && !item.inference_snapshot.market_snapshot.evidence_ref) item.market_data = item.inference_snapshot.market_snapshot
          ai.attachSignalTiming(item, await getLabTimezoneOffsetMinutes())
          Object.assign(item, ai.attachSignalPresentation(ai.restrictSignalExperienceUsage(item, {
            requesterUserId: userId, requesterRole: user?.role || 'user',
          })))
          result = { status: 'success', signal: item }
        } else {
          result = { status: 'error', message: 'signal not found' }
        }
        break
      }
      case 'signals': {
        const offset = Number(params.offset) || 0
        const limit = Math.min(Number(params.limit) || 10, 100)
        const beforeId = Number(params.before_id)
        // 观摩模式：始终用 admin 的信号
        const queryUserId = dataUserId || userId

        // Build shared WHERE conditions for both queries
        const sharedConditions = []
        const sharedParams = []
        if (params.direction) {
          const types = { buy: 'buy,strong_buy', sell: 'sell,strong_sell', hold: 'hold' }
          const dirTypes = types[params.direction] || params.direction
          sharedConditions.push(`signal_type IN (${dirTypes.split(',').map(() => '?').join(',')})`)
          sharedParams.push(...dirTypes.split(','))
        }
        if (params.timeframe) {
          sharedConditions.push('timeframe = ?')
          sharedParams.push(params.timeframe)
        }
        if (params.direction === 'close') {
          sharedConditions.push('session_id = ?')
          sharedParams.push('smart_close')
        }
        const sharedWhere = sharedConditions.length > 0 ? ' AND ' + sharedConditions.join(' AND ') : ''

        // Old signals subquery
        const oldSessionFilter = (params.direction !== 'close' && params.session_id) ? ' AND session_id = ?' : ''
        const oldSessionParam = (params.direction !== 'close' && params.session_id) ? [params.session_id] : []
        const observerOldFilter = observerStrategyId ? ' AND s.prompt_type_id = ?' : ''
        const observerDeliveryFilter = observerStrategyId ? ' AND d.prompt_type_id = ?' : ''
        const observerStrategyParam = observerStrategyId ? [observerStrategyId] : []
        // Lightweight subquery for COUNT (no TEXT columns)
        const countColsOld = 's.id'
        const countColsDeliv = 's.id'
        const countOldSub = `(SELECT ${countColsOld} FROM ai_signals s WHERE s.user_id = ? AND (s.source = 'manual' OR s.source IS NULL)${oldSessionFilter}${observerOldFilter}${sharedWhere.length > 0 ? ' AND ' + sharedConditions.join(' AND ') : ''})`
        const countDelivSub = `(SELECT ${countColsDeliv} FROM auto_signal_deliveries d JOIN ai_signals s ON s.id = d.signal_id WHERE d.user_id = ?${observerDeliveryFilter}${sharedWhere.length > 0 ? ' AND ' + sharedConditions.map(c => 's.' + c).join(' AND ') : ''})`
        // Full subquery for data (exclude market_data_json TEXT for performance)
        const selectCols = 'id, user_id, config_id, prompt_type_id, session_id, source, symbol, timeframe, signal_type, confidence, recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price, recommended_take_profit_tier, ai_model, ttl_seconds, is_executed, executed_at, trade_ticket, execution_result, approved_order_json, created_at, delivery_id, execution_status, entry_method, limit_price, stop_limit_price, pending_valid_until, pending_ticket, pending_state, order_state, schema_version, decision_json'
        const selectColsOld = 's.id, s.user_id, s.config_id, s.prompt_type_id, s.session_id, s.source, s.symbol, s.timeframe, s.signal_type, s.confidence, s.recommended_volume, s.analysis, s.reasoning, s.stop_loss_price, s.take_profit_1_price, s.take_profit_2_price, s.take_profit_3_price, s.recommended_take_profit_tier, s.ai_model, s.ttl_seconds, s.is_executed, s.executed_at, s.trade_ticket, s.execution_result, NULL as approved_order_json, s.created_at, NULL as delivery_id, NULL as execution_status, s.entry_method, s.limit_price, s.stop_limit_price, s.pending_valid_until, s.pending_ticket, s.pending_state, s.order_state, s.schema_version, s.decision_json'
        const selectColsDeliv = 's.id, d.user_id, s.config_id, d.prompt_type_id, s.session_id, s.source, s.symbol, s.timeframe, s.signal_type, s.confidence, s.recommended_volume, s.analysis, s.reasoning, s.stop_loss_price, s.take_profit_1_price, s.take_profit_2_price, s.take_profit_3_price, s.recommended_take_profit_tier, s.ai_model, s.ttl_seconds, d.is_executed, d.executed_at, d.trade_ticket, d.execution_result, d.approved_order_json, s.created_at, d.id as delivery_id, d.execution_status, s.entry_method, s.limit_price, s.stop_limit_price, COALESCE(d.pending_valid_until, s.pending_valid_until) AS pending_valid_until, d.pending_ticket, d.pending_state, s.order_state, s.schema_version, s.decision_json'
        const dataOldSub = `(SELECT ${selectColsOld} FROM ai_signals s WHERE s.user_id = ? AND (s.source = 'manual' OR s.source IS NULL)${oldSessionFilter}${observerOldFilter}${sharedWhere.length > 0 ? ' AND ' + sharedConditions.join(' AND ') : ''})`
        const dataDelivSub = `(SELECT ${selectColsDeliv} FROM auto_signal_deliveries d JOIN ai_signals s ON s.id = d.signal_id WHERE d.user_id = ?${observerDeliveryFilter}${sharedWhere.length > 0 ? ' AND ' + sharedConditions.map(c => 's.' + c).join(' AND ') : ''})`
        const oldParams = [queryUserId, ...oldSessionParam, ...observerStrategyParam, ...sharedParams]

        // Shared signals subquery (delivery overrides user-level execution state)
        const delivParams = [queryUserId, ...observerStrategyParam, ...sharedParams]

        // COUNT uses lightweight subquery (no TEXT); data uses full subquery (no market_data_json)
        const countSql = `SELECT COUNT(*) as total FROM (${countOldSub} UNION ALL ${countDelivSub}) t`
        const cursorWhere = Number.isInteger(beforeId) && beforeId > 0 ? ' WHERE t.id < ?' : ''
        const dataSql = `SELECT ${selectCols} FROM (${dataOldSub} UNION ALL ${dataDelivSub}) t${cursorWhere} ORDER BY t.id DESC, t.created_at DESC LIMIT ? OFFSET ?`
        const dataParams = [...oldParams, ...delivParams]
        if (cursorWhere) dataParams.push(beforeId)
        dataParams.push(limit + 1, cursorWhere ? 0 : offset)
        const [countRow, allRows] = await Promise.all([
          queryOne(countSql, [...oldParams, ...delivParams]),
          queryAll(dataSql, dataParams)
        ])
        const totalCount = countRow?.total || 0
        const hasMore = allRows.length > limit
        const sliced = allRows.slice(0, limit)

        const signalTimezoneOffset = await getLabTimezoneOffsetMinutes()
        const signals = sliced.map(row => {
          const item = { ...row }
          // Both subqueries already output unified columns: delivery_* fields are named as their final names.
          // For shared signals, delivery_id is non-null; mark source as auto_shared.
          if (item.delivery_id) {
            item.source = 'auto_shared'
          }
          try { item.market_data = JSON.parse(item.market_data_json || '{}') } catch { item.market_data = {} }
          delete item.delivery_id
          item.is_executed = !!item.is_executed
          ai.attachSignalTiming(item, signalTimezoneOffset)
          return ai.attachSignalPresentation(ai.restrictSignalExperienceUsage(item, {
            requesterUserId: userId, requesterRole: user?.role || 'user',
          }))
        })
        result = { status: 'success', signals, has_more: hasMore, total_count: totalCount }

        break
      }
      case 'execute': {
        // Check trade send enabled
        const exBridge = bridges.get(userId)
        if (!exBridge || exBridge.ws?.readyState !== 1 || exBridge.tradeEnabled === false) {
          result = { status: 'rejected', message: !exBridge || exBridge.ws?.readyState !== 1 ? 'MT5 桥接未连接' : '交易发送已关闭，请先开启', details: {} }
          await ai.insertAudit(null, userId, 'ai_execute', null, params, result, 'rejected')
          break
        }
        // Check shared delivery first
        const delivery = await queryOne(
          'SELECT * FROM auto_signal_deliveries WHERE signal_id = ? AND user_id = ?',
          [params.signal_id, userId]
        )
        let signal, signalSource
        if (delivery) {
          signal = await queryOne('SELECT * FROM ai_signals WHERE id = ?', [params.signal_id])
          signalSource = 'auto_shared'
        } else {
          signal = await queryOne('SELECT * FROM ai_signals WHERE id = ? AND user_id = ?', [params.signal_id, userId])
          signalSource = 'manual'
        }
        if (!signal) return reply({ status: 'error', message: 'Signal not found' })
        const deliveryAlreadyHandled = delivery && (
          Number(delivery.is_executed) === 1 ||
          delivery.pending_ticket || delivery.trade_ticket ||
          ['success', 'executing', 'uncertain'].includes(delivery.execution_status)
        )
        const manualAlreadyHandled = !delivery && (
          Number(signal.is_executed) === 1 || signal.pending_ticket || signal.trade_ticket
        )
        if (deliveryAlreadyHandled || manualAlreadyHandled) {
          result = { status: 'rejected', message: 'signal_already_executed_or_pending' }
          break
        }

        const config = await ai.getExecuteRiskConfig(userId, signal)
        if (!config) {
          result = { status: 'rejected', message: 'no_risk_config', details: {} }
          await ai.insertAudit(null, userId, 'ai_execute', signal.symbol, params, result, result.status)
          break
        }
        const timedSignal = ai.attachSignalTiming({ ...signal })
        if (timedSignal.is_stale) {
          result = { status: 'rejected', message: 'signal_expired', details: { age_seconds: timedSignal.age_seconds, ttl_seconds: timedSignal.ttl_seconds } }
          await ai.insertAudit(null, userId, 'ai_execute', signal.symbol, params, result, result.status)
          break
        }
        let marketData
        try { marketData = JSON.parse(signal.market_data_json || '{}') } catch (e) {
          console.warn(`[Execute] Failed to parse market_data_json for signal ${params.signal_id}:`, e.message)
          marketData = {}
        }
        const orderPayload = ai.signalOrderPayload(signal, config, marketData, params.confirm)
        result = await ai.executeOrderCore(userId, config, orderPayload, 'ai_execute', {
          sourceType: delivery ? 'auto_delivery' : 'manual_ai',
          signalId: signal.id,
          deliveryId: delivery?.id || null,
        })
        if (result.status === 'success') {
          const isPending = signal.entry_method && signal.entry_method !== 'market' && signal.entry_method !== 'observe'
          const orderTicket = result.order || result.ticket || null
          if (signalSource === 'auto_shared' && delivery) {
            if (isPending) {
              // Fix 6: pending orders write pending_ticket/pending_state, not trade_ticket
              await queryRun(
                `UPDATE auto_signal_deliveries SET execution_status = 'success',
                 pending_ticket = ?, pending_state = 'pending', pending_valid_until = ?,
                 execution_result = ? WHERE id = ?`,
                [String(orderTicket), signal.pending_valid_until || null, JSON.stringify(result), delivery.id])
            } else {
              await queryRun(
                'UPDATE auto_signal_deliveries SET execution_status = ?, is_executed = 1, executed_at = NOW(), trade_ticket = ?, execution_result = ? WHERE id = ?',
                ['success', orderTicket, JSON.stringify(result), delivery.id])
            }
          } else {
            if (isPending) {
              // Fix 6: use pending_state instead of order_state, keep is_executed=0 for pending
              await queryRun('UPDATE ai_signals SET pending_ticket = ?, pending_state = ?, pending_valid_until = ?, execution_result = ? WHERE id = ?',
                [String(orderTicket), 'pending', signal.pending_valid_until || null, JSON.stringify(result), signal.id])
            } else {
              await queryRun('UPDATE ai_signals SET is_executed = 1, executed_at = ?, trade_ticket = ?, execution_result = ? WHERE id = ?', [beijingNow(), orderTicket, JSON.stringify(result), signal.id])
            }
          }
        } else {
          // Update delivery status on failure
          if (signalSource === 'auto_shared' && delivery) {
            const status = result.status === 'rejected' ? 'rejected' : result.status === 'uncertain' ? 'uncertain' : 'failed'
            await queryRun(
              'UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE id = ?',
              [status, JSON.stringify(result), delivery.id])
          } else {
            await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(result || {}), signal.id])
          }
        }
        break
      }
      case 'auto_status': {
        // The switch is user-owned control state. Observation mode may reuse
        // platform market data, but must never expose the administrator's
        // scheduler state as the current user's switch state.
        const runtimeStatus = await ai.getUserAutoRuntimeStatus(userId)
        result = { status: 'success', scheduler: runtimeStatus }
        break
      }
      case 'toggle_auto': {
        const cfg = await ai.getAutoConfig(null, userId)
        const newEnabled = !cfg?.enabled

        // Check bridge connection when enabling
        if (newEnabled) {
          const bridge = bridges.get(userId)
          if (!bridge || bridge.ws?.readyState !== 1) {
            result = { status: 'error', message: '请先连接 MT5 桥接后再开启自动推理' }
            break
          }
        }

        const user = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        const subscriptions = newEnabled
          ? [await queryOne(`SELECT id FROM strategy_subscriptions
              WHERE user_id = ? AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT 1`, [userId])].filter(Boolean)
          : await queryAll(`SELECT id FROM strategy_subscriptions
              WHERE user_id = ? AND is_deleted = 0 AND execution_enabled = 1 ORDER BY updated_at DESC, id DESC`, [userId])
        if (!subscriptions.length) {
          result = { status: 'error', message: '请先在“推理策略”中创建订阅，再开启自动推理' }
          break
        }
        for (const subscription of subscriptions) {
          await ai.updateSubscription(subscription.id, userId, user?.role || 'user', { execution_enabled: newEnabled })
        }
        // Update in-memory bridge state
        const bridgeAuto = bridges.get(userId)
        if (bridgeAuto) bridgeAuto.autoReasoningEnabled = newEnabled
        // Sync Redis + reconcile
        const updatedCfg = await ai.getAutoConfig(null, userId)
        if (newEnabled) {
          await ai.syncUserRedisSubscription(userId, updatedCfg?.prompt_type_id, updatedCfg?.selected_symbols || [], true)
        } else {
          await ai.syncUserRedisSubscription(userId, null, [], false)
        }
        await ai.reconcileAutoSchedulers()
        result = { status: 'success', enabled: newEnabled, message: newEnabled ? '自动推理已开启' : '自动推理已关闭' }
        break
      }
      case 'audit_logs': {
        // 审计日志只显示自己的数据
        let ownRows = await queryAll('SELECT * FROM trade_audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 100', [userId])
        const auditTimezoneOffset = await getLabTimezoneOffsetMinutes()
        const logs = ownRows.map(row => {
          const item = { ...row }
          item.created_at_mt5 = utcToMt5Time(item.created_at, auditTimezoneOffset)
          try { item.request = JSON.parse(item.request_json) } catch { item.request = {} }
          try { item.result = JSON.parse(item.result_json) } catch { item.result = {} }
          delete item.request_json
          delete item.result_json
          return localizeAuditRow(item)
        })
        result = { status: 'success', logs }
        break
      }
      case 'signal_tickets': {
        const ticketMap = {}
        const sigUserId = dataUserId || userId
        const observerTicketFilter = observerStrategyId ? ' AND prompt_type_id = ?' : ''
        const observerTicketParam = observerStrategyId ? [observerStrategyId] : []
        // Old signals
        const oldRows = await queryAll(`SELECT id, trade_ticket, execution_result FROM ai_signals
          WHERE user_id = ? AND is_executed = 1 AND (source = 'manual' OR source IS NULL)
          ${observerTicketFilter} ORDER BY id DESC LIMIT 200`, [sigUserId, ...observerTicketParam])
        for (const row of oldRows) {
          try {
            let ticket = row.trade_ticket
            if (!ticket) {
              const exec = JSON.parse(row.execution_result || '{}')
              ticket = exec.order || exec.ticket || exec.position
            }
            if (ticket) ticketMap[String(ticket)] = row.id
          } catch (e) { console.warn('[BridgeWS] Failed to parse execution_result:', e.message) }
        }
        // New shared signals via deliveries
        const delivRows = await queryAll(
          `SELECT d.signal_id, d.trade_ticket, d.execution_result
           FROM auto_signal_deliveries d
           WHERE d.user_id = ? AND d.is_executed = 1
             ${observerStrategyId ? 'AND d.prompt_type_id = ?' : ''}
           ORDER BY d.id DESC LIMIT 200`,
          [sigUserId, ...observerTicketParam])
        for (const row of delivRows) {
          try {
            let ticket = row.trade_ticket
            if (!ticket) {
              const exec = JSON.parse(row.execution_result || '{}')
              ticket = exec.order || exec.ticket || exec.position
            }
            if (ticket) ticketMap[String(ticket)] = row.signal_id
          } catch (e) { console.warn('[BridgeWS] Failed to parse delivery execution_result:', e.message) }
        }
        result = { status: 'success', tickets: ticketMap }
        break
      }
      case 'save_close_config': {
        result = { status:'error', code:'smart_close_feature_retired', message:'旧智能平仓已停用，请使用仓位管理功能' }
        break
      }
      case 'get_close_config': {
        result = { status:'success', retired:true, config:{ enabled:false } }
        break
      }
      case 'close_status': {
        result = { status:'success', retired:true,
          scheduler:{ enabled:false, paused:true, pause_reason:'feature_retired' } }
        break
      }
      case 'close_signal_tickets': {
        const map = await ai.getCloseSignalTickets(dataUserId || userId)
        result = { status: 'success', tickets: map }
        break
      }
      case 'pending_list': {
        const hasDataBridge = dataUserId && bridges.get(dataUserId)?.ws?.readyState === 1
        if (!hasDataBridge) {
          result = { status: 'error', message: '请先连接 MT5 桥接' }
          break
        }
        try {
          const symbol = params.symbol ? params.symbol : null
          const listResult = await ai.mt5Bridge(dataUserId, 'pending_list', { symbol }, { noFallback:true })
          if (access.read_only && listResult && typeof listResult === 'object') listResult.observer_source = true
          result = listResult
        } catch (e) {
          console.error('[BridgeWS] pending_list error:', e.message)
          result = { status: 'error', message: '获取挂单列表失败' }
        }
        break
      }
      case 'cancel_pending': {
        const ticket = params.ticket
        if (!ticket) return reply({ status: 'error', message: 'ticket required' })
        const cancelParams = { ticket, expected_state: params.expected_state }
        if (params.confirm !== true) {
          result = { status:'rejected', message:'manual_confirmation_required' }
          await ai.insertAudit(null, userId, 'manual_cancel_pending', null,
            cancelParams, result, 'rejected')
          break
        }
        try {
          const cancelResult = await ai.mt5Bridge(userId, 'cancel_pending', cancelParams)
          if (cancelResult?.status === 'success') {
            result = { ...cancelResult, message: '挂单已取消' }
          } else {
            result = { ...(cancelResult || {}), status:cancelResult?.status || 'error',
              message:cancelResult?.message || '取消挂单失败' }
          }
          await ai.insertAudit(null, userId, 'manual_cancel_pending', null,
            cancelParams, result, result?.status || 'unknown')
        } catch (e) {
          console.error('[BridgeWS] cancel_pending error:', e.message)
          result = { status: 'error', message: '取消挂单失败' }
          await ai.insertAudit(null, userId, 'manual_cancel_pending', null,
            cancelParams, result, 'error').catch(() => {})
        }
        break
      }
      case 'signal_by_ticket': {
        const ticket = params.ticket
        if (!ticket) return reply({ status: 'error', message: 'ticket required' })
        try {
          const sigCols = 'id, signal_type, entry_method, limit_price, stop_limit_price, pending_valid_until, order_state, pending_ticket, symbol, timeframe, created_at, confidence, recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price, market_data_json, is_executed, executed_at'
          const ticketStr = String(ticket)
          // 1. Direct match in ai_signals (fast path)
          let signal = await queryOne(
            `SELECT ${sigCols} FROM ai_signals WHERE user_id = ? AND (pending_ticket = ? OR trade_ticket = ?) ORDER BY id DESC LIMIT 1`,
            [dataUserId || userId, ticketStr, ticketStr]
          )
          // 2. Fallback: search auto_signal_deliveries (multi-user pending orders)
          if (!signal) {
            const deliv = await queryOne(
              'SELECT signal_id FROM auto_signal_deliveries WHERE user_id = ? AND pending_ticket = ? ORDER BY id DESC LIMIT 1',
              [dataUserId || userId, ticketStr]
            )
            if (deliv?.signal_id) {
              signal = await queryOne(
                `SELECT ${sigCols} FROM ai_signals WHERE id = ?`,
                [deliv.signal_id]
              )
            }
          }
          if (signal) {
            try { signal.market_data = JSON.parse(signal.market_data_json || '{}') } catch { signal.market_data = {} }
            delete signal.market_data_json
            result = { status: 'success', signal }
          } else {
            result = { status: 'not_found', message: '未找到关联信号' }
          }
        } catch (e) {
          console.error('[BridgeWS] signal_by_ticket error:', e.message)
          result = { status: 'error', message: '查询失败' }
        }
        break
      }
      case 'export_history': {
        // Admin-only: export all history + reasoning as structured data
        const adminUser = user
        if (adminUser?.role !== 'admin') {
          result = { status: 'error', message: '仅管理员可操作' }
          break
        }

        const flattenSignal = s => ({
          id: s.id, type: s.signal_type, confidence: s.confidence,
          volume: s.recommended_volume, analysis: s.analysis, reasoning: s.reasoning,
          stop_loss: s.stop_loss_price, tp1: s.take_profit_1_price,
          tp2: s.take_profit_2_price, tp3: s.take_profit_3_price,
          session: s.session_id || 'default',
          executed: !!s.is_executed, exec_result: s.execution_result,
          created_at: s.created_at, symbol: s.symbol,
        })

        const adminId = await getAdminUserId()
        let expUserId = adminId || userId
        let bridgeOk = bridges.get(expUserId)?.ws?.readyState === 1
        if (!bridgeOk && bridges.get(userId)?.ws?.readyState === 1) {
          expUserId = userId; bridgeOk = true
        }
        if (!bridgeOk) {
          result = { status: 'error', message: '桥接未连接，无法导出历史数据' }
          break
        }
        // Fetch all orders from MT5 bridge
        const exportRange = await resolveHistoryRange(expUserId, params)
        const exportBridgeParams = { page: 1, page_size: 9999 }
        if (exportRange.date_from) exportBridgeParams.date_from = exportRange.date_from
        if (exportRange.date_to) exportBridgeParams.date_to = exportRange.date_to
        const expRes = await ai.mt5Bridge(expUserId, 'history', exportBridgeParams, { timeoutMs: 30000, noFallback: true })
        if (expRes?.status !== 'success' || !Array.isArray(expRes.orders)) {
          result = { status: 'error', message: '获取历史订单失败' }
          break
        }
        let orders = [...expRes.orders]
        // Apply same filters as history page
        const _od = o => (o.close_time || o.time || '')
        const _ot = o => (o.type || '')
        const _op = o => Number(o.profit || 0)
        if (params.close_from) orders = orders.filter(o => _od(o).slice(0, 10) >= params.close_from)
        if (params.close_to) orders = orders.filter(o => _od(o).slice(0, 10) <= params.close_to)
        if (params.entry_from) orders = orders.filter(o => (o.entry_time || '').slice(0, 10) >= params.entry_from)
        if (params.entry_to) orders = orders.filter(o => (o.entry_time || '').slice(0, 10) <= params.entry_to)
        if (params.direction) orders = orders.filter(o => _ot(o).toUpperCase() === params.direction)
        if (params.profit_filter === 'profit') orders = orders.filter(o => _op(o) > 0)
        if (params.profit_filter === 'loss') orders = orders.filter(o => _op(o) < 0)
        orders.sort((a, b) => _od(b).localeCompare(_od(a)))

        const signalRows = await queryAll(
          `SELECT id, trade_ticket, pending_ticket, signal_type, confidence, recommended_volume, analysis, reasoning,
                  stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price,
                  session_id, is_executed, execution_result, created_at, symbol
           FROM ai_signals
           WHERE user_id = ?
           ORDER BY created_at DESC LIMIT 5000`,
          [expUserId]
        )
        const deliveryRows = await queryAll(
          `SELECT d.trade_ticket, d.pending_ticket, d.signal_id, d.execution_result,
                  d.is_executed AS delivery_is_executed,
                  s.signal_type, s.confidence, s.recommended_volume, s.analysis, s.reasoning,
                  s.stop_loss_price, s.take_profit_1_price, s.take_profit_2_price, s.take_profit_3_price,
                  s.session_id, s.created_at, s.symbol
           FROM auto_signal_deliveries d
           JOIN ai_signals s ON s.id = d.signal_id
           WHERE d.user_id = ?
           ORDER BY s.created_at DESC LIMIT 5000`,
          [expUserId]
        )
        const signalIndex = buildSignalRefIndex(signalRows, flattenSignal)
        const deliveryIndex = buildSignalRefIndex(deliveryRows, r => ({
          id: r.signal_id, type: r.signal_type, confidence: r.confidence,
          volume: r.recommended_volume, analysis: r.analysis, reasoning: r.reasoning,
          stop_loss: r.stop_loss_price, tp1: r.take_profit_1_price,
          tp2: r.take_profit_2_price, tp3: r.take_profit_3_price,
          session: r.session_id || 'default', executed: !!r.delivery_is_executed,
          exec_result: r.execution_result, created_at: r.created_at, symbol: r.symbol,
        }))
        for (const [ref, signals] of deliveryIndex) {
          const existing = signalIndex.get(ref) || []
          for (const signal of signals) {
            if (!existing.some(item => String(item.id) === String(signal.id))) existing.push(signal)
          }
          signalIndex.set(ref, existing)
        }

        // Build export rows: one order + reasoning = one row
        const exportRows = orders.map(o => {
          const tk = String(o.ticket || o.order || '')
          const signals = []
          for (const ref of collectTradeRefs(o)) {
            for (const signal of signalIndex.get(ref) || []) {
              if (!signals.some(item => String(item.id) === String(signal.id))) signals.push(signal)
            }
          }
          const mainSignal = signals.find(s => s.session === 'default') || signals[0] || {}
          return {
            // Order fields
            ticket: tk,
            symbol: o.symbol || '',
            direction: (o.type || '').toUpperCase(),
            volume: o.volume || 0,
            entry_price: o.entry_price ?? o.open_price ?? '',
            entry_time: o.entry_time || o.time || '',
            exit_price: o.close_price ?? '',
            close_time: o.close_time || '',
            stop_loss: o.stop_loss ?? o.sl ?? '',
            take_profit: o.take_profit ?? o.tp ?? '',
            profit: o.profit ?? 0,
            profit_points: o.profit_points ?? 0,
            comment: o.comment || '',
            // Reasoning fields
            signal_id: mainSignal.id || '',
            signal_type: mainSignal.type || '',
            signal_confidence: mainSignal.confidence ?? '',
            signal_volume: mainSignal.volume ?? '',
            signal_analysis: mainSignal.analysis || '',
            signal_reasoning: mainSignal.reasoning || '',
            signal_stop_loss: mainSignal.stop_loss ?? '',
            signal_tp1: mainSignal.tp1 ?? '',
            signal_tp2: mainSignal.tp2 ?? '',
            signal_tp3: mainSignal.tp3 ?? '',
            signal_executed: mainSignal.executed ? '是' : '否',
            signal_created: mainSignal.created_at || '',
          }
        })

        result = {
          status: 'success',
          rows: exportRows,
          total: exportRows.length,
          export_time: new Date().toISOString()
        }
        break
      }
      case 'toggle_close': {
        result = { status:'error', code:'smart_close_feature_retired', message:'旧智能平仓已停用，请使用仓位管理功能' }
        break
      }
      case 'run_close_now': {
        result = { status:'error', code:'smart_close_feature_retired', message:'旧智能平仓已停用，请使用仓位管理功能' }
        break
      }
      case 'admin_dashboard': {
        const u = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (u?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }

        const [userStats, signalStats, signalTypeDist, signalTrend, autoReasonStats, tokenStats, tokenTrend, bridgeList, schedulerData, healthStats] = await Promise.all([
          // 1. User stats
          queryOne(`SELECT
            (SELECT COUNT(*) FROM users) AS total_users,
            (SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURDATE()) AS today_new,
            (SELECT COUNT(*) FROM users WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)) AS online_now,
            (SELECT COUNT(*) FROM users WHERE last_seen_at >= CURDATE()) AS today_active,
            (SELECT COUNT(*) FROM users WHERE plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW())) AS pro_users,
            (SELECT COUNT(*) FROM users WHERE plan = 'plus' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW())) AS plus_users,
            (SELECT COUNT(*) FROM users WHERE plan IS NULL OR plan = 'free'
              OR (plan IN ('pro', 'plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW())) AS free_users`),

          // 2. Signal summary
          queryOne(`SELECT
            (SELECT COUNT(*) FROM ai_signals) AS total,
            (SELECT COUNT(*) FROM ai_signals WHERE DATE(created_at) = CURDATE()) AS today,
            (SELECT COUNT(*) FROM ai_signals signals
              WHERE DATE(signals.created_at) = CURDATE()
                AND (signals.is_executed = 1 OR EXISTS (
                  SELECT 1 FROM auto_signal_deliveries deliveries
                  WHERE deliveries.signal_id = signals.id AND deliveries.is_executed = 1
                ))) AS today_executed,
            (SELECT COUNT(*) FROM ai_signals WHERE DATE(created_at) = CURDATE() AND signal_type = 'error') AS today_errors,
            (SELECT COUNT(*) FROM ai_signals WHERE YEARWEEK(created_at, 1) = YEARWEEK(NOW(), 1)) AS week,
            (SELECT COUNT(*) FROM ai_signals WHERE is_executed = 1) AS executed,
            (SELECT ROUND(AVG(confidence)*100, 1) FROM ai_signals
              WHERE signal_type LIKE 'buy%' OR signal_type LIKE 'sell%') AS avg_confidence`),

          // 3. Signal type distribution
          queryAll('SELECT signal_type, COUNT(*) AS cnt FROM ai_signals GROUP BY signal_type ORDER BY cnt DESC'),

          // 4. Daily signal trend (30 days)
          queryAll(`SELECT DATE(created_at) AS day, COUNT(*) AS cnt
            FROM ai_signals WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY DATE(created_at) ORDER BY day`),

          // 5. Auto-reasoning & trade stats
          queryOne(`SELECT
            (SELECT COUNT(*) FROM user_bridge_settings settings JOIN users ON users.id = settings.user_id
              WHERE settings.auto_reasoning_enabled = 1
                AND (users.role = 'admin' OR (users.plan = 'pro' AND (users.plan_expires_at IS NULL OR users.plan_expires_at >= NOW())))) AS auto_reasoning_users,
            (SELECT COUNT(*) FROM user_bridge_settings settings JOIN users ON users.id = settings.user_id
              WHERE settings.trade_send_enabled = 1
                AND (users.role = 'admin' OR (users.plan = 'pro' AND (users.plan_expires_at IS NULL OR users.plan_expires_at >= NOW())))) AS trade_enabled_users,
            (SELECT COUNT(*) FROM auto_scheduler scheduler
              JOIN users ON users.id = scheduler.user_id
              JOIN auto_prompt_types strategy ON strategy.id = scheduler.prompt_type_id
              WHERE scheduler.enabled = 1 AND strategy.is_active = 1 AND strategy.deleted_at IS NULL
                AND (users.role = 'admin' OR (users.plan = 'pro' AND (users.plan_expires_at IS NULL OR users.plan_expires_at >= NOW())))) AS auto_scheduler_users`),

          // 6. Token usage stats from the authoritative model-call ledger.
          queryOne(`SELECT
            (SELECT COALESCE(SUM(token_count), 0) FROM ai_model_usage_logs
              WHERE created_at >= CURDATE() AND request_status IN ('success', 'error')) AS today_tokens,
            (SELECT COALESCE(SUM(token_count), 0) FROM ai_model_usage_logs
              WHERE request_status IN ('success', 'error')) AS total_tokens,
            (SELECT created_at FROM ai_model_usage_logs
              WHERE request_status IN ('success', 'error') ORDER BY id DESC LIMIT 1) AS last_api_call`),

          // 7. Daily token trend (30 days)
          queryAll(`SELECT DATE(created_at) AS day,
            SUM(token_count) AS tokens
            FROM ai_model_usage_logs
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
              AND request_status IN ('success', 'error')
            GROUP BY DATE(created_at) ORDER BY day`),

          // 8. Connected bridges (WSS + trade mode info)
          (async () => {
            const list = []
            for (const [uid, bridge] of bridges) {
              if (bridge.ws?.readyState === 1) {
                const info = await queryOne('SELECT nickname, email, plan FROM users WHERE id = ?', [uid])
                const settings = await queryOne('SELECT trade_send_enabled, auto_reasoning_enabled FROM user_bridge_settings WHERE user_id = ?', [uid])
                list.push({
                  userId: uid,
                  nickname: info?.nickname || '',
                  email: info?.email || '',
                  plan: info?.plan || 'free',
                  tradeEnabled: !!settings?.trade_send_enabled,
                  autoReasoning: !!settings?.auto_reasoning_enabled,
                  lastSeen: bridge.lastSeen
                })
              }
            }
            return list
          })(),

          // 9. Scheduler state from Redis + DB subscription stats
          (async () => {
            const redis = getRedis()
            const schedulers = []
            const dbRows = await queryAll(`
              SELECT s.prompt_type_id, apt.title AS prompt_type_name, apt.symbols_json, apt.interval_minutes,
                     COUNT(DISTINCT s.user_id) AS subscriber_count
              FROM auto_scheduler s
              JOIN auto_prompt_types apt ON apt.id = s.prompt_type_id
              WHERE s.enabled = 1 AND apt.is_active = 1 AND apt.deleted_at IS NULL
              GROUP BY s.prompt_type_id, apt.title, apt.symbols_json, apt.interval_minutes
              ORDER BY subscriber_count DESC
            `)
            if (redis && isRedisAvailable()) {
              try {
                const keys = await redis.smembers('auto:scheduler:keys')
                for (const k of keys) {
                  const state = await redis.hgetall(`auto:scheduler:${k}:state`)
                  if (!state || !state.running) continue
                  const [ptId, symbol] = k.split(':')
                  const dbInfo = dbRows.find(r => String(r.prompt_type_id) === ptId)
                  // Real-time subscriber count from Redis Set
                  const realTimeCount = await redis.scard(`auto:scheduler:${k}:subs`)
                  schedulers.push({
                    key: k,
                    prompt_type_id: Number(ptId),
                    prompt_type_name: dbInfo?.prompt_type_name || '',
                    symbol,
                    running: state.running === '1',
                    in_flight: state.in_flight === '1',
                    subscriber_count: realTimeCount || 0,
                    interval_minutes: Number(state.interval_minutes || 5),
                    last_run_at: state.last_run_at || '',
                    last_error: state.last_error || '',
                    wait_reason: state.wait_reason || '',
                    next_run_in_seconds: Number(state.next_run_in_seconds || 0),
                    market_reason: state.market_reason || '',
                  })
                }
              } catch (e) { console.error('[admin_dashboard] Redis scheduler read error:', e.message) }
            }
            // Fill in Redis subs counts for DB-only schedulers (no runtime state)
            if (redis && isRedisAvailable()) {
              try {
                const autoSchedulerState = getRegisteredAutoSchedulerState()
                for (const db of dbRows) {
                  const hasRuntime = schedulers.some(s => String(s.prompt_type_id) === String(db.prompt_type_id))
                  if (hasRuntime) continue
                  let totalSubs = 0
                  const symbols = (() => { try { return JSON.parse(db.symbols_json || '[]') } catch { return [] } })()
                  for (const sym of symbols) {
                    const k = `${db.prompt_type_id}:${sym}`
                    const count = await redis.scard(`auto:scheduler:${k}:subs`)
                    totalSubs += count || 0
                    // Fallback: if Redis has no subs, check in-memory scheduler state
                    if (totalSubs === 0 && autoSchedulerState[k]?.subscribers?.size > 0) {
                      totalSubs = autoSchedulerState[k].subscribers.size
                    }
                  }
                  db.subscriber_count = totalSubs
                  // Also add as runtime scheduler if in-memory state exists but Redis missed it
                  if (totalSubs > 0) {
                    const firstSym = symbols[0] || ''
                    const k = `${db.prompt_type_id}:${firstSym}`
                    const memState = autoSchedulerState[k]
                    if (memState) {
                      schedulers.push({
                        key: k,
                        prompt_type_id: db.prompt_type_id,
                        prompt_type_name: db.prompt_type_name || '',
                        symbol: firstSym,
                        running: memState.running || false,
                        in_flight: memState.inFlight || false,
                        subscriber_count: memState.subscribers?.size || 0,
                        interval_minutes: memState.intervalMinutes || db.interval_minutes || 5,
                        last_run_at: memState.lastRunAt || '',
                        last_error: memState.lastError || '',
                        wait_reason: memState.waitReason || '',
                        next_run_in_seconds: memState.nextRunInSeconds || 0,
                        market_reason: memState.marketState?.reason || '',
                      })
                    }
                  }
                }
              } catch (e) { console.error('[admin_dashboard] Redis subs count error:', e.message) }
            }
            return { schedulers, dbStats: dbRows }
          })(),

          // 10. Actionable operating health for the administrator workbench.
          queryOne(`SELECT
            (SELECT COUNT(*) FROM ai_model_usage_logs WHERE created_at >= CURDATE()
              AND request_status IN ('success', 'error')) AS model_requests_today,
            (SELECT COUNT(*) FROM ai_model_usage_logs WHERE created_at >= CURDATE()
              AND request_status = 'error') AS model_failures_today,
            (SELECT ROUND(AVG(duration_ms)) FROM ai_model_usage_logs WHERE created_at >= CURDATE() AND request_status = 'success') AS avg_model_latency_ms,
            (SELECT COALESCE(SUM(COALESCE(request_bytes, 0) + COALESCE(response_bytes, 0)), 0)
              FROM ai_model_usage_logs WHERE created_at >= CURDATE()
                AND request_status IN ('success', 'error')) AS model_bytes_today,
            (SELECT COUNT(*) FROM period_review_cases review_case
              WHERE review_case.status IN ('draft', 'edited')
                AND review_case.id = (
                  SELECT candidate.id FROM period_review_cases candidate
                  WHERE candidate.user_id = review_case.user_id
                    AND candidate.period_type = review_case.period_type
                    AND candidate.period_key = review_case.period_key
                    AND COALESCE(candidate.trading_account_id, 0) = COALESCE(review_case.trading_account_id, 0)
                    AND candidate.strategy_id = review_case.strategy_id
                  ORDER BY (candidate.status = 'approved') DESC, candidate.id DESC LIMIT 1
                )) AS reviews_pending,
            (SELECT COUNT(*) FROM period_review_cases review_case
              WHERE review_case.status = 'failed'
                AND review_case.id = (
                  SELECT candidate.id FROM period_review_cases candidate
                  WHERE candidate.user_id = review_case.user_id
                    AND candidate.period_type = review_case.period_type
                    AND candidate.period_key = review_case.period_key
                    AND COALESCE(candidate.trading_account_id, 0) = COALESCE(review_case.trading_account_id, 0)
                    AND candidate.strategy_id = review_case.strategy_id
                  ORDER BY (candidate.status = 'approved') DESC, candidate.id DESC LIMIT 1
                )) AS reviews_failed,
            (SELECT COUNT(*) FROM risk_decisions WHERE created_at >= CURDATE() AND decision_status = 'reject') AS risk_rejections_today`)
        ])

        result = {
          status: 'success',
          data: {
            userStats: userStats || {},
            signalStats: signalStats || {},
            signalTypeDist: signalTypeDist || [],
            signalTrend: signalTrend || [],
            autoReasonStats: autoReasonStats || {},
            tokenStats: tokenStats || {},
            tokenTrend: tokenTrend || [],
            bridges: bridgeList || [],
            schedulerData: schedulerData || { schedulers: [], dbStats: [] },
            healthStats: healthStats || {}
          }
        }
        break
      }
      case 'admin_user_status': {
        // Admin: lookup a specific user's system status by email or user_id
        const u2 = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (u2?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }

        const email = params.email?.trim()
        const targetId = Number(params.user_id)
        if (!email && !targetId) { result = { status: 'error', message: '需要 email 或 user_id 参数' }; break }

        const targetUser = email
          ? await queryOne('SELECT id, nickname, email, phone, plan, role, last_seen_at, created_at FROM users WHERE email = ?', [email])
          : await queryOne('SELECT id, nickname, email, phone, plan, role, last_seen_at, created_at FROM users WHERE id = ?', [targetId])
        if (!targetUser) { result = { status: 'error', message: '用户不存在' }; break }

        const tid = targetUser.id
        const [targetSettings, targetScheduler, targetSignals, bridgeStatus] = await Promise.all([
          queryOne('SELECT trade_send_enabled, auto_reasoning_enabled FROM user_bridge_settings WHERE user_id = ?', [tid]),
          queryOne('SELECT enabled, last_run_at, selected_symbols_json FROM auto_scheduler WHERE user_id = ?', [tid]),
          (async () => {
            const oldStats = await queryOne(`SELECT
              (SELECT COUNT(*) FROM ai_signals WHERE user_id = ?) AS old_total,
              (SELECT COUNT(*) FROM ai_signals WHERE user_id = ? AND DATE(created_at) = CURDATE()) AS old_today,
              (SELECT COUNT(*) FROM ai_signals WHERE user_id = ? AND is_executed = 1) AS old_executed`, [tid, tid, tid])
            const delivStats = await queryOne(`SELECT
              COUNT(*) AS deliv_total,
              SUM(CASE WHEN DATE(d.created_at) = CURDATE() THEN 1 ELSE 0 END) AS deliv_today,
              SUM(CASE WHEN d.is_executed = 1 THEN 1 ELSE 0 END) AS deliv_executed
              FROM auto_signal_deliveries d WHERE d.user_id = ?`, [tid])
            const lastSignal = await queryOne(
              `SELECT id, signal_type, created_at FROM ai_signals WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [tid])
            const lastDelivery = await queryOne(
              `SELECT s.id, s.signal_type, s.created_at FROM auto_signal_deliveries d JOIN ai_signals s ON s.id = d.signal_id WHERE d.user_id = ? ORDER BY s.id DESC LIMIT 1`, [tid])
            let lastSignalType = null, lastSignalAt = null
            if (lastSignal && lastDelivery) {
              if (lastSignal.id >= lastDelivery.id) {
                lastSignalType = lastSignal.signal_type; lastSignalAt = lastSignal.created_at
              } else {
                lastSignalType = lastDelivery.signal_type; lastSignalAt = lastDelivery.created_at
              }
            } else if (lastSignal) {
              lastSignalType = lastSignal.signal_type; lastSignalAt = lastSignal.created_at
            } else if (lastDelivery) {
              lastSignalType = lastDelivery.signal_type; lastSignalAt = lastDelivery.created_at
            }
            return {
              total_signals: Number(oldStats?.old_total || 0) + Number(delivStats?.deliv_total || 0),
              today_signals: Number(oldStats?.old_today || 0) + Number(delivStats?.deliv_today || 0),
              executed_signals: Number(oldStats?.old_executed || 0) + Number(delivStats?.deliv_executed || 0),
              last_signal_type: lastSignalType,
              last_signal_at: lastSignalAt,
            }
          })(),
          (async () => {
            const bridge = bridges.get(tid)
            const connected = !!(bridge && bridge.ws?.readyState === 1)
            const alive = connected && (Date.now() - bridge.lastSeen < 20000)
            return { connected, alive, lastSeen: bridge?.lastSeen || null }
          })()
        ])

        let selectedSymbols = []
        try { selectedSymbols = JSON.parse(targetScheduler?.selected_symbols_json || '[]') } catch {}
        result = {
          status: 'success',
          data: {
            user: targetUser,
            settings: targetSettings || { trade_send_enabled: 0, auto_reasoning_enabled: 0 },
            scheduler: targetScheduler
              ? { ...targetScheduler, symbols: selectedSymbols.join('、') || null }
              : { enabled: 0, symbols: null, last_run_at: null },
            signals: targetSignals || {},
            bridge: bridgeStatus
          }
        }
        break
      }
      case 'admin_user_search': {
        // Admin: search users by email or nickname for dropdown
        const u4 = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (u4?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }

        const searchTerm = (params.q || '').trim()
        const limit = Math.min(Number(params.limit) || 5, 20)
        let users
        if (searchTerm) {
          users = await queryAll(
            `SELECT id, email, nickname, plan, role, plan_expires_at,
              (plan IN ('pro', 'plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS membership_expired
             FROM users WHERE email LIKE ? OR nickname LIKE ? ORDER BY last_seen_at DESC LIMIT ?`,
            [`%${searchTerm}%`, `%${searchTerm}%`, limit]
          )
        } else {
          users = await queryAll(
            `SELECT id, email, nickname, plan, role, plan_expires_at,
              (plan IN ('pro', 'plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS membership_expired
             FROM users ORDER BY last_seen_at DESC LIMIT ?`,
            [limit]
          )
        }
        result = { status: 'success', users }
        break
      }
      case 'admin_user_list': {
        // Admin: paginated user list with status
        const u5 = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (u5?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }

        const page = Math.max(1, Number(params.page) || 1)
        const pageSize = Math.min(Number(params.pageSize) || 10, 50)
        const offset = (page - 1) * pageSize

        const countRow = await queryOne('SELECT COUNT(*) AS total FROM users')
        const rows = await queryAll(
          `SELECT id, email, phone, nickname, plan, role, plan_expires_at,
             (plan IN ('pro', 'plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS membership_expired,
             last_seen_at, bridge_heartbeat, created_at FROM users
           ORDER BY bridge_heartbeat DESC, last_seen_at DESC
           LIMIT ? OFFSET ?`,
          [pageSize, offset]
        )

        // Enrich page results with bridge/settings status (only current page)
        const enriched = await Promise.all(rows.map(async r => {
          const bridge = bridges.get(r.id)
          const connected = !!(bridge && bridge.ws?.readyState === 1)
          const settings = await queryOne('SELECT trade_send_enabled, auto_reasoning_enabled FROM user_bridge_settings WHERE user_id = ?', [r.id])
          const scheduler = await queryOne('SELECT enabled FROM auto_scheduler WHERE user_id = ?', [r.id])
          return {
            ...r,
            bridgeConnected: connected,
            autoReasoning: !!(settings?.auto_reasoning_enabled),
            tradeEnabled: !!(settings?.trade_send_enabled),
            schedulerEnabled: !!(scheduler?.enabled)
          }
        }))

        result = {
          status: 'success',
          users: enriched,
          total: countRow?.total || 0,
          page,
          pageSize
        }
        break
      }
      default:
        result = { status: 'error', message: `Unknown action: ${action}` }
    }
    reply(result || { status: 'error', message: 'No result' })
  } catch (err) {
    console.error('[BridgeWS] handleBrowserCommand error:', err.message)
    reply({ status: 'error', message: '操作失败，请重试' })
  }
}

// Send command to bridge and wait for result
export async function sendBridgeCommand(userId, action, params, timeoutMs = 5000, options = {}) {
  if (action === 'open' || action === 'pending') {
    const riskLock = weeklyRiskLockResult()
    if (riskLock) return riskLock
  }

  const numericUserId = Number(userId)
  let bridge = bridges.get(numericUserId)

  if (!bridge || bridge.ws.readyState !== 1) {
    return { status: 'error', error: 'Bridge not connected' }
  }
  const initialGeneration = Number(bridge.generation || 0)
  if (options.expectedGeneration != null
    && initialGeneration !== Number(options.expectedGeneration)) {
    return { status:'error', error:'Bridge generation changed before command write' }
  }

  const cmdId = `cmd_${Date.now()}_${++cmdCounter}`
  if (typeof options.beforeWrite === 'function') {
    try {
      const allowed = await options.beforeWrite({
        commandId:cmdId,
        bridgeGeneration:initialGeneration,
        userId:numericUserId,
        action,
      })
      if (allowed === false) return { status:'error', error:'Bridge command write blocked' }
    } catch (error) {
      return { status:'error', error:`Bridge command write blocked: ${error.message}` }
    }
  }

  // The durable guard above may await database I/O. Resolve the connection
  // again immediately before ws.send so a reconnect cannot inherit a command
  // prepared for an older Bridge generation.
  bridge = bridges.get(numericUserId)
  if (!bridge || bridge.ws.readyState !== 1) {
    return { status:'error', error:'Bridge disconnected before command write' }
  }
  if (options.expectedGeneration != null
    && Number(bridge.generation || 0) !== Number(options.expectedGeneration)) {
    return { status:'error', error:'Bridge generation changed before command write' }
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(cmdId)
      resolve({ status: 'error', error: 'Bridge command timeout' })
    }, timeoutMs)

    pendingCommands.set(cmdId, {
      resolve, timer, userId:numericUserId,
      ws:bridge.ws, bridgeGeneration:Number(bridge.generation || 0),
    })
    try {
      bridge.ws.send(JSON.stringify({ type: 'command', command_id: cmdId, action, params }))
    } catch {
      clearTimeout(timer)
      pendingCommands.delete(cmdId)
      resolve({ status: 'error', error: 'Bridge send failed' })
    }
  })
}

// Check if a user has an active bridge
export function isBridgeAlive(userId) {
  const bridge = bridges.get(userId)
  return !!(bridge && bridge.ws.readyState === 1 && (Date.now() - bridge.lastSeen < 20000))
}

// Check if live trading is enabled for a user
export function isTradeEnabled(userId) {
  const bridge = bridges.get(userId)
  if (!bridge || bridge.ws.readyState !== 1) return false
  return bridge.tradeEnabled !== false
}

// Apply administrator-managed observer-source switches to an already connected
// bridge. Database persistence is handled by the observer-source service so the
// desired state also survives bridge restarts.
export async function applyBridgeRuntimeState(userId, { tradeEnabled, autoReasoningEnabled } = {}) {
  const numericUserId = Number(userId)
  const bridge = bridges.get(numericUserId)
  const connected = !!(bridge && bridge.ws?.readyState === 1)
  let tradeApplied = !connected
  let tradeError = null

  if (bridge && typeof autoReasoningEnabled === 'boolean') {
    bridge.autoReasoningEnabled = autoReasoningEnabled
  }
  if (bridge && typeof tradeEnabled === 'boolean') {
    // Disable locally before the command is acknowledged so no server-side
    // order can slip through while the bridge processes the switch.
    if (!tradeEnabled) bridge.tradeEnabled = false
    const result = await sendBridgeCommand(numericUserId, 'toggle_trade', { enable:tradeEnabled }, 5000, { noFallback:true })
    tradeApplied = result?.status === 'success'
    if (tradeApplied) bridge.tradeEnabled = tradeEnabled
    else tradeError = result?.message || result?.error || 'bridge_runtime_sync_failed'
  }

  if (typeof autoReasoningEnabled === 'boolean') {
    sendToBrowsers(numericUserId, {
      type:'auto_state', enabled:autoReasoningEnabled,
      runtime_subscribed:autoReasoningEnabled && connected,
      reason:'observer_source_admin_update',
    })
  }
  if (typeof tradeEnabled === 'boolean') {
    sendToBrowsers(numericUserId, {
      type:'hb', mt5_connected:connected, mt5_alive:connected,
      trade_enabled:connected ? bridge?.tradeEnabled !== false : tradeEnabled,
      auto_reasoning_enabled:typeof autoReasoningEnabled === 'boolean'
        ? autoReasoningEnabled : Boolean(bridge?.autoReasoningEnabled),
      trade_mode:typeof bridge?.lastTradeMode === 'number' ? bridge.lastTradeMode : -1,
    })
  }
  return { connected, trade_applied:tradeApplied, trade_error:tradeError }
}

// Market status: bridge connected + tick time unchanged for 5 min → closed
// Returns 0=closed, 1=LONGONLY, 2=SHORTONLY, 3=CLOSEONLY, 4=FULL, -1=unknown
// Market tick thresholds
const MARKET_SAME_TICK_CLOSED_MS = 60_000
const MARKET_TICK_STALE_MS = 120_000

// Unified market state function
export function getOwnBridgeMarketState(userId, symbol = null) {
  const bridge = bridges.get(userId)
  if (!bridge || bridge.ws.readyState !== 1) {
    return {
      alive: false, isOpen: false, tradeMode: -1,
      reason: 'bridge_offline', lastTickMs: null, tickAgeMs: null, mt5TimeStr: null,
    }
  }

  const now = Date.now()
  const lastTickMs = bridge.lastTickMs || null
  const tickAgeMs = lastTickMs ? now - lastTickMs : null
  const tradeMode = typeof bridge.lastTradeMode === 'number' ? bridge.lastTradeMode : -1

  const explicit = symbol ? bridge.marketStates?.get(stripBrokerSuffix(symbol)) : bridge.marketState
  const explicitFresh = explicit && now - explicit.receivedAt <= 30_000
  if (explicitFresh) {
    return {
      alive: true, isOpen: explicit.state === 'open', tradeMode: explicit.tradeMode,
      reason: explicit.reason, detailReason: explicit.detailReason, marketState: explicit.state,
      symbol: explicit.symbol, symbolTradeMode: explicit.symbolTradeMode,
      terminalConnected: explicit.terminalConnected, tickProgressing: explicit.tickProgressing,
      tickUnchangedSeconds: explicit.tickUnchangedSeconds, tickAgeSeconds: explicit.tickAgeSeconds,
      lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null,
      source: 'bridge_market_state_v1',
    }
  }
  if (symbol && bridge.marketStates?.size > 0) {
    return {
      alive: true, isOpen: false, tradeMode: -1, reason: 'market_unknown',
      detailReason: explicit ? 'symbol_state_stale' : 'symbol_state_unavailable',
      marketState: 'unknown', symbol: stripBrokerSuffix(symbol), lastTickMs, tickAgeMs,
      mt5TimeStr: bridge.mt5TimeStr || null, source: 'bridge_market_state_v1',
    }
  }

  if (!lastTickMs) {
    return { alive: true, isOpen: false, tradeMode, reason: 'market_unknown_no_tick', lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null }
  }
  if (tickAgeMs > MARKET_TICK_STALE_MS) {
    return { alive: true, isOpen: false, tradeMode, reason: 'market_stale_tick', lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null }
  }
  if (tradeMode !== 4) {
    return { alive: true, isOpen: false, tradeMode, reason: tradeMode === 0 ? 'market_closed' : 'market_unknown', lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null }
  }
  return { alive: true, isOpen: true, tradeMode: 4, reason: 'market_open', lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null }
}

// Market status: bridge connected + tick time unchanged for 5 min → closed
// Returns 0=closed, 1=LONGONLY, 2=SHORTONLY, 3=CLOSEONLY, 4=FULL, -1=unknown
export async function getBridgeTradeMode(userId) {
  const bridge = bridges.get(userId)
  if (!bridge || bridge.ws.readyState !== 1) return -1
  // Use real-time trade mode detected from MT5 tick_time advancement
  if (typeof bridge.lastTradeMode === 'number') return bridge.lastTradeMode
  // No trade mode data yet → unknown
  return -1
}

// Get all connected bridges (for admin)
export function getAllBridges() {
  const result = []
  for (const [userId, bridge] of bridges) {
    result.push({
      userId,
      connected: bridge.ws.readyState === 1,
      alive: Date.now() - bridge.lastSeen < 20000,
      lastSeen: bridge.lastSeen,
    })
  }
  return result
}

export function getBridgeDiagnostics() {
  const now = Date.now()
  return Array.from(bridges.entries()).map(([userId, bridge]) => {
    const hb = bridge._clientHeartbeat || {}
    return {
      userId,
      readyState: bridge.ws?.readyState ?? -1,
      connected: bridge.ws?.readyState === 1,
      alive: !!(bridge.ws?.readyState === 1 && now - bridge.lastSeen < 20000),
      connectedSeconds: bridge._connectTime ? Math.round((now - bridge._connectTime) / 1000) : 0,
      lastSeenAgeSeconds: bridge.lastSeen ? Math.round((now - bridge.lastSeen) / 1000) : -1,
      lastPongAgeSeconds: bridge.lastPong ? Math.round((now - bridge.lastPong) / 1000) : -1,
      lastMessageType: bridge._lastMessageType || '?',
      generation: Number(bridge.generation || 0),
      tradeEnabled: !!bridge.tradeEnabled,
      autoReasoningEnabled: !!bridge.autoReasoningEnabled,
      lastTradeMode: typeof bridge.lastTradeMode === 'number' ? bridge.lastTradeMode : -1,
      mt5TimeStr: bridge.mt5TimeStr || null,
      lastTickAgeSeconds: bridge.lastTickMs ? Math.round((now - bridge.lastTickMs) / 1000) : -1,
      clientVersion: hb.client_version || null,
      mt5CollectTimeoutCount: hb.mt5_collect_timeout_count || 0,
      lastDataSentAgeSec: hb.last_data_sent_age_sec ?? -1,
      lastQuoteTime: hb.last_quote_time || null,
    }
  })
}

export function getBridgeGeneration(userId) {
  const bridge = bridges.get(Number(userId))
  return bridge && bridge.ws?.readyState === 1 ? Number(bridge.generation || 0) : null
}

export function getLatestBridgeMt5Clock() {
  let latest = null
  for (const [userId, bridge] of bridges.entries()) {
    const heartbeatQuoteTime = bridge._clientHeartbeat?.last_quote_time || null
    const time = bridge.mt5TimeStr || heartbeatQuoteTime
    const receivedAt = Number(bridge.lastTickMs || bridge._clientHeartbeat?.receivedAt || 0)
    if (!time || bridge.ws?.readyState !== 1) continue
    if (!latest || receivedAt > latest.received_at) {
      latest = {
        time:String(time),
        user_id:Number(userId),
        received_at:receivedAt || null,
        timezone_offset_minutes:bridge.timezoneOffsetMinutes ?? bridge._clientHeartbeat?.timezone_offset_minutes ?? null,
      }
    }
  }
  return latest
}

export { sendToBrowsers }
