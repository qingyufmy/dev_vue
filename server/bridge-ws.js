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

    // === Browser status subscriber ===
    if (clientType === 'browser') {
      const token = url.searchParams.get('token')
      let userId = null
      if (token) {
        try { userId = jwt.verify(token, JWT_SECRET).userId } catch {}
      }
      statusClients.set(ws, { userId })
      // Send current status immediately
      if (userId) {
        const status = getBridgeStatus(userId)
        ws.send(JSON.stringify({ type: 'status', connected: status.connected, alive: status.alive }))
      }
      ws.on('close', () => statusClients.delete(ws))
      ws.on('error', () => statusClients.delete(ws))
      return
    }

    // === MT5 bridge client ===
    const token = url.searchParams.get('token')
    if (!token) {
      ws.close(4001, 'Missing token')
      return
    }

    let userId
    try {
      const decoded = jwt.verify(token, JWT_SECRET)
      userId = decoded.userId
    } catch {
      ws.close(4002, 'Invalid token')
      return
    }

    // Store bridge connection
    bridges.set(userId, { ws, account: null, terminal: null, lastSeen: Date.now(), liveTradingEnabled: false })
    console.log(`[BridgeWS] User ${userId} connected`)

    // Send welcome message
    ws.send(JSON.stringify({ type: 'connected', userId }))

    // Notify browser clients: bridge connected
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
      // Notify browser clients: bridge disconnected
      notifyBrowsers(userId, false)
      // Reject all pending commands for this user
      for (const [cmdId, pending] of pendingCommands) {
        if (pending.userId === userId) {
          clearTimeout(pending.timer)
          pending.resolve({ status: 'error', error: 'Bridge disconnected' })
          pendingCommands.delete(cmdId)
        }
      }
    })

    ws.on('error', (err) => {
      console.error(`[BridgeWS] Error for user ${userId}:`, err.message)
    })
  })

  // Heartbeat for browser connections
  setInterval(() => {
    for (const [ws] of statusClients) {
      if (ws.readyState === 1) {
        try { ws.ping() } catch {}
      } else {
        statusClients.delete(ws)
      }
    }
  }, 30000)

  console.log('[BridgeWS] WebSocket bridge initialized on /aurum-api/bridge/ws')
  return wss
}

// Notify browser clients about bridge status change
function notifyBrowsers(userId, connected) {
  for (const [ws, info] of statusClients) {
    if (ws.readyState !== 1) { statusClients.delete(ws); continue }
    // Send to the matching user, or to all if userId matches
    if (info.userId === userId) {
      try { ws.send(JSON.stringify({ type: 'status', connected, alive: connected })) } catch {}
    }
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

    // Fast-fail: if bridge heartbeat is stale (>20s), don't wait for timeout
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

    bridge.ws.send(JSON.stringify({
      type: 'command',
      command_id: cmdId,
      action,
      params,
    }))
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
  if (!bridge || bridge.ws.readyState !== 1) {
    return { connected: false }
  }
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
