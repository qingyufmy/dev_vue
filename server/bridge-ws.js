import { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'
import { getDB, query, queryOne, queryAll, queryRun, logAudit } from './db.js'

const JWT_SECRET = process.env.JWT_SECRET || 'wall-street-skill-secret'

// Per-user state
const bridges = new Map()       // userId -> { ws, lastSeen }
const browsers = new Map()      // userId -> Set<ws>
const pendingCommands = new Map() // commandId -> { resolve, timer, userId }

let cmdCounter = 0
let wss = null

export function initBridgeWS(server) {
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
      // Heartbeat — reply with MT5 connection status
      const bridge = bridges.get(userId)
      const connected = !!(bridge && bridge.ws.readyState === 1)
      const alive = connected && (Date.now() - bridge.lastSeen < 20000)
      ws.send(JSON.stringify({
        type: 'hb',
        seq: msg.seq,
        mt5_connected: connected,
        mt5_alive: alive,
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
  bridges.set(userId, { ws, lastSeen: Date.now(), tradeEnabled: existing?.tradeEnabled ?? true }); ws._userId = userId
  console.log(`[BridgeWS] User ${userId} bridge connected`)

  // Notify browsers
  sendToBrowsers(userId, { type: 'hb', mt5_connected: true, mt5_alive: true })

  ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data) } catch(e) { return }

    const bridge = bridges.get(userId)
    if (bridge) bridge.lastSeen = Date.now()

    if (msg.type === 'data') {
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

  ws.on('close', () => {
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
  })

  ws.on('error', (err) => {
    console.error(`[BridgeWS] Bridge error for user ${userId}:`, err.message)
  })
}

// ============ Helpers ============

function sendToBrowsers(userId, data) {
  const set = browsers.get(userId)
  if (!set) return
  const json = JSON.stringify(data)
  for (const ws of set) {
    if (ws.readyState === 1) {
      try { ws.send(json) } catch {}
    } else {
      set.delete(ws)
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
    if (!isPro) return reply({ status: 'error', message: '需要Pro会员' })

    let result
    switch (action) {
      case 'health': {
        const bridge = bridges.get(userId)
        const connected = !!(bridge && bridge.ws.readyState === 1)
        const alive = connected && (Date.now() - bridge.lastSeen < 20000)
        result = {
          status: 'success',
          gateway: {
            mode: alive ? 'live' : 'mock',
            mt5_package_available: true,
            live_trading_enabled: alive && (bridge.tradeEnabled !== false),
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
      case 'history': {
        const bridgeOk = bridges.get(userId)?.ws?.readyState === 1
        if (bridgeOk) {
          result = await ai.mt5Bridge(userId, 'history', { page: params.page || 1, page_size: params.page_size || 20 })
        } else {
          result = { status: 'success', orders: [], statistics: { total_profit: 0, credit: 0, deposit: 0, withdrawal: 0, net_result: 0 } }
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
        result = { status: 'success', config: ai.configPublic(row) }
        break
      }
      case 'save_config': {
        const cfg = params.config
        if (!cfg) return reply({ status: 'error', message: 'config required' })
        const now = new Date().toISOString()
        await queryRun('UPDATE ai_configs SET is_active = 0 WHERE user_id = ? AND session_id = ?', [userId, params.session_id || 'default'])
        await queryRun(`INSERT INTO ai_configs(user_id, session_id, api_provider, api_key_encrypted, api_base_url, model_name,
          temperature, max_tokens, enable_auto_trade, enable_futures_trading, risk_level,
          max_position_size, selected_take_profit, model_sharing_enabled, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON DUPLICATE KEY UPDATE
            api_key_encrypted = CASE WHEN VALUES(api_key_encrypted) IS NOT NULL THEN VALUES(api_key_encrypted) ELSE ai_configs.api_key_encrypted END,
            api_base_url = VALUES(api_base_url), model_name = VALUES(model_name), temperature = VALUES(temperature),
            max_tokens = VALUES(max_tokens), enable_auto_trade = VALUES(enable_auto_trade),
            enable_futures_trading = VALUES(enable_futures_trading), risk_level = VALUES(risk_level),
            max_position_size = VALUES(max_position_size), selected_take_profit = VALUES(selected_take_profit),
            model_sharing_enabled = VALUES(model_sharing_enabled), is_active = 1, updated_at = VALUES(updated_at)`,
          [userId, params.session_id || 'default', cfg.api_provider || 'deepseek', cfg.api_key || null,
            cfg.api_base_url || null, cfg.model_name || 'deepseek-chat', cfg.temperature || 0.7, cfg.max_tokens || 2000,
            cfg.enable_auto_trade ? 1 : 0, cfg.enable_futures_trading ? 1 : 0, cfg.risk_level || 'medium',
            cfg.max_position_size || 0.05, cfg.selected_take_profit || 1, cfg.model_sharing_enabled ? 1 : 0, now, now])
        const row = await ai.getActiveConfig(null, userId, params.session_id || 'default', cfg.api_provider)
        result = { status: 'success', config: ai.configPublic(row) }
        break
      }
      case 'get_system_prompt': {
        const prompt = await ai.getSystemPrompt(null)
        result = { status: 'success', prompt }
        break
      }
      case 'save_system_prompt': {
        if (user?.role !== 'admin') return reply({ status: 'error', message: 'Admin only' })
        const prompt = params.prompt
        if (!prompt || typeof prompt !== 'string') return reply({ status: 'error', message: 'prompt required' })
        const now = new Date().toISOString()
        await queryRun('UPDATE system_prompts SET prompt = ?, updated_by = ?, updated_at = ?', [prompt, userId, now])
        result = { status: 'success', prompt }
        break
      }
      case 'signals': {
        const rows = await queryAll('SELECT * FROM ai_signals WHERE user_id = ? AND session_id = ? ORDER BY id DESC LIMIT 100', [userId, params.session_id || 'default'])
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
        const signal = await queryOne('SELECT * FROM ai_signals WHERE id = ? AND user_id = ?', [params.signal_id, userId])
        if (!signal) return reply({ status: 'error', message: 'Signal not found' })
        const config = await ai.getActiveConfig(null, userId, params.session_id || 'default')
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
          await queryRun('UPDATE ai_signals SET is_executed = 1, executed_at = ?, trade_ticket = ? WHERE id = ?', [new Date().toISOString(), result.ticket || null, signal.id])
        }
        await ai.insertAudit(null, userId, 'ai_execute', signal.symbol, { signal_id: params.signal_id, confirm: params.confirm }, result, result.status)
        break
      }
      case 'auto_status': {
        const cfg = await ai.getAutoConfig(null, userId)
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
        await ai.upsertAutoConfig(null, userId, symbols, timeframes, interval_seconds, enabled)
        ai.stopAutoScheduler(userId)
        if (enabled) await ai.startAutoScheduler(userId)
        result = { status: 'success', message: enabled ? '自动推理已开启' : '自动推理已关闭', enabled, symbols, timeframes, interval_seconds }
        break
      }
      case 'audit_logs': {
        const rows = await queryAll('SELECT * FROM trade_audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 100', [userId])
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
