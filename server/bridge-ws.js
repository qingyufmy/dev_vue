import { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'
import { getDB } from './db.js'

const JWT_SECRET = process.env.JWT_SECRET || 'wall-street-skill-secret'

// Connected bridges: userId -> { ws, account, terminal, lastSeen, liveTradingEnabled }
const bridges = new Map()
// Pending commands: commandId -> { resolve, timer, userId }
const pendingCommands = new Map()
// Browser WebSocket clients for real-time status push
const statusClients = new Map() // ws -> { userId }

let cmdCounter = 0
let wss = null

export function initBridgeWS(server) {
  wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/aurum-api/bridge/ws')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    }
  })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost')
    const clientType = url.searchParams.get('type')

    // === Browser status subscriber + command channel ===
    if (clientType === 'browser') {
      const token = url.searchParams.get('token')
      let userId = null
      if (token) {
        try { userId = jwt.verify(token, JWT_SECRET).userId } catch {}
      }
      if (!userId) { ws.close(4002, 'Invalid token'); return }

      statusClients.set(ws, { userId })

      // Send current bridge status immediately
      const status = getBridgeStatus(userId)
      ws.send(JSON.stringify({ type: 'status', connected: status.connected, alive: status.alive }))

      // Handle commands from browser
      ws.on('message', (data) => {
        let msg
        try { msg = JSON.parse(data) } catch { return }
        if (msg.type === 'command' && msg.action) {
          handleBrowserCommand(ws, userId, msg)
        }
      })

      ws.on('close', () => statusClients.delete(ws))
      ws.on('error', () => statusClients.delete(ws))
      return
    }

    // === MT5 bridge client ===
    const token = url.searchParams.get('token')
    if (!token) { ws.close(4001, 'Missing token'); return }

    let userId
    try {
      userId = jwt.verify(token, JWT_SECRET).userId
    } catch { ws.close(4002, 'Invalid token'); return }

    bridges.set(userId, { ws, account: null, terminal: null, lastSeen: Date.now(), liveTradingEnabled: false })
    console.log(`[BridgeWS] User ${userId} connected`)
    ws.send(JSON.stringify({ type: 'connected', userId }))
    notifyBrowsers(userId, true)

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data) } catch { return }
      const bridge = bridges.get(userId)
      if (bridge) bridge.lastSeen = Date.now()

      if (msg.type === 'heartbeat') {
        if (bridge) {
          bridge.account = msg.account || null
          bridge.terminal = msg.terminal || null
          if (msg.live_trading_enabled !== undefined) bridge.liveTradingEnabled = msg.live_trading_enabled
        }
        ws.send(JSON.stringify({ type: 'heartbeat_ack' }))
      } else if (msg.type === 'result') {
        if (msg.result?.live_trading_enabled !== undefined && bridge) {
          bridge.liveTradingEnabled = msg.result.live_trading_enabled
        }
        const pending = pendingCommands.get(msg.command_id)
        if (pending) {
          clearTimeout(pending.timer)
          pending.resolve(msg.result)
          pendingCommands.delete(msg.command_id)
        }
      }
    })

    ws.on('close', () => {
      bridges.delete(userId)
      console.log(`[BridgeWS] User ${userId} disconnected`)
      notifyBrowsers(userId, false)
      for (const [cmdId, pending] of pendingCommands) {
        if (pending.userId === userId) {
          clearTimeout(pending.timer)
          pending.resolve({ status: 'error', error: 'Bridge disconnected' })
          pendingCommands.delete(cmdId)
        }
      }
    })

    ws.on('error', (err) => console.error(`[BridgeWS] Error for user ${userId}:`, err.message))
  })

  // Heartbeat for browser connections
  setInterval(() => {
    for (const [ws] of statusClients) {
      if (ws.readyState === 1) { try { ws.ping() } catch {} }
      else statusClients.delete(ws)
    }
  }, 30000)

  console.log('[BridgeWS] WebSocket bridge initialized on /aurum-api/bridge/ws')
  return wss
}

// Notify browser clients about bridge status change
function notifyBrowsers(userId, connected) {
  for (const [ws, info] of statusClients) {
    if (ws.readyState !== 1) { statusClients.delete(ws); continue }
    if (info.userId === userId) {
      try { ws.send(JSON.stringify({ type: 'status', connected, alive: connected })) } catch {}
    }
  }
}

