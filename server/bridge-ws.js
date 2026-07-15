import { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'
import { queryOne, queryAll, queryRun, withTransaction, beijingNow, parseBeijing } from './db.js'
import { DEFAULT_API_BASE_URL, ADMIN_CACHE_TTL_MS } from './config.js'
import { getRedis, isRedisAvailable } from './redis.js'
import { autoSchedulerState } from './routes/ai/scheduler.js'
import { utcToMt5Time } from './routes/ai/utils.js'
import { DEFAULT_MAX_POSITION_SIZE, DEFAULT_SELECTED_TAKE_PROFIT, DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from './routes/ai/config.js'
import { weeklyRiskLockResult } from './jobs/weekly-risk-window.js'
import { localizeAuditRow } from './audit-localization.js'

import { JWT_SECRET } from './config.js'

// Per-user state
const bridges = new Map()       // userId -> { ws, lastSeen }
const browsers = new Map()      // userId -> Set<ws>
const pendingCommands = new Map() // commandId -> { resolve, timer, userId }
let adminUserId = null          // cached admin userId for fallback
let adminUserIdLastCheck = 0
const ADMIN_CACHE_TTL = ADMIN_CACHE_TTL_MS
const _bridgeInitGen = new Map() // userId -> generation number (防并发 init 污染状态)

let cmdCounter = 0
let wss = null

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

export function buildAdminGlobalAutoConfig(globalCfg) {
  return {
    api_provider: globalCfg?.api_provider || 'deepseek',
    model_name: globalCfg?.model_name || 'deepseek-chat',
    has_api_key: !!globalCfg?.api_key_encrypted,
    api_base_url: globalCfg?.api_base_url || DEFAULT_API_BASE_URL,
    temperature: globalCfg?.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: globalCfg?.max_tokens ?? DEFAULT_MAX_TOKENS,
    risk_level: globalCfg?.risk_level || 'medium',
    max_position_size: globalCfg?.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
    selected_take_profit: globalCfg?.selected_take_profit ?? DEFAULT_SELECTED_TAKE_PROFIT,
    thinking_enabled: Number(globalCfg?.thinking_enabled ?? 1) === 0 ? 0 : 1,
    reasoning_effort: globalCfg?.reasoning_effort || 'max',
  }
}
const _broadcastThrottle = new Map() // userId -> lastBroadcastTime (定期清理防内存泄漏)

// 每 10 分钟清理超过 30 秒未使用的广播节流条目
setInterval(() => {
  const cutoff = Date.now() - 30000
  for (const [uid, last] of _broadcastThrottle) {
    if (last < cutoff) _broadcastThrottle.delete(uid)
  }
}, 10 * 60 * 1000)

async function getAdminUserId() {
  const now = Date.now()
  if ((now - adminUserIdLastCheck) < ADMIN_CACHE_TTL) return adminUserId
  const row = await queryOne('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin'])
  adminUserId = row?.id || null
  adminUserIdLastCheck = now
  return adminUserId
}


export function initBridgeWS(server) {
  // Cache admin userId at startup
  getAdminUserId().catch(() => {})
  wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    const type = url.searchParams.get('type')
    const tokenPresent = !!url.searchParams.get('token')
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress

    if (req.url.startsWith('/aurum-api/bridge/ws')) {
      console.log(`[BridgeWS] upgrade path=/aurum-api/bridge/ws type=${type} tokenPresent=${tokenPresent} ip=${ip}`)
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

    if (type === 'browser') return handleBrowser(ws, url)
    if (type === 'bridge') return handleBridge(ws, url)
    ws.close(4000, 'Unknown type')
  })


  return wss
}

// ============ Browser Connection ============

