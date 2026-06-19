import { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'
import { query, queryOne, queryAll, queryRun, logAudit } from './db.js'

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

const JWT_SECRET = process.env.JWT_SECRET || 'wall-street-skill-secret'

// Per-user state
const bridges = new Map()       // userId -> { ws, lastSeen }
const browsers = new Map()      // userId -> Set<ws>
const pendingCommands = new Map() // commandId -> { resolve, timer, userId }
let adminUserId = null          // cached admin userId for fallback

let cmdCounter = 0
let wss = null

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

  console.log('[BridgeWS] WebSocket bridge initialized')
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
      ws.send(JSON.stringify({
        type: 'hb',
        seq: msg.seq,
        mt5_connected: connected,
        mt5_alive: alive,
        using_fallback: usingFallback,
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

  const existing = bridges.get(userId)
  // Admin defaults to tradeEnabled=true, others false
  const defaultTrade = userId === (adminUserId || -1) ? true : (existing?.tradeEnabled ?? false)
  bridges.set(userId, { ws, lastSeen: Date.now(), tradeEnabled: defaultTrade }); ws._userId = userId
  console.log(`[BridgeWS] User ${userId} bridge connected`)

  // Notify browsers
  sendToBrowsers(userId, { type: 'hb', mt5_connected: true, mt5_alive: true })

  ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data) } catch(e) { return }

    const bridge = bridges.get(userId)
    if (bridge) bridge.lastSeen = Date.now()

    if (msg.type === 'data') {
      // Cache trade_mode for market status checks
      if (bridge && msg.quote && typeof msg.quote.trade_mode === 'number') {
        bridge.tradeMode = msg.quote.trade_mode
      }
      // Data relay — push to browsers as-is
      sendToBrowsers(userId, { type: 'data', ...msg })
    } else if (msg.type === 'hb') {
      // Bridge heartbeat — lastSeen already updated
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
      console.log('[BridgeWS] User ' + userId + ' unknown type:', msg.type)
    }
  })

  ws.on('close', async () => {
    bridges.delete(userId)
    console.log(`[BridgeWS] User ${userId} bridge disconnected`)
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
    // Auto-disable auto-reasoning when bridge disconnects
    try {
      const ai = await import('./routes/ai.js')
      const cfg = await ai.getAutoConfig(null, userId)
      if (cfg?.enabled) {
        await ai.upsertAutoConfig(null, userId, null, false)
        ai.stopAutoScheduler(userId)
        sendToBrowsers(userId, { type: 'auto_state', enabled: false, reason: 'bridge_disconnected' })
        console.log(`[BridgeWS] User ${userId} auto-reasoning disabled: bridge disconnected`)
      }
    } catch (e) {
      console.error('[BridgeWS] Failed to disable auto-reasoning on disconnect:', e.message)
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
  if (userId === adminUserId && data.type === 'data') {
    const adminJson = JSON.stringify({ ...data, _source: 'admin_fallback' })
    for (const [uid, browserSet] of browsers) {
      if (uid === adminUserId) continue
      if (bridges.has(uid)) continue // user has their own bridge
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
            trade_mode: bridge ? (typeof bridge.tradeMode === 'number' ? bridge.tradeMode : -1) : -1,
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
        // Check if any filter is active
        const hasFilter = params.entry_from || params.entry_to || params.close_from || params.close_to || params.direction || params.profit_filter
        if (bridgeOk) {
          // When filtering, fetch all data (large page_size) so we can filter server-side
          const bridgePageSize = hasFilter ? 9999 : (params.page_size || 20)
          result = await ai.mt5Bridge(historyUserId, 'history', { page: 1, page_size: bridgePageSize })
          // Apply filters if present
          if (hasFilter && result?.status === 'success' && Array.isArray(result.orders)) {
            let orders = result.orders
            if (params.entry_from) orders = orders.filter(o => (o.entry_time || '') >= params.entry_from)
            if (params.entry_to) orders = orders.filter(o => (o.entry_time || '') <= params.entry_to + 'T23:59:59')
            if (params.close_from) orders = orders.filter(o => (o.close_time || o.time || '') >= params.close_from)
            if (params.close_to) orders = orders.filter(o => (o.close_time || o.time || '') <= params.close_to + 'T23:59:59')
            if (params.direction) orders = orders.filter(o => String(o.type || '').toUpperCase() === params.direction)
            if (params.profit_filter === 'profit') orders = orders.filter(o => Number(o.profit) > 0)
            if (params.profit_filter === 'loss') orders = orders.filter(o => Number(o.profit) < 0)
            // Recalculate statistics from filtered data
            const tp = orders.reduce((s, o) => s + Number(o.profit || 0), 0)
            const stats = result.statistics || {}
            result.statistics = {
              ...stats,
              total_profit: Math.round(tp * 100) / 100,
              net_result: Math.round((tp + (stats.credit || 0) + (stats.deposit || 0) - (stats.withdrawal || 0)) * 100) / 100,
              trade_count: orders.length
            }
            // Paginate filtered results
            const page = params.page || 1
            const pageSize = params.page_size || 20
            const si = (page - 1) * pageSize
            result.orders = orders.slice(si, si + pageSize)
            result.pagination = {
              current_page: page,
              page_size: pageSize,
              total_count: orders.length,
              total_pages: Math.max(Math.ceil(orders.length / pageSize), 1)
            }
          }
          // TEMP DIAG: check order lookup
          const diag = result?._diag
          if (diag) console.log(`[OrdDiag] lookup_count=${diag.order_lookup_count} first_keys=${JSON.stringify(diag.order_diag?.first_keys)} sample_tp=${diag.order_diag?.sample_tp} sample_sl=${diag.order_diag?.sample_sl} via_attr_tp=${diag.order_diag?.via_attr_tp} via_attr_sl=${diag.order_diag?.via_attr_sl} has_tp=${diag.order_diag?.has_tp_attr} has_sl=${diag.order_diag?.has_sl_attr} ticket=${diag.order_diag?.ticket_sample}`)
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
          const hcResult = await ai.mt5Bridge(hcUserId, 'history', { page: 1, page_size: 9999, compact: true })
          if (hcResult?.status === 'success' && Array.isArray(hcResult.orders)) {
            let orders = hcResult.orders
            // Apply filters (compact uses short keys: t=time, p=profit, y=type)
            if (params.close_from) orders = orders.filter(o => (o.t || '') >= params.close_from)
            if (params.close_to) orders = orders.filter(o => (o.t || '') <= params.close_to + 'T23:59:59')
            if (params.direction) orders = orders.filter(o => (o.y || '').toUpperCase() === params.direction)
            if (params.profit_filter === 'profit') orders = orders.filter(o => o.p > 0)
            if (params.profit_filter === 'loss') orders = orders.filter(o => o.p < 0)

            // Aggregate by close date
            const dailyMap = {}
            orders.forEach(o => {
              const d = (o.t || '').slice(0, 10)
              if (!d) return
              dailyMap[d] = (dailyMap[d] || 0) + o.p
            })
            const dates = Object.keys(dailyMap).sort()
            const daily = dates.map(d => ({ date: d, profit: Math.round(dailyMap[d] * 100) / 100 }))

            // Cumulative + drawdown
            let cum = 0, peak = 0, maxDD = 0
            const cumulative = []
            const drawdown = []
            daily.forEach(d => {
              cum += d.profit
              cum = Math.round(cum * 100) / 100
              cumulative.push(cum)
              if (cum > peak) peak = cum
              let dd = 0
              if (peak > 0) {
                // 从高点回落的百分比
                dd = Math.round((peak - cum) / peak * 10000) / 100
              } else if (cum < 0) {
                // 从未盈利过，亏损即回撤（以 1 为基数避免除零）
                dd = Math.round((-cum) * 100) / 100
              }
              drawdown.push(dd)
              if (dd > maxDD) maxDD = dd
            })

            // Win/loss stats
            const wins = orders.filter(o => o.p > 0)
            const losses = orders.filter(o => o.p < 0)
            const grossProfit = wins.reduce((s, o) => s + o.p, 0)
            const grossLoss = Math.abs(losses.reduce((s, o) => s + o.p, 0))

            result = {
              status: 'success',
              daily,
              cumulative,
              drawdown,
              stats: {
                total_trades: orders.length,
                win_rate: orders.length > 0 ? Math.round(wins.length / orders.length * 10000) / 100 : 0,
                profit_factor: grossLoss > 0 ? Math.round(grossProfit / grossLoss * 100) / 100 : grossProfit > 0 ? 999 : 0,
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
        const row = await ai.getActiveConfig(null, userId, params.session_id || 'default')
        const cfg = ai.configPublic(row)
        // Fill override defaults from global auto config when user hasn't customized
        if (cfg) {
          if (!cfg.auto_symbols || !cfg.auto_interval_minutes) {
            const globalAutoCfg = await ai.getGlobalAutoConfig()
            if (globalAutoCfg) {
              const defaultSyms = parseSymbols(globalAutoCfg.symbols)
              cfg.auto_symbols = cfg.auto_symbols || (defaultSyms[0] || 'XAUUSD')
              cfg.auto_interval_minutes = cfg.auto_interval_minutes ?? (globalAutoCfg.interval_minutes || 5)
            }
          }
        }
        result = { status: 'success', config: cfg }
        break
      }
      case 'save_config': {
        const cfg = params.config
        if (!cfg) return reply({ status: 'error', message: 'config required' })
        const now = localNow()
        await queryRun('UPDATE ai_configs SET is_active = 0 WHERE user_id = ? AND session_id = ?', [userId, params.session_id || 'default'])
        await queryRun(`INSERT INTO ai_configs(user_id, session_id, api_provider, api_key_encrypted, api_base_url, model_name,
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
          [userId, params.session_id || 'default', cfg.api_provider || 'deepseek', cfg.api_key || null,
            cfg.api_base_url || null, cfg.model_name || 'deepseek-chat', cfg.temperature || 0.7, cfg.max_tokens || 2000,
            cfg.enable_auto_trade ? 1 : 0, cfg.enable_futures_trading ? 1 : 0, cfg.risk_level || 'medium',
            cfg.max_position_size || 0.05, cfg.selected_take_profit || 1, cfg.model_sharing_enabled ? 1 : 0,
            cfg.auto_config_override ? 1 : 0,
            cfg.auto_symbols || null, cfg.auto_interval_minutes || null,
            cfg.system_prompt || null, now, now])
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
        const config = await ai.getActiveConfig(null, userId, params.session_id || 'default')
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
        const cfg = await ai.getCloseConfig(userId)
        result = { status: 'success', config: cfg || { enabled: false, check_interval_seconds: 30, model_name: 'deepseek-chat' } }
        break
      }
      case 'close_status': {
        // Report smart close scheduler status including pause reasons
        const closeCfg = await ai.getCloseConfig(userId)
        const enabled = !!(closeCfg?.enabled)
        const intervalSec = closeCfg?.check_interval_seconds || 30
        let paused = false
        let pauseReason = ''

        if (enabled) {
          // Check market status
          const tradeMode = getBridgeTradeMode(userId)
          if (tradeMode === 0) {
            paused = true
            pauseReason = 'market_closed'
          } else {
            // Check positions
            try {
              const posData = await sendBridgeCommand(userId, 'positions', {})
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

// Get cached trade_mode from bridge data push (-1 = unknown)
export function getBridgeTradeMode(userId) {
  const bridge = bridges.get(userId)
  if (!bridge || bridge.ws.readyState !== 1) return -1
  return typeof bridge.tradeMode === 'number' ? bridge.tradeMode : -1
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