// Handle browser WebSocket commands — route to existing business logic
async function handleBrowserCommand(ws, userId, msg) {
  const { command_id, action, params = {} } = msg
  const reply = (data) => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'result', command_id, ...data })) } catch {}
    }
  }

  try {
    // Dynamic import to avoid circular dependency issues (module is already cached)
    const ai = await import('./routes/ai.js')
    const db = getDB()
    const user = db.prepare('SELECT plan, role FROM users WHERE id = ?').get(userId)
    const isPro = user?.role === 'admin' || user?.plan === 'pro'
    if (!isPro) return reply({ status: 'error', message: '需要Pro会员' })

    let result
    switch (action) {
      // === MT5 Bridge commands ===
      case 'health': {
        const bridgeStatus = getBridgeStatus(userId)
        if (bridgeStatus.connected && bridgeStatus.alive) {
          result = { status: 'success', gateway: { mode: 'live', mt5_package_available: true, live_trading_enabled: !!bridgeStatus.liveTradingEnabled, account: bridgeStatus.account } }
        } else {
          result = { status: 'success', gateway: { mode: 'mock', mt5_package_available: true, live_trading_enabled: false } }
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
        ai.insertAudit(db, userId, 'manual_open', params.symbol, params, result, result?.status || 'unknown')
        break
      case 'close':
        result = await ai.mt5Bridge(userId, 'close', params)
        ai.insertAudit(db, userId, 'manual_close', null, params, result, result?.status || 'unknown')
        break
      case 'toggle_trade': {
        const enable = !!params.enable
        result = await ai.mt5Bridge(userId, 'toggle_trade', { enable })
        break
      }
      case 'history':
        result = await ai.mt5Bridge(userId, 'history', { page: params.page || 1, page_size: params.page_size || 20 })
        break
      case 'rates':
        result = await ai.mt5Bridge(userId, 'rates', { symbol: params.symbol, timeframe: params.timeframe || 'M30', count: params.count || 100 })
        break
      case 'diagnostics':
        result = await ai.mt5Bridge(userId, 'diagnostics', {})
        break
      case 'analyze':
        result = await ai.handleAnalyze(userId, params)
        break

      // === AI Config ===
      case 'ai_config': {
        const row = ai.getActiveConfig(db, userId, params.session_id || 'default')
        const isAdmin = user?.role === 'admin'
        result = { status: 'success', config: ai.configPublic(row, isAdmin) }
        break
      }
      case 'save_config': {
        const cfg = params.config
        if (!cfg) return reply({ status: 'error', message: 'config required' })
        const now = new Date().toISOString()
        if (user?.role !== 'admin') delete cfg.system_prompt
        db.prepare('UPDATE ai_configs SET is_active = 0 WHERE user_id = ? AND session_id = ?').run(userId, params.session_id || 'default')
        db.prepare(`INSERT INTO ai_configs(user_id, session_id, api_provider, api_key_encrypted, api_base_url, model_name,
          temperature, max_tokens, enable_auto_trade, enable_futures_trading, risk_level,
          max_position_size, selected_take_profit, system_prompt, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(user_id, session_id, api_provider) DO UPDATE SET
            api_key_encrypted = CASE WHEN excluded.api_key_encrypted IS NOT NULL THEN excluded.api_key_encrypted ELSE ai_configs.api_key_encrypted END,
            api_base_url = excluded.api_base_url, model_name = excluded.model_name, temperature = excluded.temperature,
            max_tokens = excluded.max_tokens, enable_auto_trade = excluded.enable_auto_trade,
            enable_futures_trading = excluded.enable_futures_trading, risk_level = excluded.risk_level,
            max_position_size = excluded.max_position_size, selected_take_profit = excluded.selected_take_profit,
            system_prompt = excluded.system_prompt, is_active = 1, updated_at = excluded.updated_at`
        ).run(userId, params.session_id || 'default', cfg.api_provider || 'deepseek', cfg.api_key || null,
          cfg.api_base_url || null, cfg.model_name || 'deepseek-chat', cfg.temperature || 0.7, cfg.max_tokens || 2000,
          cfg.enable_auto_trade ? 1 : 0, cfg.enable_futures_trading ? 1 : 0, cfg.risk_level || 'medium',
          cfg.max_position_size || 0.05, cfg.selected_take_profit || 1, cfg.system_prompt || ai.DEFAULT_PROMPT, now, now)
        const row = ai.getActiveConfig(db, userId, params.session_id || 'default', cfg.api_provider)
        result = { status: 'success', config: ai.configPublic(row) }
        break
      }

      // === AI Signals ===
      case 'signals': {
        const rows = db.prepare('SELECT * FROM ai_signals WHERE user_id = ? AND session_id = ? ORDER BY id DESC LIMIT 100').all(userId, params.session_id || 'default')
        const signals = rows.map(row => {
          const item = { ...row }
          try { item.market_data = JSON.parse(item.market_data_json) } catch { item.market_data = {} }
          delete item.market_data_json
          item.is_executed = !!item.is_executed
          ai.attachSignalTiming(item)
          return item
        })
        result = { status: 'success', signals }
        break
      }
      case 'execute': {
        const signal = db.prepare('SELECT * FROM ai_signals WHERE id = ? AND user_id = ?').get(params.signal_id, userId)
        if (!signal) return reply({ status: 'error', message: 'Signal not found' })
        const config = ai.getActiveConfig(db, userId, params.session_id || 'default')
        const timedSignal = ai.attachSignalTiming({ ...signal })
        if (timedSignal.is_stale) {
          result = { status: 'rejected', message: 'signal_expired', details: { age_seconds: timedSignal.age_seconds, ttl_seconds: timedSignal.ttl_seconds } }
          ai.insertAudit(db, userId, 'ai_execute', signal.symbol, params, result, result.status)
          break
        }
        const marketData = JSON.parse(signal.market_data_json || '{}')
        const orderPayload = ai.signalOrderPayload(signal, config, marketData, params.confirm)
        result = await ai.mt5Bridge(userId, 'open', orderPayload)
        if (result.status === 'success') {
          db.prepare('UPDATE ai_signals SET is_executed = 1, executed_at = ?, trade_ticket = ? WHERE id = ?').run(new Date().toISOString(), result.ticket || null, signal.id)
        }
        ai.insertAudit(db, userId, 'ai_execute', signal.symbol, { signal_id: params.signal_id, confirm: params.confirm }, result, result.status)
        break
      }

      // === Auto Scheduler ===
      case 'auto_status': {
        const cfg = ai.getAutoConfig(db, userId)
        const symbols = cfg?.symbols ? JSON.parse(cfg.symbols) : []
        const timeframes = cfg?.timeframes ? JSON.parse(cfg.timeframes) : []
        result = { status: 'success', scheduler: { enabled: !!cfg?.enabled, symbols, timeframes, interval_seconds: cfg?.interval_seconds || 900, running: !!cfg?.enabled } }
        break
      }
      case 'save_auto': {
        const { symbols = ['XAUUSD'], timeframes = [] } = params
        const enabled = timeframes.length > 0
        const shortestMs = timeframes.length ? Math.min(...timeframes.map(ai.timeframeIntervalMs)) : 900_000
        const interval_seconds = Math.round(shortestMs / 1000)
        ai.upsertAutoConfig(db, userId, symbols, timeframes, interval_seconds, enabled)
        // Restart scheduler
        ai.stopAutoScheduler(userId)
        if (enabled) ai.startAutoScheduler(userId)
        result = { status: 'success', message: enabled ? '自动推理已开启' : '自动推理已关闭', enabled, symbols, timeframes, interval_seconds }
        break
      }

      // === Audit ===
      case 'audit_logs': {
        const rows = db.prepare('SELECT * FROM trade_audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(userId)
        const logs = rows.map(row => {
          const item = { ...row }
          try { item.request = JSON.parse(item.request_json) } catch { item.request = {} }
          try { item.result = JSON.parse(item.result_json) } catch { item.result = {} }
          delete item.request_json
          delete item.result_json
          return item
        })
        result = { status: 'success', logs }
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
    const bridge = bridges.get(userId)
    if (!bridge || bridge.ws.readyState !== 1) {
      resolve({ status: 'error', error: 'Bridge not connected' })
      return
    }

    const heartbeatAge = Date.now() - bridge.lastSeen
    if (heartbeatAge > 20000) {
      try { bridge.ws.close() } catch {}
      bridges.delete(userId)
      notifyBrowsers(userId, false)
      resolve({ status: 'error', error: 'Bridge disconnected (heartbeat timeout)' })
      return
    }

    const cmdId = `cmd_${Date.now()}_${++cmdCounter}`
    const timer = setTimeout(() => {
      pendingCommands.delete(cmdId)
      resolve({ status: 'error', error: 'Bridge command timeout' })
    }, timeoutMs)

    pendingCommands.set(cmdId, { resolve, timer, userId })

    bridge.ws.send(JSON.stringify({ type: 'command', command_id: cmdId, action, params }))
  })
}

// Check if a user has an active bridge
export function isBridgeAlive(userId) {
  const bridge = bridges.get(userId)
  return bridge && bridge.ws.readyState === 1 && (Date.now() - bridge.lastSeen < 15000)
}

// Get bridge status for a user
export function getBridgeStatus(userId) {
  const bridge = bridges.get(userId)
  if (!bridge || bridge.ws.readyState !== 1) return { connected: false }
  return {
    connected: true,
    alive: Date.now() - bridge.lastSeen < 15000,
    account: bridge.account,
    terminal: bridge.terminal,
    lastSeen: bridge.lastSeen,
    liveTradingEnabled: bridge.liveTradingEnabled,
  }
}

// Get all connected bridges (for admin)
export function getAllBridges() {
  const result = []
  for (const [userId, bridge] of bridges) {
    result.push({
      userId,
      connected: bridge.ws.readyState === 1,
      alive: Date.now() - bridge.lastSeen < 15000,
      account: bridge.account,
      lastSeen: bridge.lastSeen,
      liveTradingEnabled: bridge.liveTradingEnabled,
    })
  }
  return result
}
