import { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'
import { query, queryOne, queryAll, queryRun, logAudit, withTransaction } from './db.js'

// Parse symbols from DB: handles legacy JSON array or plain comma-separated text
function parseSymbols(raw) {
  if (!raw) return ['XAUUSD']
  const s = raw.trim()
  if (s.startsWith('[')) { try { return JSON.parse(s) } catch { return [s] } }
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

function localNow() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function toMt5Time(str) {
  // Beijing time (UTC+8) → MT5 broker time (UTC+3): subtract 5 hours
  if (!str) return null
  try {
    const d = new Date(str.replace(' ', 'T'))
    d.setHours(d.getHours() - 5)
    const pad = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch { return str }
}

import { JWT_SECRET } from './config.js'

// Per-user state
const bridges = new Map()       // userId -> { ws, lastSeen }
const browsers = new Map()      // userId -> Set<ws>
const pendingCommands = new Map() // commandId -> { resolve, timer, userId }
let adminUserId = null          // cached admin userId for fallback

let cmdCounter = 0
let wss = null
const _broadcastThrottle = new Map() // userId -> lastBroadcastTime (定期清理防内存泄漏)

// 每 10 分钟清理超过 30 秒未使用的广播节流条目
setInterval(() => {
  const cutoff = Date.now() - 30000
  for (const [uid, last] of _broadcastThrottle) {
    if (last < cutoff) _broadcastThrottle.delete(uid)
  }
}, 10 * 60 * 1000)

async function getAdminUserId() {
  if (adminUserId) return adminUserId
  const row = await queryOne('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin'])
  adminUserId = row?.id || null
  return adminUserId
}


export function initBridgeWS(server) {
  // Cache admin userId at startup
  getAdminUserId().catch(() => {})
  wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/aurum-api/bridge/ws')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
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
  try { userId = jwt.verify(token, JWT_SECRET).userId } catch {}
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
  try { userId = jwt.verify(token, JWT_SECRET).userId } catch {}
  if (!userId) { ws.close(4002, 'Invalid token'); return }

  // 在计划检查完成之前先缓存消息，防止竞态条件（消息先于 _initBridge 到达）
  const msgQueue = []
  const queueMsg = (data) => msgQueue.push(data)
  ws.on('message', queueMsg)

  // Check user plan — only Pro allowed (async, blocks bridge setup)
  queryOne('SELECT plan, plan_expires_at, role FROM users WHERE id = ?', [userId]).then(async user => {
    ws.off('message', queueMsg) // 移除缓存监听器
    if (!user) { ws.close(4002, 'User not found'); return }
    if (user.role !== 'admin') {
      const now = new Date()
      const expired = user.plan_expires_at && new Date(user.plan_expires_at) < now
      if (user.plan === 'free' || user.plan === 'plus' || expired) {
        const reason = expired ? '会员已过期，请续费后重试' : `当前会员等级(${user.plan})不可使用桥接，请升级Pro会员`
        console.log(`[BridgeWS] User ${userId} rejected: ${reason}`)
        ws.close(4003, reason)
        return
      }
    }
    await _initBridge(ws, userId)
    // 重放缓存消息
    for (const msg of msgQueue) ws.emit('message', msg)
  }).catch(err => {
    ws.off('message', queueMsg)
    console.error('[BridgeWS] Plan check error:', err)
    ws.close(4002, 'Server error')
  })
}

async function _initBridge(ws, userId) {

  const existing = bridges.get(userId)
  // Close old bridge connection if still open (one bridge per account)
  if (existing && existing.ws && existing.ws.readyState === 1) {
    try { existing.ws.close(4001, 'Replaced by new connection') } catch {}
  }

  // Read bridge settings from DB (trade_send / auto_reasoning state)
  let dbTradeEnabled = false
  let dbAutoReasoningEnabled = false
  let hasDbRow = false
  try {
    const row = await queryOne('SELECT trade_send_enabled, auto_reasoning_enabled FROM user_bridge_settings WHERE user_id = ?', [userId])
    if (row) {
      hasDbRow = true
      dbTradeEnabled = !!row.trade_send_enabled
      dbAutoReasoningEnabled = !!row.auto_reasoning_enabled
    }
  } catch (e) {
    console.error(`[BridgeWS] Failed to read user_bridge_settings for user ${userId}:`, e.message)
  }
  // Admin defaults to tradeEnabled=true if no DB record exists, but respects explicit DB value of 0
  // Non-admin: use DB value as-is (defaults to false when no row)
  const isAdmin = userId === (adminUserId || -1)
  const defaultTrade = isAdmin ? (hasDbRow ? dbTradeEnabled : true) : dbTradeEnabled
  bridges.set(userId, { ws, lastSeen: Date.now(), tradeEnabled: defaultTrade, autoReasoningEnabled: dbAutoReasoningEnabled, lastPong: Date.now(), lastTradeMode: 4 }); ws._userId = userId

  // Notify browsers with current trade/auto state
  sendToBrowsers(userId, { type: 'hb', mt5_connected: true, mt5_alive: true, trade_enabled: defaultTrade, auto_reasoning_enabled: dbAutoReasoningEnabled })

  // Restore auto-reasoning — check BOTH user_bridge_settings AND auto_scheduler table
  // user_bridge_settings.auto_reasoning_enabled is set by toggle_auto/save_auto UI
  // auto_scheduler.enabled is the actual scheduler state (may survive restart when settings row missing)
  const shouldRestoreAuto = dbAutoReasoningEnabled
  let schedulerEnabled = false
  try {
    const schedulerRow = await queryOne('SELECT enabled, symbols FROM auto_scheduler WHERE user_id = ?', [userId])
    schedulerEnabled = !!(schedulerRow?.enabled)
  } catch {}
  console.log(`[BridgeWS] _initBridge user ${userId}: dbAutoReason=${dbAutoReasoningEnabled} schedulerEnabled=${schedulerEnabled} hasDbRow=${hasDbRow}`)
  if (shouldRestoreAuto || schedulerEnabled) {
    try {
      const ai = await import('./routes/ai.js')
      const cfg = await ai.getAutoConfig(null, userId)
      if (!cfg?.enabled) {
        const globalCfg = await ai.getGlobalAutoConfig()
        const symbols = globalCfg?.symbols || 'XAUUSD'
        await ai.upsertAutoConfig(null, userId, symbols, true)
      }
      // Sync user_bridge_settings if scheduler is enabled but settings row is stale/missing
      if (schedulerEnabled && !shouldRestoreAuto) {
        try {
          await queryRun(
            'INSERT INTO user_bridge_settings (user_id, auto_reasoning_enabled) VALUES (?, 1) ON DUPLICATE KEY UPDATE auto_reasoning_enabled = 1, updated_at = NOW()',
            [userId]
          )
          bridges.get(userId).autoReasoningEnabled = true
        } catch {}
      }
      ai.stopAutoScheduler(userId)
      await ai.startAutoScheduler(userId)
      console.log(`[BridgeWS] Auto-reasoning restored for user ${userId}`)
      sendToBrowsers(userId, { type: 'auto_state', enabled: true, reason: 'bridge_connected' })
    } catch (e) {
      console.error(`[BridgeWS] Failed to restore auto-reasoning for user ${userId}:`, e.message)
    }
  }

  // Server-side ping every 15s — if bridge doesn't reply within 30s, close
  const pingInterval = setInterval(() => {
    const bridge = bridges.get(userId)
    if (!bridge || bridge.ws !== ws) { clearInterval(pingInterval); return }
    if (Date.now() - bridge.lastPong > 30000) {
      try { ws.close(4003, 'Ping timeout') } catch {}
      clearInterval(pingInterval)
      return
    }
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
    if (bridge) bridge.lastSeen = Date.now()

    if (msg.type === 'data') {
      // Real-time market status detection: compare consecutive tick times
      if (bridge && msg.quote && typeof msg.quote.time === 'string') {
        const now = Date.now()
        bridge.lastTickMs = now
        const prev = bridge.mt5TimeStr
        bridge.mt5TimeStr = msg.quote.time
        if (prev !== undefined) {
          if (msg.quote.time !== prev) {
            // Time changed → trading
            bridge.lastTradeMode = 4
            bridge._sameTickStart = null
          } else {
            // Same tick time — mark closed after 5s
            if (!bridge._sameTickStart) bridge._sameTickStart = now
            if (now - bridge._sameTickStart > 5000) bridge.lastTradeMode = 0
          }
        }
      }
      // Data relay — push to browsers, include server-detected trade_mode
      const tradeMode = bridge ? bridge.lastTradeMode : -1
      sendToBrowsers(userId, { type: 'data', trade_mode: tradeMode, ...msg })
    } else if (msg.type === 'hb' || msg.type === 'pong') {
      // Bridge heartbeat/pong — lastSeen already updated
      if (bridge) bridge.lastPong = Date.now()
    } else if (msg.type === 'result') {
      // Command result from bridge
      if (msg.command_id) {
        const pending = pendingCommands.get(msg.command_id)
        if (pending) {
          clearTimeout(pending.timer)
          pendingCommands.delete(msg.command_id)
          pending.resolve(msg.result)
        }
      }
    } else {
    }
  })

  ws.on('close', async () => {
    clearInterval(pingInterval)
    // Guard: only clean up if this ws is still the current bridge for this user
    // (prevents old bridge's close handler from wiping out a newly connected bridge)
    const currentBridge = bridges.get(userId)
    if (!currentBridge || currentBridge.ws !== ws) {
      console.log(`[BridgeWS] Stale close for user ${userId}, new bridge already connected — skipping cleanup`)
      return
    }
    bridges.delete(userId)
    // Notify browsers
    sendToBrowsers(userId, { type: 'disconnect', reason: 'bridge_closed' })
    // Reject pending commands
    for (const [cmdId, pending] of pendingCommands) {
      if (pending.userId === userId) {
        clearTimeout(pending.timer)
        pendingCommands.delete(cmdId)
        pending.resolve({ status: 'error', error: 'Bridge disconnected' })
      }
    }
    // Bridge disconnected — stop auto scheduler (no bridge to execute trades)
    // CRITICAL: Do NOT touch auto_scheduler.enabled! The enabled flag reflects user's
    // intent, not bridge connectivity. Resetting it on disconnect causes:
    // 1. Server restart → all enabled flags get zeroed → initAutoSchedulers starts nothing
    // 2. Bridge reconnect → UI shows ON (from user_bridge_settings) but DB says OFF
    //    → _initBridge restores it, but potential race with async close handler
    // Just stop the in-memory scheduler; enabled state stays intact in DB.
    try {
      const ai = await import('./routes/ai.js')
      ai.stopAutoScheduler(userId)
      sendToBrowsers(userId, { type: 'auto_state', enabled: false, reason: 'bridge_disconnected' })
    } catch (e) {
      console.error('[BridgeWS] Failed to stop auto-reasoning on disconnect:', e.message)
    }
  })

  ws.on('error', (err) => {
    console.error(`[BridgeWS] Bridge error for user ${userId}:`, err.message)
  })
}

// ============ Helpers ============

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
  // If this is admin's bridge data, also forward to users without their own bridge
  // Throttle: max 4 broadcasts per second per user to prevent flooding browsers
  if (userId === adminUserId && data.type === 'data') {
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
          try { ws.send(adminJson) } catch {}
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
    const ai = await import('./routes/ai.js')
    const user = await queryOne('SELECT plan, role FROM users WHERE id = ?', [userId])
    const isPro = user?.role === 'admin' || user?.plan === 'pro'
    const hasAccess = isPro || user?.plan === 'plus'
    if (!hasAccess) return reply({ status: 'error', message: '需要Pro会员' })

    // Plus users: read-only, block write operations + analyze (API cost)
    const writeActions = ['open', 'close', 'toggle_trade', 'execute', 'save_config', 'save_auto_config', 'toggle_auto', 'set_quote_symbol', 'save_close_config', 'run_close_now']
    if (!isPro && writeActions.includes(action)) {
      return reply({ status: 'error', message: '升级会员即可解锁交易功能' })
    }
    // Plus users also blocked from analyze (consumes AI API credits)
    if (!isPro && action === 'analyze') {
      return reply({ status: 'error', message: '升级会员即可使用 AI 推理' })
    }

    // Pro/Plus users without own bridge: block write operations
    const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws.readyState === 1
    if (!hasOwnBridge && writeActions.includes(action)) {
      return reply({ status: 'error', message: '请先连接您的 MT5 账户' })
    }

    // Block trade operations when trading is disabled
    const tradeActions = ['open', 'close', 'execute']
    if (tradeActions.includes(action) && hasOwnBridge) {
      const bridge = bridges.get(userId)
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
        const tradeEnabled = usingFallback ? (bridge.tradeEnabled !== false) : (alive && (bridge.tradeEnabled !== false))
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
      case 'account':
        result = await ai.mt5Bridge(userId, 'account', {})
        break
      case 'symbols':
        result = await ai.mt5Bridge(userId, 'symbols', {})
        break
      case 'quote':
        result = await ai.mt5Bridge(userId, 'quote', { symbol: params.symbol })
        break
      case 'positions':
        result = await ai.mt5Bridge(userId, 'positions', {})
        break
      case 'open':
        result = await ai.mt5Bridge(userId, 'open', params)
        await ai.insertAudit(null, userId, 'manual_open', params.symbol, params, result, result?.status || 'unknown')
        break
      case 'close':
        result = await ai.mt5Bridge(userId, 'close', params)
        await ai.insertAudit(null, userId, 'manual_close', null, params, result, result?.status || 'unknown')
        break
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
          else await queryRun('INSERT INTO system_config (`key`, `value`) VALUES (?, ?)', [key, symbol])
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
          // Fetch all orders from bridge (no date filter on bridge — server handles filtering)
          const hRes = await ai.mt5Bridge(historyUserId, 'history', { page: 1, page_size: 9999 })
          if (hRes?.status === 'success' && Array.isArray(hRes.orders)) {
            const allOrders = hRes.orders          // preserve ALL orders for cumulative calc
            let orders = [...allOrders]
            const origStats = hRes.statistics || {}
            const _ordDate = o => (o.close_time || o.time || '')
            const _ordType = o => (o.type || '')
            const _ordProfit = o => Number(o.profit || 0)

            // Apply close-time filters
            if (params.close_from) orders = orders.filter(o => _ordDate(o).slice(0, 10) >= params.close_from)
            if (params.close_to) orders = orders.filter(o => _ordDate(o).slice(0, 10) <= params.close_to)

            // Apply entry-time filters
            if (params.entry_from) orders = orders.filter(o => (o.entry_time || '').slice(0, 10) >= params.entry_from)
            if (params.entry_to) orders = orders.filter(o => (o.entry_time || '').slice(0, 10) <= params.entry_to)

            // Apply direction / profit filters
            if (params.direction) orders = orders.filter(o => _ordType(o).toUpperCase() === params.direction)
            if (params.profit_filter === 'profit') orders = orders.filter(o => _ordProfit(o) > 0)
            if (params.profit_filter === 'loss') orders = orders.filter(o => _ordProfit(o) < 0)

            // Sort by close_time DESC — newest first (page 1 = latest 20)
            orders.sort((a, b) => _ordDate(b).localeCompare(_ordDate(a)))

            // ---- Recalculate stats from filtered orders ----
            // total_profit: only filtered orders (date range + direction + profit_filter)
            const filteredProfit = Math.round(orders.reduce((s, o) => s + _ordProfit(o), 0) * 100) / 100

            // net_result: 本金 + 从开始到筛选结束日期的累计收益
            // (cumulative from ALL orders, not affected by direction/profit_filter)
            const closeTo = params.close_to
              || (allOrders.length > 0 ? allOrders.reduce((max, o) => { const d = _ordDate(o).slice(0,10); return d > max ? d : max; }, '') : '')
            const cumToDate = Math.round(allOrders
              .filter(o => _ordDate(o).slice(0, 10) <= closeTo)
              .reduce((s, o) => s + _ordProfit(o), 0) * 100) / 100

            // initCapital: 本金 = 当前余额 - 全网累计净结果
            const allTimeNet = (Number(origStats.total_profit) || 0) + (Number(origStats.credit) || 0) + (Number(origStats.deposit) || 0) - (Number(origStats.withdrawal) || 0)
            const balance = Number(origStats.account_balance) || 0
            const initCapital = Math.max(0, balance - allTimeNet)
            // 结余 = 本金 + 入金 + 累计收益(到 close_to 日期)
            const deposit = Number(origStats.deposit) || 0
            const netToDate = Math.round((initCapital + deposit + cumToDate) * 100) / 100

            // Paginate
            const page = params.page || 1
            const pageSize = params.page_size || 20
            const si = (page - 1) * pageSize

            result = {
              status: 'success',
              orders: orders.slice(si, si + pageSize),
              statistics: {
                total_profit: filteredProfit,
                credit: origStats.credit || 0,
                deposit: origStats.deposit || 0,
                withdrawal: origStats.withdrawal || 0,
                net_result: netToDate,
              },
              pagination: {
                current_page: page,
                page_size: pageSize,
                total_count: orders.length,
                total_pages: Math.max(Math.ceil(orders.length / pageSize), 1)
              }
            }
          } else {
            result = hRes || { status: 'success', orders: [], statistics: { total_profit: 0, credit: 0, deposit: 0, withdrawal: 0, net_result: 0 } }
          }
        } else {
          result = { status: 'success', orders: [], statistics: { total_profit: 0, credit: 0, deposit: 0, withdrawal: 0, net_result: 0 } }
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
          const hcResult = await ai.mt5Bridge(hcUserId, 'history', { page: 1, page_size: 9999 })
          if (hcResult?.status === 'success' && Array.isArray(hcResult.orders)) {
            // Compute initCapital from ALL orders (before filtering), using account balance
            const allOrders = hcResult.orders;
            const totalProfit = allOrders.reduce((s, o) => s + Number(o.profit || 0), 0);
            let initCapital = 0;
            let acct = null;
            try {
              acct = await ai.mt5Bridge(hcUserId, 'account', {});
              if (acct?.status === 'success' && acct.balance != null) {
                initCapital = Math.max(0, acct.balance - totalProfit);
              }
            } catch (e) { /* fall through, initCapital=0 */ }

            // Default chart date range: last 30 days
            const now = new Date()
            const defaultFrom = new Date(now); defaultFrom.setDate(defaultFrom.getDate() - 30)
            const dateFrom = params.close_from || defaultFrom.toISOString().slice(0, 10)
            const dateTo = params.close_to || now.toISOString().slice(0, 10)

            // Daily aggregation on ALL orders (for daily bars display, up to 30 days)
            const allDailyMap = {};
            hcResult.orders.forEach(o => {
              const d = (o.close_time || '').slice(0, 10);
              if (!d) return;
              if (!allDailyMap[d]) allDailyMap[d] = { profit: 0, trade_count: 0, wins: 0, losses: 0 }
              const p = Number(o.profit || 0)
              allDailyMap[d].profit += p
              allDailyMap[d].trade_count++
              if (p > 0) allDailyMap[d].wins++
              else if (p < 0) allDailyMap[d].losses++
            })
            const allDates = Object.keys(allDailyMap).sort()
            // Only show dates within the selected range
            const shownDates = allDates.filter(d => d >= dateFrom && d <= dateTo)
            const daily = shownDates.map(d => ({
              date: d,
              profit: Math.round(allDailyMap[d].profit * 100) / 100,
              trade_count: allDailyMap[d].trade_count,
              wins: allDailyMap[d].wins,
              losses: allDailyMap[d].losses
            }))

            // Filter orders for cumulative/drawdown/stats (within selected range)
            let orders = hcResult.orders.filter(o => {
              const d = (o.close_time || '').slice(0, 10)
              return d >= dateFrom && d <= dateTo
            })

            // Apply additional chart filters (direction, profit)
            if (params.direction) orders = orders.filter(o => String(o.type || '').toUpperCase() === params.direction)
            if (params.profit_filter === 'profit') orders = orders.filter(o => Number(o.profit || 0) > 0)
            if (params.profit_filter === 'loss') orders = orders.filter(o => Number(o.profit || 0) < 0)

            // Sort orders by close time (mandatory for correct drawdown)
            orders.sort((a, b) => (a.close_time || '').localeCompare(b.close_time || ''));

            // Cumulative + drawdown per day (aligned with shownDates daily chart labels)
            // Drawdown based on equity = initCapital + cum, not raw profit
            const cumulative = [];
            const drawdown = [];
            let cum = 0, peak = initCapital, maxDD = 0;
            let orderIdx = 0;
            shownDates.forEach(d => {
              while (orderIdx < orders.length && (orders[orderIdx].close_time || '').slice(0, 10) === d) {
                cum += Number(orders[orderIdx].profit || 0);
                orderIdx++;
              }
              cum = Math.round(cum * 100) / 100;
              cumulative.push(cum);
              const equity = initCapital + cum;
              if (equity > peak) peak = equity;
              const dd = peak > 0 ? Math.round((1 - equity / peak) * 10000) / 100 : 0;
              drawdown.push(dd);
              if (dd > maxDD) maxDD = dd;
            });

            // Win/loss stats (per-trade, avg_win/avg_loss)
            const wins = orders.filter(o => Number(o.profit || 0) > 0)
            const losses = orders.filter(o => Number(o.profit || 0) < 0)
            const grossProfit = wins.reduce((s, o) => s + Number(o.profit || 0), 0)
            const grossLoss = Math.abs(losses.reduce((s, o) => s + Number(o.profit || 0), 0))
            const avgWin = wins.length > 0 ? grossProfit / wins.length : 0
            const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0

            result = {
              status: 'success',
              daily,
              cumulative,
              drawdown,
              stats: {
                total_trades: orders.length,
                win_rate: orders.length > 0 ? Math.round(wins.length / orders.length * 10000) / 100 : 0,
                profit_factor: avgLoss > 0 ? Math.round(avgWin / avgLoss * 100) / 100 : avgWin > 0 ? 999 : 0,
                max_drawdown: maxDD,
                gross_profit: Math.round(grossProfit * 100) / 100,
                gross_loss: Math.round(grossLoss * 100) / 100,
              }
            }
          } else {
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
        // skipFallbacks: manual config UI must show ONLY the user's own settings.
        // No API key / model / system_prompt leakage from admin model_sharing,
        // system_config, or global_auto_config.
        const row = await ai.getActiveConfig(null, userId, params.session_id || 'default', null, { skipFallbacks: true })
        const cfg = ai.configPublic(row)
        result = { status: 'success', config: cfg }
        break
      }
      case 'save_config': {
        const cfg = params.config
        if (!cfg) return reply({ status: 'error', message: 'config required' })
        const now = localNow()
        const sid = params.session_id || 'default'
        await withTransaction(async (run) => {
          await run('UPDATE ai_configs SET is_active = 0 WHERE user_id = ? AND session_id = ?', [userId, sid])
          await run(`INSERT INTO ai_configs(user_id, session_id, api_provider, api_key_encrypted, api_base_url, model_name,
            temperature, max_tokens, enable_auto_trade, enable_futures_trading, risk_level,
            max_position_size, selected_take_profit, model_sharing_enabled, auto_config_override,
            auto_symbols, auto_interval_minutes, system_prompt, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON DUPLICATE KEY UPDATE
              api_key_encrypted = CASE WHEN VALUES(api_key_encrypted) IS NOT NULL THEN VALUES(api_key_encrypted) ELSE ai_configs.api_key_encrypted END,
              api_base_url = VALUES(api_base_url), model_name = VALUES(model_name), temperature = VALUES(temperature),
              max_tokens = VALUES(max_tokens), enable_auto_trade = VALUES(enable_auto_trade),
              enable_futures_trading = VALUES(enable_futures_trading), risk_level = VALUES(risk_level),
              max_position_size = VALUES(max_position_size), selected_take_profit = VALUES(selected_take_profit),
              model_sharing_enabled = VALUES(model_sharing_enabled), auto_config_override = VALUES(auto_config_override),
              auto_symbols = VALUES(auto_symbols), auto_interval_minutes = VALUES(auto_interval_minutes),
              system_prompt = CASE WHEN VALUES(system_prompt) IS NOT NULL THEN VALUES(system_prompt) ELSE ai_configs.system_prompt END,
              is_active = 1, updated_at = VALUES(updated_at)`,
            [userId, sid, cfg.api_provider || 'deepseek', cfg.api_key || null,
              cfg.api_base_url || null, cfg.model_name || 'deepseek-chat', cfg.temperature || 0.7, cfg.max_tokens || 2000,
              cfg.enable_auto_trade ? 1 : 0, cfg.enable_futures_trading ? 1 : 0, cfg.risk_level || 'medium',
              cfg.max_position_size || 0.05, cfg.selected_take_profit || 1, cfg.model_sharing_enabled ? 1 : 0,
              cfg.auto_config_override ? 1 : 0,
              cfg.auto_symbols || null, cfg.auto_interval_minutes || null,
              cfg.system_prompt || null, now, now])
        })
        const row = await ai.getActiveConfig(null, userId, params.session_id || 'default', cfg.api_provider)
        result = { status: 'success', config: ai.configPublic(row) }
        break
      }
      case 'signals_latest_id': {
        // Lightweight check: return only latest signal's ID and minimal fields
        let queryUserId = userId
        const sessionFilter = params.session_id ? 'AND session_id = ?' : ''
        const sessionParam = params.session_id ? [params.session_id] : []
        let row = await queryOne(`SELECT id, signal_type, is_executed, created_at, ttl_seconds, timeframe FROM ai_signals WHERE user_id = ? ${sessionFilter} ORDER BY id DESC LIMIT 1`, [userId, ...sessionParam])
        if (!row && adminUserId) {
          queryUserId = adminUserId
          row = await queryOne(`SELECT id, signal_type, is_executed, created_at, ttl_seconds, timeframe FROM ai_signals WHERE user_id = ? ${sessionFilter} ORDER BY id DESC LIMIT 1`, [queryUserId, ...sessionParam])
        }
        if (row) {
          const now = Date.now()
          const createdAt = new Date(row.created_at).getTime()
          const ttl = (row.ttl_seconds || 3600) * 1000
          row.is_stale = (now - createdAt) > ttl
          row.age_seconds = Math.floor((now - createdAt) / 1000)
        }
        result = { status: 'success', signal: row || null }
        break
      }
      case 'signal_detail': {
        const signalId = Number(params.signal_id)
        if (!signalId) return reply({ status: 'error', message: 'signal_id required' })
        let row = await queryOne('SELECT * FROM ai_signals WHERE id = ? AND user_id = ?', [signalId, userId])
        if (!row && adminUserId) row = await queryOne('SELECT * FROM ai_signals WHERE id = ? AND user_id = ?', [signalId, adminUserId])
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
        let queryUserId = userId
        // Build filter conditions
        const filterClauses = ['user_id = ?']
        const filterParams = [userId]
        if (params.direction) {
          const types = { buy: 'buy,strong_buy', sell: 'sell,strong_sell', hold: 'hold' }
          const dirTypes = types[params.direction] || params.direction
          filterClauses.push(`signal_type IN (${dirTypes.split(',').map(() => '?').join(',')})`)
          filterParams.push(...dirTypes.split(','))
        }
        if (params.timeframe) {
          filterClauses.push('timeframe = ?')
          filterParams.push(params.timeframe)
        }
        if (params.direction === 'close') {
          // CLOSE signals use session_id='smart_close'
          filterClauses.push('session_id = ?')
          filterParams.push('smart_close')
        } else if (params.session_id) {
          filterClauses.push('session_id = ?')
          filterParams.push(params.session_id)
        }
        const where = filterClauses.join(' AND ')
        // Check if user has any rows matching filters
        const ownRows = await queryAll(`SELECT * FROM ai_signals WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...filterParams, limit + 1, offset])
        if (ownRows.length === 0 && adminUserId) {
          queryUserId = adminUserId
          filterParams[0] = adminUserId
        }
        const rows = ownRows.length > 0 ? ownRows : await queryAll(`SELECT * FROM ai_signals WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...filterParams, limit + 1, offset])
        const hasMore = rows.length > limit
        const sliced = rows.slice(0, limit)
        // Get filtered total count for pagination
        const countParams = [...filterParams]
        const countRow = await queryOne(`SELECT COUNT(*) as total FROM ai_signals WHERE ${where}`, countParams)
        const totalCount = countRow ? countRow.total : sliced.length
        const signals = sliced.map(row => {
          const item = { ...row }
          try { item.market_data = JSON.parse(item.market_data_json) } catch { item.market_data = {} }
          delete item.market_data_json
          item.is_executed = !!item.is_executed
          ai.attachSignalTiming(item)
          return item
        })
        result = { status: 'success', signals, has_more: hasMore, total_count: totalCount }
        break
      }
      case 'execute': {
        const signal = await queryOne('SELECT * FROM ai_signals WHERE id = ? AND user_id = ?', [params.signal_id, userId])
        if (!signal) return reply({ status: 'error', message: 'Signal not found' })
        // Targeted risk-param fetch: auto signal → global config (or user override), manual signal → user's config
        // No fallback, no penetration, no API key leak
        const config = await ai.getExecuteRiskConfig(userId, signal)
        if (!config || !config.enable_auto_trade) {
          result = { status: 'rejected', message: 'auto_trade_disabled', details: { enable_auto_trade: config?.enable_auto_trade ?? 0 } }
          await ai.insertAudit(null, userId, 'ai_execute', signal.symbol, params, result, result.status)
          break
        }
        const timedSignal = ai.attachSignalTiming({ ...signal })
        if (timedSignal.is_stale) {
          result = { status: 'rejected', message: 'signal_expired', details: { age_seconds: timedSignal.age_seconds, ttl_seconds: timedSignal.ttl_seconds } }
          await ai.insertAudit(null, userId, 'ai_execute', signal.symbol, params, result, result.status)
          break
        }
        const marketData = JSON.parse(signal.market_data_json || '{}')
        const orderPayload = ai.signalOrderPayload(signal, config, marketData, params.confirm)
        result = await ai.mt5Bridge(userId, 'open', orderPayload)
        if (result.status === 'success') {
          await queryRun('UPDATE ai_signals SET is_executed = 1, executed_at = ?, trade_ticket = ? WHERE id = ?', [localNow(), result.ticket || null, signal.id])
        }
        await ai.insertAudit(null, userId, 'ai_execute', signal.symbol, { signal_id: params.signal_id, confirm: params.confirm }, result, result.status)
        break
      }
      case 'auto_status': {
        // In observation mode (no own bridge), show admin's auto state
        const hasOwnBridge = bridges.has(userId) && bridges.get(userId).ws?.readyState === 1
        const statusUserId = (!hasOwnBridge && adminUserId) ? adminUserId : userId
        const cfg = await ai.getAutoConfig(null, statusUserId)
        const globalCfg = await ai.getGlobalAutoConfig()
        let symbols = parseSymbols(globalCfg?.symbols)
        let intervalMin = globalCfg?.interval_minutes || 5
        // Check for user override (silent, no banner)
        // Override removed: auto config panel shows global config only
        result = { status: 'success', scheduler: { enabled: !!cfg?.enabled, symbols, interval_minutes: intervalMin, running: !!cfg?.enabled } }
        break
      }
      case 'toggle_auto': {
        // Simple toggle: immediately return new state, auto uses global config only
        const cfg = await ai.getAutoConfig(null, userId)
        const newEnabled = !cfg?.enabled
        const globalCfg = await ai.getGlobalAutoConfig()
        const symbols = parseSymbols(globalCfg?.symbols)
        await ai.upsertAutoConfig(null, userId, symbols, newEnabled)
        ai.stopAutoScheduler(userId)
        if (newEnabled) {
          await ai.startAutoScheduler(userId)
        }
        // Persist auto-reasoning state to DB
        try {
          await queryRun(
            'INSERT INTO user_bridge_settings (user_id, auto_reasoning_enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE auto_reasoning_enabled = ?, updated_at = NOW()',
            [userId, newEnabled ? 1 : 0, newEnabled ? 1 : 0]
          )
        } catch (e) { console.error('[BridgeWS] Failed to persist auto_reasoning_enabled:', e.message) }
        // Update in-memory bridge state so heartbeat reflects it
        const bridgeAuto = bridges.get(userId)
        if (bridgeAuto) bridgeAuto.autoReasoningEnabled = newEnabled
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
        if (user?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }
        const globalCfg = await ai.getGlobalAutoConfig()
        const autoPrompt = globalCfg?.system_prompt || ''
        let symbols = parseSymbols(globalCfg?.symbols)
        let intervalMinutes = globalCfg?.interval_minutes || 5
        // If user has override enabled, silently use their symbol + interval (no banner / no disabled)
        // Override removed: auto config panel shows global config only
        result = {
          status: 'success',
          config: {
            api_provider: globalCfg?.api_provider || 'deepseek',
            model_name: globalCfg?.model_name || 'deepseek-chat',
            has_api_key: !!globalCfg?.api_key_encrypted,
            api_base_url: globalCfg?.api_base_url || 'https://api.deepseek.com',
            temperature: globalCfg?.temperature ?? 0.3,
            max_tokens: globalCfg?.max_tokens ?? 2000,
            risk_level: globalCfg?.risk_level || 'medium',
            max_position_size: globalCfg?.max_position_size ?? 0.05,
            selected_take_profit: globalCfg?.selected_take_profit ?? 2,
            system_prompt: autoPrompt,
            symbols,
            interval_minutes: intervalMinutes,
            enable_auto_trade: !!globalCfg?.enable_auto_trade
          }
        }
        break
      }
      case 'save_auto_config': {
        // Save global auto config (admin only)
        const user2 = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (user2?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }
        const existing = await ai.getGlobalAutoConfig()
        const existingSymbols = (existing?.symbols || 'XAUUSD').split(',').map(s => s.trim()).filter(Boolean)
        const newCfg = {
          symbols: Array.isArray(params.symbols) ? params.symbols[0] || 'XAUUSD' : (params.symbols || existing?.symbols || 'XAUUSD'),
          interval_minutes: params.interval_minutes ?? existing?.interval_minutes ?? 5,
          api_provider: params.api_provider ?? existing?.api_provider ?? 'deepseek',
          model_name: params.model_name ?? existing?.model_name ?? 'deepseek-chat',
          api_key_encrypted: params.api_key || existing?.api_key_encrypted || null,
          api_base_url: params.api_base_url ?? existing?.api_base_url ?? 'https://api.deepseek.com',
          temperature: params.temperature ?? existing?.temperature ?? 0.3,
          max_tokens: params.max_tokens ?? existing?.max_tokens ?? 2000,
          system_prompt: params.system_prompt ?? existing?.system_prompt ?? null,
          risk_level: params.risk_level ?? existing?.risk_level ?? 'medium',
          max_position_size: params.max_position_size ?? existing?.max_position_size ?? 0.05,
          selected_take_profit: params.selected_take_profit ?? existing?.selected_take_profit ?? 2,
          enable_auto_trade: params.enable_auto_trade ?? existing?.enable_auto_trade ?? 0,
        }
        await ai.saveGlobalAutoConfig(newCfg)
        // Restart schedulers for all enabled users
        const enabledUsers = await queryAll('SELECT user_id FROM auto_scheduler WHERE enabled = 1 AND user_id != 0')
        for (const u of enabledUsers) {
          ai.stopAutoScheduler(u.user_id)
          await ai.startAutoScheduler(u.user_id)
        }
        result = { status: 'success', message: '自动推理配置已保存' }
        break
      }
      case 'save_auto': {
        // Legacy: save per-user auto scheduler settings
        const { symbol = 'XAUUSD' } = params
        const symbols = [symbol]
        const enabled = !!params.enabled
        await ai.upsertAutoConfig(null, userId, symbols, enabled)
        ai.stopAutoScheduler(userId)
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
        let ownRows = await queryAll('SELECT * FROM trade_audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 100', [userId])
        if (ownRows.length === 0 && adminUserId) ownRows = await queryAll('SELECT * FROM trade_audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 100', [adminUserId])
        const logs = ownRows.map(row => {
          const item = { ...row }
          item.created_at_mt5 = toMt5Time(item.created_at)
          try { item.request = JSON.parse(item.request_json) } catch { item.request = {} }
          try { item.result = JSON.parse(item.result_json) } catch { item.result = {} }
          delete item.request_json
          delete item.result_json
          return item
        })
        result = { status: 'success', logs }
        break
      }
      case 'signal_tickets': {
        const rows = await queryAll('SELECT id, trade_ticket, execution_result FROM ai_signals WHERE user_id = ? AND is_executed = 1 ORDER BY id DESC LIMIT 200', [userId])
        const ticketMap = {}
        for (const row of rows) {
          try {
            let ticket = row.trade_ticket
            if (!ticket) {
              const exec = JSON.parse(row.execution_result || '{}')
              ticket = exec.order || exec.ticket || exec.position
            }
            if (ticket) ticketMap[String(ticket)] = row.id
          } catch {}
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
        const map = await ai.getCloseSignalTickets(userId)
        result = { status: 'success', tickets: map }
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

        let expUserId = adminUserId || userId
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

        // Collect all tickets from orders
        const tickets = orders.map(o => String(o.ticket || o.order || '')).filter(Boolean)
        let signalMap = {}

        if (tickets.length > 0) {
          // Use the EXACT same matching logic as signal_tickets handler (line 1009):
          //   1. trade_ticket direct match
          //   2. fallback: execution_result JSON → order/ticket/position
          // Only is_executed=1 signals have a real order ticket binding
          const signalRows = await queryAll(
            `SELECT id, trade_ticket, signal_type, confidence, recommended_volume, analysis, reasoning,
                    stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price,
                    session_id, is_executed, execution_result, created_at, symbol
             FROM ai_signals WHERE is_executed = 1 ORDER BY created_at DESC`
          )

          // Build ticket→signal map using same extraction as signal_tickets handler
          for (const s of signalRows) {
            let ticket = s.trade_ticket
            if (!ticket) {
              try {
                const exec = JSON.parse(s.execution_result || '{}')
                ticket = exec.order || exec.ticket || exec.position
              } catch {}
            }
            if (ticket) {
              const tk = String(ticket)
              if (!signalMap[tk]) signalMap[tk] = []
              signalMap[tk].push(flattenSignal(s))
            }
          }

          // Also match signals WITH trade_ticket but NOT is_executed=1
          // (auto-reasoning assigns trade_ticket before execution)
          const unmatchedTickets = tickets.filter(tk => !signalMap[tk])
          if (unmatchedTickets.length > 0) {
            const placeholders = unmatchedTickets.map(() => '?').join(',')
            const taggedRows = await queryAll(
              `SELECT id, trade_ticket, signal_type, confidence, recommended_volume, analysis, reasoning,
                      stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price,
                      session_id, is_executed, execution_result, created_at, symbol
               FROM ai_signals WHERE trade_ticket IN (${placeholders}) AND is_executed != 1
               ORDER BY created_at DESC`,
              unmatchedTickets
            )
            for (const s of taggedRows) {
              const tk = String(s.trade_ticket)
              if (!signalMap[tk]) signalMap[tk] = []
              signalMap[tk].push(flattenSignal(s))
            }
          }
        }

        // Build export rows: one order + reasoning = one row
        const exportRows = orders.map(o => {
          const tk = String(o.ticket || o.order || '')
          const signals = signalMap[tk] || []
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
          result = { status: 'error', message: e.message }
        }
        break
      }
      default:
        result = { status: 'error', message: `Unknown action: ${action}` }
    }
    reply(result || { status: 'error', message: 'No result' })
  } catch (err) {
    reply({ status: 'error', message: err.message })
  }
}

// Send command to bridge and wait for result
export function sendBridgeCommand(userId, action, params, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let bridge = bridges.get(userId)
    let usingFallback = false

    // Fall back to admin bridge for read operations
    const readActions = ['account', 'positions', 'rates', 'symbols', 'quote']
    if ((!bridge || bridge.ws.readyState !== 1) && readActions.includes(action) && adminUserId) {
      bridge = bridges.get(adminUserId)
      usingFallback = true
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

// Get bridge status for a user
export function getBridgeStatus(userId) {
  const bridge = bridges.get(userId)
  if (!bridge || bridge.ws.readyState !== 1) return { connected: false }
  return {
    connected: true,
    alive: Date.now() - bridge.lastSeen < 20000,
    lastSeen: bridge.lastSeen,
  }
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