function handleBrowser(ws, url) {
  const token = url.searchParams.get('token')
  let userId = null
  try { userId = jwt.verify(token, JWT_SECRET).userId } catch (e) { console.error('[BridgeWS] Browser JWT verify failed:', e.message) }
  if (!userId) { ws.close(4002, 'Invalid token'); return }

  // Register
  if (!browsers.has(userId)) browsers.set(userId, new Set())
  browsers.get(userId).add(ws)

  // Handle messages from browser
  ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data) } catch { return }

    if (msg.type === 'hb') {
      // Heartbeat — reply with MT5 connection status (fall back to admin bridge)
      let bridge = bridges.get(userId)
      let usingFallback = false
      if (!bridge || bridge.ws.readyState !== 1) {
        if (adminUserId) {
          bridge = bridges.get(adminUserId)
          usingFallback = true
        }
      }
      const connected = !!(bridge && bridge.ws.readyState === 1)
      const alive = connected && (Date.now() - bridge.lastSeen < 20000)
      // Include switch states from user's own bridge (not meaningful from admin fallback)
      const ownBridge = bridges.get(userId)
      const tradeEnabled = ownBridge && ownBridge.ws.readyState === 1 ? !!ownBridge.tradeEnabled : undefined
      const autoReasoningEnabled = ownBridge && ownBridge.ws.readyState === 1 ? !!ownBridge.autoReasoningEnabled : undefined
      ws.send(JSON.stringify({
        type: 'hb',
        seq: msg.seq,
        mt5_connected: connected,
        mt5_alive: alive,
        using_fallback: usingFallback,
        trade_enabled: tradeEnabled,
        auto_reasoning_enabled: autoReasoningEnabled,
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

function handleBridge(ws, url) {
  const token = url.searchParams.get('token')
  let userId = null
  try { userId = jwt.verify(token, JWT_SECRET).userId } catch (e) { console.error('[BridgeWS] bridge auth failed:', e.message) }
  if (!userId) { console.log('[BridgeWS] bridge auth failed: no valid userId'); ws.close(4002, 'Invalid token'); return }

  // 在计划检查完成之前先缓存消息，防止竞态条件（消息先于 _initBridge 到达）
  const msgQueue = []
  const queueMsg = (data) => msgQueue.push(data)
  ws.on('message', queueMsg)

  // Check user plan — only Pro allowed (async, blocks bridge setup)
  queryOne(`SELECT plan, plan_expires_at, role,
    (role = 'admin' OR (plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW()))) AS has_pro_access
    FROM users WHERE id = ?`, [userId]).then(async user => {
    ws.off('message', queueMsg) // 移除缓存监听器
    if (!user) { ws.close(4002, 'User not found'); return }
    if (!user.has_pro_access) {
      const now = new Date()
      const expired = user.plan_expires_at && new Date(user.plan_expires_at) < now
      const reason = expired ? '会员已过期，请续费后重试' : `当前会员等级(${user.plan})不可使用桥接，请升级Pro会员`
      console.log(`[BridgeWS] User ${userId} rejected: ${reason}`)
      ws.close(4003, reason)
      return
    }
    await _initBridge(ws, userId, user)
    // 重放缓存消息
    for (const msg of msgQueue) ws.emit('message', msg)
  }).catch(err => {
    ws.off('message', queueMsg)
    console.error('[BridgeWS] Plan check error:', err)
    ws.close(4002, 'Server error')
  })
}

async function _initBridge(ws, userId, user) {
  // Generation counter — prevents stale async init from corrupting a newer bridge's state
  const gen = (_bridgeInitGen.get(userId) || 0) + 1
  _bridgeInitGen.set(userId, gen)

  // Close old bridge connection if still open (one bridge per account)
  const existing = bridges.get(userId)
  if (existing) {
    if (existing._pingInterval) clearInterval(existing._pingInterval)
    if (existing.ws && existing.ws.readyState === 1) {
      try { existing.ws.close(4001, 'Replaced by new connection') } catch {}
    }
  }

  let initComplete = false

  // Register close + error handlers BEFORE any await (so close during init is caught)
  ws.on('close', async (code, reason) => {
    const reasonStr = reason?.toString() || ''
    if (!initComplete) {
      console.log(`[BridgeWS] close during init user=${userId} code=${code} reason=${reasonStr}`)
      const current = bridges.get(userId)
      if (current && current.ws === ws) {
        if (current._pingInterval) clearInterval(current._pingInterval)
        bridges.delete(userId)
      }
      sendToBrowsers(userId, { type: 'disconnect', reason: 'bridge_closed' })
      return
    }
    const bridge = bridges.get(userId)
    if (bridge) {
      if (bridge._pingInterval) clearInterval(bridge._pingInterval)
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
  let dbAutoReasoningEnabled = false
  let hasDbRow = false
  try {
    const row = await queryOne('SELECT trade_send_enabled, auto_reasoning_enabled FROM user_bridge_settings WHERE user_id = ?', [userId])
    if (_bridgeInitGen.get(userId) !== gen) { console.log(`[BridgeWS] Stale init for user ${userId}, aborting`); return }
    if (row) {
      hasDbRow = true
      dbTradeEnabled = !!row.trade_send_enabled
      dbAutoReasoningEnabled = !!row.auto_reasoning_enabled
    }
  } catch (e) {
    console.error(`[BridgeWS] Failed to read user_bridge_settings for user ${userId}:`, e.message)
  }
  // Read auto_scheduler.enabled as the source of truth (must match auto_status endpoint)
  let schedulerAutoEnabled = false
  try {
    const schedRow = await queryOne('SELECT enabled FROM auto_scheduler WHERE user_id = ?', [userId])
    if (_bridgeInitGen.get(userId) !== gen) return
    schedulerAutoEnabled = !!(schedRow?.enabled)
  } catch (e) { console.error('[BridgeWS] Failed to read auto_scheduler:', e.message) }

  // Admin defaults to tradeEnabled=true if no DB record exists, but respects explicit DB value of 0
  // Non-admin: use DB value as-is (defaults to false when no row)
  const isAdmin = userId === (adminUserId || -1)
  const defaultTrade = isAdmin ? (hasDbRow ? dbTradeEnabled : true) : dbTradeEnabled
  const replacedOld = !!existing
  const bridgeEntry = { ws, lastSeen: Date.now(), tradeEnabled: defaultTrade, autoReasoningEnabled: schedulerAutoEnabled, lastPong: Date.now(), lastTradeMode: -1, _pingInterval: null, _connectTime: Date.now() }
  bridges.set(userId, bridgeEntry)
  ws._userId = userId
  console.log(`[BridgeWS] bridge connected user=${userId} role=${user?.role || 'unknown'} plan=${user?.plan || 'unknown'} replacedOld=${replacedOld}`)
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
  console.log(`[BridgeWS] _initBridge user ${userId}: autoScheduler=${schedulerAutoEnabled} hasDbRow=${hasDbRow}`)
  if (schedulerAutoEnabled) {
    try {
      const ai = await import('./routes/ai/index.js')
      if (_bridgeInitGen.get(userId) !== gen) return
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

  ws.on('message', (data) => {
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
        receivedAt: Date.now(),
      }
    }

    if (msg.type === 'data') {
      if (bridge && msg.quote && typeof msg.quote.time === 'string') {
        const now = Date.now()
        bridge.lastTickMs = now
        const prev = bridge.mt5TimeStr
        bridge.mt5TimeStr = msg.quote.time
        if (prev !== undefined) {
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
        if (pending) {
          clearTimeout(pending.timer)
          pendingCommands.delete(msg.command_id)
          pending.resolve(msg.result)
        }
      }
    }
  })

  initComplete = true
}

// ============ Helpers ============

function sendToBrowsers(userId, data) {
  // Admin market status override: if admin is closed, force all users to closed
  const adminBridge = adminUserId ? bridges.get(adminUserId) : null
  const adminTradeMode = adminBridge ? adminBridge.lastTradeMode : -1
  const adminIsClosed = adminTradeMode === 0

  const set = browsers.get(userId)
  if (set) {
    // Override trade_mode for non-admin users when admin is closed
    const shouldOverride = adminIsClosed && userId !== adminUserId && data.type === 'data' && data.trade_mode !== 0
    const finalData = shouldOverride ? { ...data, trade_mode: 0, _admin_override: true } : data
    const json = JSON.stringify(finalData)
    for (const ws of set) {
      if (ws.readyState === 1) {
        try { ws.send(json) } catch {}
      } else {
        set.delete(ws)
      }
    }
  }
  // If this is admin's bridge data, also forward to users without their own bridge
  // Throttle: max 4 broadcasts per second per user to prevent flooding browsers
  if (userId === adminUserId && data.type === 'data' && browsers.size > 0) {
    const adminJson = JSON.stringify({ ...data, _source: 'admin_fallback' })
    const now = Date.now()
    for (const [uid, browserSet] of browsers) {
      if (uid === adminUserId) continue
      if (bridges.has(uid)) continue // user has their own bridge
      const last = _broadcastThrottle.get(uid) || 0
      if (now - last < 250) continue // skip if < 250ms since last broadcast
      _broadcastThrottle.set(uid, now)
      for (const ws of browserSet) {
        if (ws.readyState === 1) {
          try { ws.send(adminJson) } catch (e) { console.error('[BridgeWS] admin broadcast send failed:', uid, e.message) }
        } else {
          browserSet.delete(ws)
        }
      }
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
    const user = await queryOne(`SELECT plan, role,
      (role = 'admin' OR (plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW()))) AS has_pro_access
      FROM users WHERE id = ?`, [userId])
    const isPro = !!user?.has_pro_access
    const hasAccess = isPro || user?.plan === 'plus'
    if (!hasAccess) return reply({ status: 'error', message: '需要Pro会员' })

    // Plus users: read-only, block write operations + analyze (API cost)
    const writeActions = ['open', 'close', 'toggle_trade', 'execute', 'save_config', 'save_user_auto_config', 'toggle_auto', 'admin_save_auto_global_config', 'admin_save_auto_prompt_type', 'admin_disable_auto_prompt_type', 'set_quote_symbol', 'save_close_config', 'run_close_now']
    if (!isPro && writeActions.includes(action)) {
      return reply({ status: 'error', message: '升级会员即可解锁交易功能' })
    }
    // Plus users also blocked from analyze (consumes AI API credits)
    if (!isPro && action === 'analyze') {
      return reply({ status: 'error', message: '升级会员即可使用 AI 推理' })
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
        let bridge = bridges.get(userId)
        let usingFallback = false
        if (!bridge || bridge.ws.readyState !== 1) {
          const adminId = await getAdminUserId()
          if (adminId) { bridge = bridges.get(adminId); usingFallback = true }
        }
        const connected = !!(bridge && bridge.ws.readyState === 1)
        const alive = connected && (Date.now() - bridge.lastSeen < 20000)
        const tradeEnabled = bridge ? (usingFallback ? (bridge.tradeEnabled !== false) : (alive && (bridge.tradeEnabled !== false))) : false
        result = {
          status: 'success',
          gateway: {
            mode: alive ? 'live' : 'mock',
            mt5_package_available: true,
            live_trading_enabled: tradeEnabled,
            using_fallback: usingFallback,
            trade_mode: await getBridgeTradeMode(userId),
          },
        }
        break
      }
      case 'account': {
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        if (hasOwnBridge) {
          result = await ai.mt5Bridge(userId, 'account', {})
        } else if (adminUserId && bridges.get(adminUserId)?.ws?.readyState === 1) {
          result = await ai.mt5Bridge(adminUserId, 'account', {})
        } else {
          result = { status: 'error', message: 'MT5桥接未连接' }
        }
        break
      }
      case 'symbols':
        result = await ai.mt5Bridge(userId, 'symbols', {})
        break
      case 'quote': {
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        if (hasOwnBridge) {
          result = await ai.mt5Bridge(userId, 'quote', { symbol: params.symbol })
        } else if (adminUserId && bridges.get(adminUserId)?.ws?.readyState === 1) {
          result = await ai.mt5Bridge(adminUserId, 'quote', { symbol: params.symbol })
        } else {
          result = { status: 'error', message: 'MT5桥接未连接' }
        }
        break
      }
      case 'positions': {
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        if (hasOwnBridge) {
          result = await ai.mt5Bridge(userId, 'positions', {})
        } else if (adminUserId && bridges.get(adminUserId)?.ws?.readyState === 1) {
          result = await ai.mt5Bridge(adminUserId, 'positions', {})
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
        const manualConfig = await ai.getActiveConfig(null, userId, params.session_id || 'default') || {}
        result = await ai.executeOrderCore(userId, {
          ...manualConfig,
          max_position_size: manualConfig.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
        }, params, 'manual_open', { sourceType: 'manual' })
        break
      }
      case 'close': {
        const clBridge = bridges.get(userId)
        if (!clBridge || clBridge.ws?.readyState !== 1 || clBridge.tradeEnabled === false) {
          result = { status: 'rejected', message: !clBridge || clBridge.ws?.readyState !== 1 ? 'MT5 桥接未连接' : '交易发送已关闭，请先开启', details: {} }
          await ai.insertAudit(null, userId, 'manual_close', null, params, result, 'rejected')
          break
        }
        result = await ai.mt5Bridge(userId, 'close', params)
        await ai.insertAudit(null, userId, 'manual_close', null, params, result, result?.status || 'unknown')
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
          await queryRun('UPDATE ai_configs SET session_id = session_id WHERE user_id = ?', [userId]) // touch config
          // Store in system_config for this user
          const key = `quote_symbol_${userId}`
          const existing = await queryOne('SELECT id FROM system_config WHERE `key` = ?', [key])
          if (existing) await queryRun('UPDATE system_config SET `value` = ? WHERE `key` = ?', [symbol, key])
          else await queryRun('INSERT INTO system_config (category, `key`, `value`) VALUES (?, ?, ?)', ['quote_symbol', key, symbol])
        }
        break
      }
      case 'history': {
        let bridgeOk = bridges.get(userId)?.ws?.readyState === 1
        let historyUserId = userId
        if (!bridgeOk && adminUserId && bridges.get(adminUserId)?.ws?.readyState === 1) {
          bridgeOk = true
          historyUserId = adminUserId
        }
        if (bridgeOk) {
          // 直接透传前端参数给桥接软件（含分页、过滤）
          const bridgeParams = {
            page: params.page || 1,
            page_size: params.page_size || 20,
            direction: params.direction || '',
            profit_filter: params.profit_filter || ''
          }
          if (params.close_from) bridgeParams.date_from = params.close_from
          if (params.close_to) bridgeParams.date_to = params.close_to

          result = await ai.mt5Bridge(historyUserId, 'history', bridgeParams)
          if (result?.status !== 'success') {
            result = { status: 'success', orders: [], statistics: { total_profit: 0, credit: 0, deposit: 0, withdrawal: 0, net_result: 0 }, pagination: { current_page: 1, page_size: 20, total_count: 0, total_pages: 1 } }
          }
        } else {
          result = { status: 'success', orders: [], statistics: { total_profit: 0, credit: 0, deposit: 0, withdrawal: 0, net_result: 0 }, pagination: { current_page: 1, page_size: 20, total_count: 0, total_pages: 1 } }
        }
        break
      }
      case 'history_chart_data': {
        let bridgeOk = bridges.get(userId)?.ws?.readyState === 1
        let hcUserId = userId
        if (!bridgeOk && adminUserId && bridges.get(adminUserId)?.ws?.readyState === 1) {
          bridgeOk = true
          hcUserId = adminUserId
        }
        if (bridgeOk) {
          // 直接调用桥接的 chart_data 命令，返回聚合后的图表数据
          const chartParams = {}
          if (params.close_from) chartParams.date_from = params.close_from
          if (params.close_to) chartParams.date_to = params.close_to
          if (params.direction) chartParams.direction = params.direction
          if (params.profit_filter) chartParams.profit_filter = params.profit_filter
          result = await ai.mt5Bridge(hcUserId, 'chart_data', chartParams)
          if (result?.status !== 'success') {
            result = { status: 'success', daily: [], cumulative: [], drawdown: [], stats: { total_trades: 0, win_rate: 0, profit_factor: 0, max_drawdown: 0, gross_profit: 0, gross_loss: 0 } }
          }
        } else {
          result = { status: 'success', daily: [], cumulative: [], drawdown: [], stats: { total_trades: 0, win_rate: 0, profit_factor: 0, max_drawdown: 0, gross_profit: 0, gross_loss: 0 } }
        }
        break
      }
      case 'rates':
        result = await ai.mt5Bridge(userId, 'rates', { symbol: params.symbol, timeframe: params.timeframe || 'M30', count: params.count || 100 })
        break
      case 'diagnostics':
        result = await ai.mt5Bridge(userId, 'diagnostics', {})
        break
      case 'analyze':
        result = await ai.handleAnalyze(userId, params)
        break
      case 'ai_config': {
        const configUser = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        const isConfigAdmin = configUser?.role === 'admin'
        const adminPromptRow = await queryOne(
          "SELECT system_prompt FROM ai_configs WHERE is_active = 1 AND user_id IN (SELECT id FROM users WHERE role = 'admin') ORDER BY updated_at DESC LIMIT 1"
        )
        const defaultPrompt = adminPromptRow?.system_prompt || ''
        // Keep model credentials user-scoped; only the administrator's manual
        // prompt is exposed as the inheritable default.
        const row = await ai.getActiveConfig(null, userId, params.session_id || 'default', null, { skipFallbacks: true })
        const cfg = ai.configPublic(row)
        if (cfg && !isConfigAdmin && !cfg.system_prompt) {
          cfg.system_prompt = defaultPrompt
          cfg._system_prompt_inherited = true
        }
        // If user has no own API key but admin has model_sharing, attach sharing indicator
        if (!cfg || !cfg.has_api_key) {
          const sharedRow = await queryOne(
            "SELECT api_provider, model_name FROM ai_configs WHERE model_sharing_enabled = 1 AND is_active = 1 AND user_id IN (SELECT id FROM users WHERE role = 'admin') LIMIT 1"
          )
          if (sharedRow) {
            // Read user's auto_scheduler for enable_auto_trade default
            const userScheduler = await queryOne('SELECT enable_auto_trade, selected_take_profit, max_position_size, risk_level FROM auto_scheduler WHERE user_id = ?', [userId])
            if (cfg) {
              cfg._model_shared = true
            }
            result = {
              status: 'success',
              default_prompt: defaultPrompt,
              config: cfg || {
                _model_shared: true,
                _system_prompt_inherited: !isConfigAdmin,
                system_prompt: defaultPrompt,
                api_provider: sharedRow.api_provider,
                model_name: sharedRow.model_name,
                enable_auto_trade: userScheduler ? !!userScheduler.enable_auto_trade : true,
                max_position_size: userScheduler?.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
                selected_take_profit: userScheduler?.selected_take_profit ?? DEFAULT_SELECTED_TAKE_PROFIT,
                risk_level: userScheduler?.risk_level || 'medium',
              }
            }
            break
          }
        }
        result = { status: 'success', config: cfg, default_prompt: defaultPrompt }
        break
      }
      case 'save_config': {
        const cfg = params.config
        if (!cfg) return reply({ status: 'error', message: 'config required' })
        const hasSystemPrompt = Object.prototype.hasOwnProperty.call(cfg, 'system_prompt')
        const now = beijingNow()
        const sid = params.session_id || 'default'
        await withTransaction(async (run) => {
          await run('UPDATE ai_configs SET is_active = 0 WHERE user_id = ? AND session_id = ?', [userId, sid])
          await run(`INSERT INTO ai_configs(user_id, session_id, api_provider, api_key_encrypted, api_base_url, model_name,
            temperature, max_tokens, enable_auto_trade, enable_futures_trading, risk_level,
            max_position_size, selected_take_profit, model_sharing_enabled, system_prompt, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON DUPLICATE KEY UPDATE
              api_key_encrypted = CASE WHEN VALUES(api_key_encrypted) IS NOT NULL THEN VALUES(api_key_encrypted) ELSE ai_configs.api_key_encrypted END,
              api_base_url = VALUES(api_base_url), model_name = VALUES(model_name), temperature = VALUES(temperature),
              max_tokens = VALUES(max_tokens), enable_auto_trade = VALUES(enable_auto_trade),
              enable_futures_trading = VALUES(enable_futures_trading), risk_level = VALUES(risk_level),
              max_position_size = VALUES(max_position_size), selected_take_profit = VALUES(selected_take_profit),
              model_sharing_enabled = VALUES(model_sharing_enabled),
              system_prompt = CASE WHEN ? = 1 THEN VALUES(system_prompt) ELSE ai_configs.system_prompt END,
              is_active = 1, updated_at = VALUES(updated_at)`,
            [userId, sid, cfg.api_provider || 'deepseek', cfg.api_key || null,
              cfg.api_base_url || null, cfg.model_name || 'deepseek-chat', cfg.temperature ?? DEFAULT_TEMPERATURE, cfg.max_tokens || DEFAULT_MAX_TOKENS,
              cfg.enable_auto_trade ? 1 : 0, cfg.enable_futures_trading ? 1 : 0, cfg.risk_level || 'medium',
              cfg.max_position_size || DEFAULT_MAX_POSITION_SIZE, cfg.selected_take_profit || DEFAULT_SELECTED_TAKE_PROFIT, cfg.model_sharing_enabled ? 1 : 0,
              cfg.system_prompt || null, now, now, hasSystemPrompt ? 1 : 0])
        })
        const row = await ai.getActiveConfig(null, userId, params.session_id || 'default', cfg.api_provider)
        result = { status: 'success', config: ai.configPublic(row) }
        break
      }
      case 'signals_latest_id': {
        const sessionFilter = params.session_id ? 'AND session_id = ?' : ''
        const sessionParam = params.session_id ? [params.session_id] : []

        // 观摩模式：用 admin 的信号
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        const adminId = await getAdminUserId()
        const queryUserId = hasOwnBridge ? userId : (adminId || userId)

        // Old user signals
        const oldRow = await queryOne(
          `SELECT id, signal_type, is_executed, created_at, ttl_seconds, timeframe, 'manual' as signal_source FROM ai_signals WHERE user_id = ? ${sessionFilter} ORDER BY created_at DESC, id DESC LIMIT 1`,
          [queryUserId, ...sessionParam]
        )

        // Shared delivery signals
        const delivSessionFilter = params.session_id ? 'AND s.session_id = ?' : ''
        const delivRow = await queryOne(
          `SELECT s.id, s.signal_type, d.is_executed, s.created_at, s.ttl_seconds, s.timeframe, 'auto_shared' as signal_source, d.execution_status
           FROM auto_signal_deliveries d
           JOIN ai_signals s ON s.id = d.signal_id
           WHERE d.user_id = ? ${delivSessionFilter} ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
          [queryUserId, ...sessionParam]
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
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        const adminId = await getAdminUserId()
        const detailUserId = hasOwnBridge ? userId : (adminId || userId)

        // Check if user has a delivery for this signal
        const delivery = await queryOne(
          'SELECT * FROM auto_signal_deliveries WHERE signal_id = ? AND (user_id = ? OR user_id = ?)',
          [signalId, userId, detailUserId]
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
            item.execution_result = delivery.execution_result
            item.execution_status = delivery.execution_status
            item.delivery_id = delivery.id
            item.prompt_type_id = delivery.prompt_type_id
            item.source = 'auto_shared'
            ai.attachSignalTiming(item)
            result = { status: 'success', signal: item }
          } else {
            result = { status: 'error', message: 'signal not found' }
          }
          break
        }

        // Fallback: old signal check
        const row = await queryOne('SELECT * FROM ai_signals WHERE id = ? AND (user_id = ? OR user_id = 0)', [signalId, detailUserId])
        if (row) {
          const item = { ...row }
          try { item.market_data = JSON.parse(item.market_data_json) } catch { item.market_data = {} }
          delete item.market_data_json
          item.is_executed = !!item.is_executed
          ai.attachSignalTiming(item)
          result = { status: 'success', signal: item }
        } else {
          result = { status: 'error', message: 'signal not found' }
        }
        break
      }
      case 'signals': {
        const offset = Number(params.offset) || 0
        const limit = Math.min(Number(params.limit) || 6, 100)
        // 观摩模式：始终用 admin 的信号
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        const adminId = await getAdminUserId()
        const queryUserId = hasOwnBridge ? userId : (adminId || userId)

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
        // Lightweight subquery for COUNT (no TEXT columns)
        const countColsOld = 's.id'
        const countColsDeliv = 's.id'
        const countOldSub = `(SELECT ${countColsOld} FROM ai_signals s WHERE s.user_id = ? AND (s.source = 'manual' OR s.source IS NULL)${oldSessionFilter}${sharedWhere.length > 0 ? ' AND ' + sharedConditions.join(' AND ') : ''})`
        const countDelivSub = `(SELECT ${countColsDeliv} FROM auto_signal_deliveries d JOIN ai_signals s ON s.id = d.signal_id WHERE d.user_id = ?${sharedWhere.length > 0 ? ' AND ' + sharedConditions.map(c => 's.' + c).join(' AND ') : ''})`
        // Full subquery for data (exclude market_data_json TEXT for performance)
        const selectCols = 'id, user_id, config_id, prompt_type_id, session_id, source, symbol, timeframe, signal_type, confidence, recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price, ai_model, ttl_seconds, is_executed, executed_at, trade_ticket, execution_result, created_at, delivery_id, execution_status, entry_method, limit_price, stop_limit_price, pending_valid_until, pending_ticket, order_state'
        const selectColsOld = 's.id, s.user_id, s.config_id, s.prompt_type_id, s.session_id, s.source, s.symbol, s.timeframe, s.signal_type, s.confidence, s.recommended_volume, s.analysis, s.reasoning, s.stop_loss_price, s.take_profit_1_price, s.take_profit_2_price, s.take_profit_3_price, s.ai_model, s.ttl_seconds, s.is_executed, s.executed_at, s.trade_ticket, s.execution_result, s.created_at, NULL as delivery_id, NULL as execution_status, s.entry_method, s.limit_price, s.stop_limit_price, s.pending_valid_until, s.pending_ticket, s.order_state'
        const selectColsDeliv = 's.id, d.user_id, s.config_id, d.prompt_type_id, s.session_id, s.source, s.symbol, s.timeframe, s.signal_type, s.confidence, s.recommended_volume, s.analysis, s.reasoning, s.stop_loss_price, s.take_profit_1_price, s.take_profit_2_price, s.take_profit_3_price, s.ai_model, s.ttl_seconds, d.is_executed, d.executed_at, d.trade_ticket, d.execution_result, s.created_at, d.id as delivery_id, d.execution_status, s.entry_method, s.limit_price, s.stop_limit_price, s.pending_valid_until, d.pending_ticket, s.order_state'
        const dataOldSub = `(SELECT ${selectColsOld} FROM ai_signals s WHERE s.user_id = ? AND (s.source = 'manual' OR s.source IS NULL)${oldSessionFilter}${sharedWhere.length > 0 ? ' AND ' + sharedConditions.join(' AND ') : ''})`
        const dataDelivSub = `(SELECT ${selectColsDeliv} FROM auto_signal_deliveries d JOIN ai_signals s ON s.id = d.signal_id WHERE d.user_id = ?${sharedWhere.length > 0 ? ' AND ' + sharedConditions.map(c => 's.' + c).join(' AND ') : ''})`
        const oldParams = [queryUserId, ...oldSessionParam, ...sharedParams]

        // Shared signals subquery (delivery overrides user-level execution state)
        const delivParams = [queryUserId, ...sharedParams]

        // COUNT uses lightweight subquery (no TEXT); data uses full subquery (no market_data_json)
        const countSql = `SELECT COUNT(*) as total FROM (${countOldSub} UNION ALL ${countDelivSub}) t`
        const dataSql = `SELECT ${selectCols} FROM (${dataOldSub} UNION ALL ${dataDelivSub}) t ORDER BY t.id DESC, t.created_at DESC LIMIT ? OFFSET ?`
        const [countRow, allRows] = await Promise.all([
          queryOne(countSql, [...oldParams, ...delivParams]),
          queryAll(dataSql, [...oldParams, ...delivParams, limit + 1, offset])
        ])
        const totalCount = countRow?.total || 0
        const hasMore = allRows.length > limit
        const sliced = allRows.slice(0, limit)

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
          ai.attachSignalTiming(item)
          return item
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
              await queryRun('UPDATE ai_signals SET pending_ticket = ?, pending_state = ?, pending_valid_until = ? WHERE id = ?',
                [String(orderTicket), 'pending', signal.pending_valid_until || null, signal.id])
            } else {
              await queryRun('UPDATE ai_signals SET is_executed = 1, executed_at = ?, trade_ticket = ? WHERE id = ?', [beijingNow(), orderTicket, signal.id])
            }
          }
        } else {
          // Update delivery status on failure
          if (signalSource === 'auto_shared' && delivery) {
            const status = result.status === 'rejected' ? 'rejected' : result.status === 'uncertain' ? 'uncertain' : 'failed'
            await queryRun(
              'UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE id = ?',
              [status, JSON.stringify(result), delivery.id])
          }
        }
        break
      }
      case 'auto_status': {
        // 观摩模式：用 admin 的自动推理状态
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        const adminId = await getAdminUserId()
        const autoQueryUserId = hasOwnBridge ? userId : (adminId || userId)
        const runtimeStatus = await ai.getUserAutoRuntimeStatus(autoQueryUserId)
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

        if (newEnabled) {
          // Ensure user has a prompt_type_id and selected_symbols
          const pt = await ai.getAutoPromptTypes()
          if (!pt || pt.length === 0) {
            result = { status: 'error', message: '暂无可用策略，请联系管理员' }
            break
          }
          const userCfg = cfg || {}
          if (!userCfg.prompt_type_id) {
            const firstPt = pt[0]
            let symbols = []
            try { symbols = JSON.parse(firstPt.symbols_json || '[]') } catch (e) { console.warn('[BridgeWS] Failed to parse prompt type symbols_json:', e.message) }
            await ai.saveUserAutoConfig(userId, { prompt_type_id: firstPt.id, selected_symbols: symbols })
          } else if (userCfg.selected_symbols_json == null) {
            const ptRow = await ai.getAutoPromptTypeById(userCfg.prompt_type_id)
            if (ptRow) {
              let symbols = []
              try { symbols = JSON.parse(ptRow.symbols_json || '[]') } catch (e) { console.warn('[BridgeWS] Failed to parse prompt type symbols_json:', e.message) }
              await ai.saveUserAutoConfig(userId, { prompt_type_id: userCfg.prompt_type_id, selected_symbols: symbols })
            }
          } else if (!userCfg.selected_symbols || userCfg.selected_symbols.length === 0) {
            result = { status: 'error', message: '请先在自动推理配置中至少选择一个品种' }
            break
          }
        }

        // Unified UPSERT for enabled state — preserve existing prompt_type_id
        await queryRun(
          `INSERT INTO auto_scheduler (user_id, enabled, prompt_type_id, created_at, updated_at)
           VALUES (?, ?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE enabled = ?, updated_at = NOW()`,
          [userId, newEnabled ? 1 : 0, cfg?.prompt_type_id || null, newEnabled ? 1 : 0]
        )

        // Sync user_bridge_settings
        try {
          await queryRun(
            'INSERT INTO user_bridge_settings (user_id, auto_reasoning_enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE auto_reasoning_enabled = ?, updated_at = NOW()',
            [userId, newEnabled ? 1 : 0, newEnabled ? 1 : 0]
          )
        } catch (e) { console.error('[BridgeWS] Failed to persist auto_reasoning_enabled:', e.message) }
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
      case 'get_default_prompt': {
        // Get admin's system prompt as default template
        const adminRow = await queryOne('SELECT system_prompt FROM ai_configs WHERE user_id = (SELECT id FROM users WHERE role = ? LIMIT 1) AND is_active = 1', ['admin'])
        result = { status: 'success', prompt: adminRow?.system_prompt || '' }
        break
      }
      case 'get_auto_config': {
        const user = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        const isAdmin = user?.role === 'admin'
        const userAuto = await ai.getUserAutoConfig(userId)
        const running = ai.isAutoSchedulerRunning(userId)

        const config = {
          enabled: !!userAuto.scheduler?.enabled,
          prompt_type_id: userAuto.scheduler?.prompt_type_id || null,
          risk_level: userAuto.scheduler?.risk_level || 'medium',
          max_position_size: userAuto.scheduler?.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
          selected_take_profit: userAuto.scheduler?.selected_take_profit ?? 2,
          enable_auto_trade: !!userAuto.scheduler?.enable_auto_trade,
          selected_symbols: userAuto.scheduler?.selected_symbols || [],
          running,
          paused_reason: userAuto.pausedReason || '',
        }

        const promptTypes = await ai.getAutoPromptTypes({ includeInactive: isAdmin })

        if (isAdmin) {
          const globalCfg = await ai.getGlobalAutoConfig()
          const { autoSchedulerState } = await import('./routes/ai/scheduler.js')
          const schedulerStates = Object.values(autoSchedulerState).map(s => ({
            key: s.key, promptTypeId: s.promptTypeId, symbol: s.symbol,
            running: s.running, subscriberCount: s.subscriberCount, lastError: s.lastError,
          }))
          result = {
            status: 'success',
            config,
            prompt_types: promptTypes.map(pt => ({
              id: pt.id, title: pt.title, description: pt.description,
              system_prompt: pt.system_prompt, symbols: JSON.parse(pt.symbols_json || '[]'),
              interval_minutes: pt.interval_minutes, is_active: !!pt.is_active, sort_order: pt.sort_order,
            })),
            admin: {
              global_config: buildAdminGlobalAutoConfig(globalCfg),
              scheduler_states: schedulerStates,
            },
          }
        } else {
          result = {
            status: 'success',
            config,
            prompt_types: promptTypes.map(pt => ({
              id: pt.id, title: pt.title, description: pt.description,
              symbols: JSON.parse(pt.symbols_json || '[]'),
              interval_minutes: pt.interval_minutes,
              is_active: !!pt.is_active,
            })),
          }
        }
        break
      }
      case 'save_user_auto_config': {
        try {
          await ai.saveUserAutoConfig(userId, params)
          // Sync Redis only if enabled AND bridge is online
          const savedCfg = await ai.getAutoConfig(null, userId)
          const bridgeOnline = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
          if (savedCfg?.enabled && bridgeOnline) {
            await ai.syncUserRedisSubscription(userId, savedCfg.prompt_type_id, savedCfg.selected_symbols || [], true)
          } else if (!savedCfg?.enabled) {
            await ai.syncUserRedisSubscription(userId, null, [], false)
          }
          await ai.reconcileAutoSchedulers()
          result = { status: 'success', message: '配置已保存' }
        } catch (e) {
          console.error('[BridgeWS] save_auto_config error:', e.message)
          result = { status: 'error', message: '保存配置失败，请重试' }
        }
        break
      }
      case 'admin_save_auto_global_config': {
        const user2 = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (user2?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }
        const existing = await ai.getGlobalAutoConfig()
        const newCfg = {
          interval_minutes: existing?.interval_minutes || 5,
          api_provider: params.api_provider ?? existing?.api_provider ?? 'deepseek',
          model_name: params.model_name ?? existing?.model_name ?? 'deepseek-chat',
          api_key_encrypted: params.api_key || existing?.api_key_encrypted || null,
          api_base_url: params.api_base_url ?? existing?.api_base_url ?? DEFAULT_API_BASE_URL,
          temperature: params.temperature ?? existing?.temperature ?? DEFAULT_TEMPERATURE,
          max_tokens: params.max_tokens ?? existing?.max_tokens ?? DEFAULT_MAX_TOKENS,
          risk_level: params.risk_level ?? existing?.risk_level ?? 'medium',
          max_position_size: params.max_position_size ?? existing?.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
          selected_take_profit: params.selected_take_profit ?? existing?.selected_take_profit ?? 2,
          enable_auto_trade: params.enable_auto_trade ?? existing?.enable_auto_trade ?? 0,
          thinking_enabled: params.thinking_enabled ?? existing?.thinking_enabled ?? 1,
          reasoning_effort: params.reasoning_effort ?? existing?.reasoning_effort ?? 'max',
        }
        await ai.saveGlobalAutoConfig(newCfg)
        await ai.reconcileAutoSchedulers()
        result = { status: 'success', message: '全局配置已保存' }
        break
      }
      case 'admin_save_auto_prompt_type': {
        const user3 = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (user3?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }
        try {
          const saved = await ai.saveAutoPromptType(userId, params)
          await ai.reconcileAutoSchedulers()
          result = { status: 'success', prompt_type: saved }
        } catch (e) {
          console.error('[BridgeWS] save_auto_prompt_type error:', e.message)
          result = { status: 'error', message: '保存策略失败，请重试' }
        }
        break
      }
      case 'admin_disable_auto_prompt_type': {
        const user4 = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (user4?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }
        if (!params.id) { result = { status: 'error', message: 'id required' }; break }
        await ai.disableAutoPromptType(userId, params.id)
        await ai.reconcileAutoSchedulers()
        result = { status: 'success', message: '策略已禁用' }
        break
      }
      case 'save_auto': {
        // Legacy: save per-user auto scheduler settings
        const { symbol = 'XAUUSD' } = params
        const symbols = [symbol]
        const enabled = !!params.enabled
        await ai.upsertAutoConfig(null, userId, symbols, enabled)
        await ai.stopAutoScheduler(userId)
        if (enabled) await ai.startAutoScheduler(userId)
        // Sync user_bridge_settings so _initBridge can see it on reconnect
        try {
          await queryRun(
            'INSERT INTO user_bridge_settings (user_id, auto_reasoning_enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE auto_reasoning_enabled = ?, updated_at = NOW()',
            [userId, enabled ? 1 : 0, enabled ? 1 : 0]
          )
        } catch (e) { console.error('[BridgeWS] Failed to sync auto_reasoning_enabled from save_auto:', e.message) }
        result = { status: 'success', message: enabled ? '自动推理已开启' : '自动推理已关闭', enabled, symbols }
        break
      }
      case 'audit_logs': {
        // 审计日志只显示自己的数据
        let ownRows = await queryAll('SELECT * FROM trade_audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 100', [userId])
        const logs = ownRows.map(row => {
          const item = { ...row }
          item.created_at_mt5 = utcToMt5Time(item.created_at)
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
        // In observation mode (no own bridge), use admin's signals
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        const sigUserId = hasOwnBridge ? userId : (adminUserId || userId)
        // Old signals
        const oldRows = await queryAll('SELECT id, trade_ticket, execution_result FROM ai_signals WHERE user_id = ? AND is_executed = 1 AND (source = \'manual\' OR source IS NULL) ORDER BY id DESC LIMIT 200', [sigUserId])
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
           ORDER BY d.id DESC LIMIT 200`,
          [sigUserId])
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
        const cfg = params.config
        if (!cfg) return reply({ status: 'error', message: 'config required' })
        const saved = await ai.saveCloseConfig(userId, cfg)
        // Only restart scheduler if it was already running, don't auto-start
        const schedulerState = ai.closeSchedulerState?.[userId]
        if (schedulerState?.running) {
          ai.stopSmartCloseScheduler(userId)
          ai.startSmartCloseScheduler(userId)
        }
        result = { status: 'success', config: saved }
        break
      }
      case 'get_close_config': {
        // In observation mode, show admin's close config
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        const closeUserId = (!hasOwnBridge && adminUserId) ? adminUserId : userId
        const cfg = await ai.getCloseConfig(closeUserId)
        result = { status: 'success', config: cfg || { enabled: false, check_interval_seconds: 30, model_name: 'deepseek-chat' } }
        break
      }
      case 'close_status': {
        // Report smart close scheduler status including pause reasons
        // In observation mode, show admin's close config
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        const closeUserId = (!hasOwnBridge && adminUserId) ? adminUserId : userId
        const closeCfg = await ai.getCloseConfig(closeUserId)
        const enabled = !!(closeCfg?.enabled)
        const intervalSec = closeCfg?.check_interval_seconds || 30
        let paused = false
        let pauseReason = ''

        if (enabled) {
          // Check market status — use closeUserId for bridge data in observation mode
          const tradeMode = await getBridgeTradeMode(closeUserId)
          if (tradeMode !== 4) {
            paused = true
            pauseReason = tradeMode === 0 ? 'market_closed' : 'market_unknown'
          } else {
            // Check positions — use closeUserId's bridge
            try {
              const posData = await sendBridgeCommand(closeUserId, 'positions', {})
              const positions = posData?.positions || []
              if (positions.length === 0) {
                paused = true
                pauseReason = 'no_positions'
              }
            } catch {
              paused = true
              pauseReason = 'bridge_error'
            }
          }
        }

        result = {
          status: 'success',
          scheduler: { enabled, interval_seconds: intervalSec, paused, pause_reason: pauseReason }
        }
        break
      }
      case 'close_signal_tickets': {
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        const adminId = await getAdminUserId()
        const closeTicketUserId = hasOwnBridge ? userId : (adminId || userId)
        const map = await ai.getCloseSignalTickets(closeTicketUserId)
        result = { status: 'success', tickets: map }
        break
      }
      case 'pending_list': {
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        if (!hasOwnBridge) {
          // In observation mode, fall back to admin's bridge
          const adminId = await getAdminUserId()
          if (adminId && bridges.has(adminId) && bridges.get(adminId).ws?.readyState === 1) {
            try {
              const symbol = params.symbol ? params.symbol : null
              const listResult = await ai.mt5Bridge(adminId, 'pending_list', { symbol })
              result = listResult
            } catch (e) {
              console.error('[BridgeWS] pending_list (admin fallback) error:', e.message)
              result = { status: 'error', message: '获取挂单列表失败' }
            }
            break
          }
          result = { status: 'error', message: '请先连接 MT5 桥接' }
          break
        }
        try {
          const bridge = bridges.get(userId)
          const symbol = params.symbol ? params.symbol : null
          const listResult = await ai.mt5Bridge(userId, 'pending_list', { symbol })
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
        try {
          const cancelResult = await ai.mt5Bridge(userId, 'cancel_pending', { ticket })
          if (cancelResult?.status === 'success') {
            result = { status: 'success', message: '挂单已取消', cancelResult }
          } else {
            result = { status: 'error', message: cancelResult?.message || '取消挂单失败' }
          }
        } catch (e) {
          console.error('[BridgeWS] cancel_pending error:', e.message)
          result = { status: 'error', message: '取消挂单失败' }
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
            `SELECT ${sigCols} FROM ai_signals WHERE (pending_ticket = ? OR trade_ticket = ?) ORDER BY id DESC LIMIT 1`,
            [ticketStr, ticketStr]
          )
          // 2. Fallback: search auto_signal_deliveries (multi-user pending orders)
          if (!signal) {
            const deliv = await queryOne(
              'SELECT signal_id FROM auto_signal_deliveries WHERE pending_ticket = ? ORDER BY id DESC LIMIT 1',
              [ticketStr]
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
        const expRes = await ai.mt5Bridge(expUserId, 'history', { page: 1, page_size: 9999 })
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
        const enabled = !!params.enabled
        const existing = await ai.getCloseConfig(userId)
        await ai.saveCloseConfig(userId, { ...(existing || {}), enabled })
        if (enabled) {
          ai.startSmartCloseScheduler(userId)
        } else {
          ai.stopSmartCloseScheduler(userId)
        }
        result = { status: 'success', enabled }
        break
      }
      case 'run_close_now': {
        try {
          await ai.runSmartCloseCycle(userId)
          result = { status: 'success' }
        } catch (e) {
          console.error('[BridgeWS] run_close_now error:', e.message)
          result = { status: 'error', message: '执行平仓检查失败' }
        }
        break
      }
      case 'admin_dashboard': {
        const u = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (u?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }

        const [userStats, signalStats, signalTypeDist, signalTrend, autoReasonStats, tokenStats, tokenTrend, bridgeList, schedulerData] = await Promise.all([
          // 1. User stats
          queryOne(`SELECT
            (SELECT COUNT(*) FROM users) AS total_users,
            (SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURDATE()) AS today_new,
            (SELECT COUNT(*) FROM users WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)) AS online_now,
            (SELECT COUNT(*) FROM users WHERE last_seen_at >= CURDATE()) AS today_active,
            (SELECT COUNT(*) FROM users WHERE plan = 'pro') AS pro_users,
            (SELECT COUNT(*) FROM users WHERE plan = 'plus') AS plus_users,
            (SELECT COUNT(*) FROM users WHERE plan = 'free' OR plan IS NULL) AS free_users`),

          // 2. Signal summary
          queryOne(`SELECT
            (SELECT COUNT(*) FROM ai_signals) AS total,
            (SELECT COUNT(*) FROM ai_signals WHERE DATE(created_at) = CURDATE()) AS today,
            (SELECT COUNT(*) FROM ai_signals WHERE YEARWEEK(created_at, 1) = YEARWEEK(NOW(), 1)) AS week,
            (SELECT COUNT(*) FROM ai_signals WHERE is_executed = 1) AS executed,
            (SELECT ROUND(AVG(confidence)*100, 1) FROM ai_signals WHERE signal_type IN ('buy','sell','strong_buy','strong_sell')) AS avg_confidence`),

          // 3. Signal type distribution
          queryAll('SELECT signal_type, COUNT(*) AS cnt FROM ai_signals GROUP BY signal_type ORDER BY cnt DESC'),

          // 4. Daily signal trend (30 days)
          queryAll(`SELECT DATE(created_at) AS day, COUNT(*) AS cnt
            FROM ai_signals WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY DATE(created_at) ORDER BY day`),

          // 5. Auto-reasoning & trade stats
          queryOne(`SELECT
            (SELECT COUNT(*) FROM user_bridge_settings WHERE auto_reasoning_enabled = 1) AS auto_reasoning_users,
            (SELECT COUNT(*) FROM user_bridge_settings WHERE trade_send_enabled = 1) AS trade_enabled_users,
            (SELECT COUNT(*) FROM auto_scheduler WHERE enabled = 1) AS auto_scheduler_users`),

          // 6. Token usage stats (using pre-calculated token_count)
          queryOne(`SELECT
            (SELECT SUM(token_count) FROM ai_signals WHERE DATE(created_at) = CURDATE()) AS today_tokens,
            (SELECT SUM(token_count) FROM ai_signals) AS total_tokens,
            (SELECT DATE(created_at) FROM ai_signals ORDER BY id DESC LIMIT 1) AS last_api_call`),

          // 7. Daily token trend (30 days)
          queryAll(`SELECT DATE(created_at) AS day,
            SUM(token_count) AS tokens
            FROM ai_signals WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
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
          })()
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
            schedulerData: schedulerData || { schedulers: [], dbStats: [] }
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
          queryOne('SELECT enabled, last_run_at FROM auto_scheduler WHERE user_id = ?', [tid]),
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
              total_signals: (oldStats?.old_total || 0) + (delivStats?.deliv_total || 0),
              today_signals: (oldStats?.old_today || 0) + (delivStats?.deliv_today || 0),
              executed_signals: (oldStats?.old_executed || 0) + (delivStats?.deliv_executed || 0),
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

        result = {
          status: 'success',
          data: {
            user: targetUser,
            settings: targetSettings || { trade_send_enabled: 0, auto_reasoning_enabled: 0 },
            scheduler: targetScheduler || { enabled: 0, symbols: null, last_run_at: null },
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
            'SELECT id, email, nickname, plan, role FROM users WHERE email LIKE ? OR nickname LIKE ? ORDER BY last_seen_at DESC LIMIT ?',
            [`%${searchTerm}%`, `%${searchTerm}%`, limit]
          )
        } else {
          users = await queryAll(
            'SELECT id, email, nickname, plan, role FROM users ORDER BY last_seen_at DESC LIMIT ?',
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
          `SELECT id, email, phone, nickname, plan, role, last_seen_at, bridge_heartbeat, created_at FROM users
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
export function sendBridgeCommand(userId, action, params, timeoutMs = 5000, options = {}) {
  return new Promise((resolve) => {
    if (action === 'open' || action === 'pending') {
      const riskLock = weeklyRiskLockResult()
      if (riskLock) {
        resolve(riskLock)
        return
      }
    }

    let bridge = bridges.get(userId)
    let usingFallback = false

    // Fall back to admin bridge for read operations (unless noFallback)
    if (!options.noFallback) {
      const readActions = ['account', 'positions', 'rates', 'symbols', 'quote', 'pending_list']
      if ((!bridge || bridge.ws.readyState !== 1) && readActions.includes(action) && adminUserId) {
        bridge = bridges.get(adminUserId)
        usingFallback = true
      }
    }

    if (!bridge || bridge.ws.readyState !== 1) {
      resolve({ status: 'error', error: 'Bridge not connected' })
      return
    }

    const cmdId = `cmd_${Date.now()}_${++cmdCounter}`
    const timer = setTimeout(() => {
      pendingCommands.delete(cmdId)
      resolve({ status: 'error', error: 'Bridge command timeout' })
    }, timeoutMs)

    pendingCommands.set(cmdId, { resolve, timer, userId })
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

// Market status: bridge connected + tick time unchanged for 5 min → closed
// Returns 0=closed, 1=LONGONLY, 2=SHORTONLY, 3=CLOSEONLY, 4=FULL, -1=unknown
// Market tick thresholds
const MARKET_SAME_TICK_CLOSED_MS = 60_000
const MARKET_TICK_STALE_MS = 120_000

// Unified market state function
export function getOwnBridgeMarketState(userId) {
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
  let bridge = bridges.get(userId)
  if (!bridge || bridge.ws.readyState !== 1) {
    // Fallback: try admin bridge (Pro/Plus users observing admin's MT5)
    const adminId = await getAdminUserId()
    if (adminId) bridge = bridges.get(adminId)
  }
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

export { sendToBrowsers }
