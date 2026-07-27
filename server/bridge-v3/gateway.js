import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

import { queryOne } from '../db.js'
import { consumeBridgeConnectionTicket } from '../bridge-auth-session.js'
import {
  createCommandLedgerEntry,
  markCommandDeliveryUncertain,
  markCommandDispatched,
  recordCommandResult,
} from './command-ledger.js'
import { assertBridgeV3Message, sameBridgeRoute } from './protocol.js'
import {
  applyBridgeDataDelta,
  disconnectBridgeTerminalSessions,
  registerBridgeTerminalSession,
} from './read-model.js'

export const BRIDGE_V3_WS_PATH = '/aurum-api/bridge/v3/ws'
export const BRIDGE_V3_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
export const BRIDGE_V3_CONNECTION_STALE_MS = 45_000
const AUTH_QUEUE_MAX_MESSAGES = 16
const AUTH_QUEUE_MAX_BYTES = 1024 * 1024
const MAX_PENDING_QUOTES_PER_CONNECTION = 64
const MAX_PENDING_DATA_REQUESTS_PER_CONNECTION = 32
const REQUIRED_INITIAL_STREAMS = Object.freeze(['account', 'positions', 'orders'])
const BROKER_SYMBOL_SUFFIX_RE = /\.(a|s|c|pro|std|z|ecn|m|raw|mini)$/i

function messageId(prefix) {
  return `${prefix}_${randomUUID()}`
}

function byteLength(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8')
  if (Buffer.isBuffer(data) || ArrayBuffer.isView(data)) return data.byteLength
  if (data instanceof ArrayBuffer) return data.byteLength
  return Buffer.byteLength(String(data ?? ''), 'utf8')
}

function safeSend(ws, message) {
  if (ws?.readyState !== 1) return false
  try {
    ws.send(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}

function protocolError(ws, code, details = null, { closeCode = null } = {}) {
  safeSend(ws, {
    v:3,
    type:'error',
    message_id:messageId('error'),
    sent_at_utc_msc:Date.now(),
    error_code:code,
    details,
  })
  if (closeCode) {
    try { ws.close(closeCode, code) } catch {}
  }
}

function routeFromTerminal(terminal) {
  return {
    terminal_instance_id:terminal.terminal_instance_id,
    account_ref:terminal.account_ref,
    connection_epoch:terminal.connection_epoch,
  }
}

function sameBrokerSymbol(left, right) {
  const standard = value => String(value || '').replace(BROKER_SYMBOL_SUFFIX_RE, '').toUpperCase()
  return standard(left) === standard(right)
}

export function createBridgeV3Gateway({
  WebSocketServerImpl = WebSocketServer,
  consumeTicket = consumeBridgeConnectionTicket,
  queryOneFn = queryOne,
  registerTerminal = registerBridgeTerminalSession,
  disconnectTerminals = disconnectBridgeTerminalSessions,
  applyDelta = applyBridgeDataDelta,
  createLedgerEntry = createCommandLedgerEntry,
  markDispatched = markCommandDispatched,
  markUncertain = markCommandDeliveryUncertain,
  recordResult = recordCommandResult,
  onTerminalReady = async () => {},
  onTerminalDisconnected = async () => {},
  now = () => Date.now(),
} = {}) {
  const wss = new WebSocketServerImpl({ noServer:true, maxPayload:BRIDGE_V3_MAX_PAYLOAD_BYTES })
  const connectionsByTerminal = new Map()
  const pendingResults = new Map()
  const pendingQuotes = new Map()
  const pendingDataRequests = new Map()
  let connectionGeneration = 0
  const heartbeatStreams = new Set(['account', 'positions', 'orders', 'deals'])

  function gatewayError(code) {
    return Object.assign(new Error(code), { code })
  }

  function connectionAlive(connection) {
    return !connection.closed && connection.ready
      && now() - Number(connection.lastSeen || 0) <= BRIDGE_V3_CONNECTION_STALE_MS
  }

  function terminalInitialSyncReady(connection, terminalInstanceId) {
    const synchronizedStreams = connection.initialSnapshotStreams.get(terminalInstanceId)
    return REQUIRED_INITIAL_STREAMS.every(stream => synchronizedStreams?.has(stream))
  }

  function unregisterConnection(connection) {
    for (const terminal of connection.terminals.values()) {
      const current = connectionsByTerminal.get(terminal.terminal_instance_id)
      if (current?.connection === connection) {
        connectionsByTerminal.delete(terminal.terminal_instance_id)
        Promise.resolve(onTerminalDisconnected({
          userId:connection.userId,
          terminal:{ ...terminal },
          connectionGeneration:connection.generation,
        })).catch(() => {})
      }
    }
    if (connection.sessionId && connection.userId) {
      disconnectTerminals(connection.sessionId, connection.userId, { nowUtcMsc:now() }).catch(() => {})
    }
    for (const [commandId, pending] of pendingResults) {
      if (pending.connection !== connection) continue
      clearTimeout(pending.timer)
      pendingResults.delete(commandId)
      markUncertain(commandId, { reason:'bridge_disconnected', nowUtcMsc:now() })
        .then(({ command }) => pending.resolve({ status:'uncertain', command_id:commandId, evidence:command?.result || null }))
        .catch(error => pending.resolve({ status:'uncertain', command_id:commandId, error:error.code || error.message }))
    }
    for (const [requestId, pending] of pendingQuotes) {
      if (pending.connection !== connection) continue
      clearTimeout(pending.timer)
      pendingQuotes.delete(requestId)
      pending.reject(gatewayError('bridge_quote_disconnected'))
    }
    for (const [requestId, pending] of pendingDataRequests) {
      if (pending.connection !== connection) continue
      clearTimeout(pending.timer)
      pendingDataRequests.delete(requestId)
      pending.reject(gatewayError('bridge_data_request_disconnected'))
    }
  }

  async function authenticate(connection, url) {
    const ticket = url.searchParams.get('ticket')
    if (!ticket) throw Object.assign(new Error('bridge_ticket_required'), { code:'bridge_ticket_required' })
    const credential = await consumeTicket(ticket)
    const user = await queryOneFn(`SELECT id, role, plan, plan_source, plan_expires_at, token_version,
      (SELECT trade_send_enabled FROM user_bridge_settings WHERE user_id = users.id LIMIT 1) AS trade_send_enabled,
      (SELECT accounts.login_account FROM ai_observer_sources sources
        JOIN trading_accounts accounts ON accounts.id = sources.trading_account_id
          AND accounts.user_id = users.id AND accounts.is_deleted = 0
        WHERE sources.bridge_user_id = users.id AND sources.status = 'active' LIMIT 1) AS observer_login_account,
      (SELECT accounts.broker_server FROM ai_observer_sources sources
        JOIN trading_accounts accounts ON accounts.id = sources.trading_account_id
          AND accounts.user_id = users.id AND accounts.is_deleted = 0
        WHERE sources.bridge_user_id = users.id AND sources.status = 'active' LIMIT 1) AS observer_broker_server,
      (role = 'admin' OR (plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW()))) AS has_pro_access
      FROM users WHERE id = ? AND deletion_status = 'active' AND deleted_at IS NULL`, [credential.userId])
    if (!user || Number(user.token_version || 0) !== Number(credential.tokenVersion || 0)) {
      throw Object.assign(new Error('bridge_session_revoked'), { code:'bridge_session_revoked' })
    }
    if (Number(user.has_pro_access) !== 1) {
      throw Object.assign(new Error('bridge_membership_required'), { code:'bridge_membership_required' })
    }
    connection.userId = Number(user.id)
    connection.tradeEnabled = String(user.role || '').toLowerCase() === 'admin'
      ? user.trade_send_enabled == null || Number(user.trade_send_enabled) === 1
      : Number(user.trade_send_enabled) === 1
    connection.observerAccountRef = String(user.plan_source || '') === 'observer_source'
      && user.observer_login_account && user.observer_broker_server
      ? { login:String(user.observer_login_account), broker_server:String(user.observer_broker_server) }
      : null
    connection.authenticated = true
  }

  async function acceptHello(connection, message) {
    assertBridgeV3Message(message, { nowUtcMsc:now() })
    if (message.type !== 'hello') throw Object.assign(new Error('bridge_hello_required'), { code:'bridge_hello_required' })
    if (connection.ready) throw Object.assign(new Error('bridge_hello_duplicate'), { code:'bridge_hello_duplicate' })

    const accepted = []
    connection.sessionId = message.session_id
    try {
      for (const terminal of message.terminals) {
        if (connection.observerAccountRef
          && (String(terminal.account_ref.login).trim() !== connection.observerAccountRef.login.trim()
            || String(terminal.account_ref.broker_server).trim().toLowerCase()
              !== connection.observerAccountRef.broker_server.trim().toLowerCase())) {
          throw gatewayError('observer_source_account_mismatch')
        }
        await registerTerminal({
          userId:connection.userId,
          sessionId:message.session_id,
          terminalInstanceId:terminal.terminal_instance_id,
          platform:terminal.platform,
          brokerServer:terminal.account_ref.broker_server,
          login:terminal.account_ref.login,
          connectionEpoch:terminal.connection_epoch,
          clientVersion:terminal.worker_version || message.bridge_version,
          nowUtcMsc:now(),
        })
        connection.terminals.set(terminal.terminal_instance_id, terminal)
        connection.initialSnapshotStreams.set(terminal.terminal_instance_id, new Set())
        accepted.push(terminal.terminal_instance_id)
      }
    } catch (error) {
      await disconnectTerminals(message.session_id, connection.userId, { nowUtcMsc:now() }).catch(() => {})
      connection.terminals.clear()
      connection.sessionId = null
      throw error
    }
    connection.bridgeVersion = message.bridge_version
    connection.generation = ++connectionGeneration
    connection.lastSeen = now()
    connection.ready = true
    for (const terminal of connection.terminals.values()) {
      const previous = connectionsByTerminal.get(terminal.terminal_instance_id)
      if (previous && previous.connection !== connection) {
        protocolError(previous.connection.ws, 'bridge_connection_replaced', null, { closeCode:4001 })
      }
      connectionsByTerminal.set(terminal.terminal_instance_id, { connection, terminal })
    }
    safeSend(connection.ws, {
      v:3,
      type:'hello_ack',
      message_id:messageId('hello_ack'),
      sent_at_utc_msc:now(),
      acked_message_id:message.message_id,
      session_id:message.session_id,
      accepted_terminal_instance_ids:accepted,
    })
  }

  async function handleMessage(connection, raw) {
    let message
    try { message = JSON.parse(raw.toString()) } catch {
      throw Object.assign(new Error('bridge_json_invalid'), { code:'bridge_json_invalid' })
    }
    // Bridge 3.0.0 omitted nullable source_time_msc on the wire because its
    // serializer ignored nulls. Canonicalize queued messages created by that
    // build so an upgrade can drain the durable outbox without data loss.
    if (message?.type === 'data_delta'
      && !Object.prototype.hasOwnProperty.call(message, 'source_time_msc')) {
      message.source_time_msc = null
    }
    if (!connection.ready) return acceptHello(connection, message)
    assertBridgeV3Message(message, { nowUtcMsc:now() })

    if (message.type === 'heartbeat') {
      if (String(message.session_id || '') !== connection.sessionId) {
        throw Object.assign(new Error('bridge_heartbeat_session_mismatch'), { code:'bridge_heartbeat_session_mismatch' })
      }
      const receivedAt = now()
      if (message.terminals !== undefined && !Array.isArray(message.terminals)) {
        throw gatewayError('bridge_heartbeat_terminals_invalid')
      }
      for (const freshness of message.terminals || []) {
        const terminal = connection.terminals.get(String(freshness?.terminal_instance_id || ''))
        if (!terminal || Number(freshness?.connection_epoch) !== Number(terminal.connection_epoch)
          || !freshness.streams || typeof freshness.streams !== 'object'
          || Array.isArray(freshness.streams)) {
          throw gatewayError('bridge_heartbeat_terminal_route_invalid')
        }
        terminal.stream_observed_at_utc_msc ||= {}
        for (const [stream, rawObservedAt] of Object.entries(freshness.streams)) {
          const observedAt = Number(rawObservedAt)
          if (!heartbeatStreams.has(stream) || !Number.isSafeInteger(observedAt)
            || observedAt <= 0 || observedAt > receivedAt + 60_000) {
            throw gatewayError('bridge_heartbeat_stream_freshness_invalid')
          }
          terminal.stream_observed_at_utc_msc[stream] = Math.max(
            Number(terminal.stream_observed_at_utc_msc[stream] || 0), observedAt)
        }
      }
      connection.lastSeen = receivedAt
      return
    }

    const terminal = connection.terminals.get(message.terminal_instance_id)
    if (!terminal || !sameBridgeRoute(routeFromTerminal(terminal), message)) {
      throw Object.assign(new Error('bridge_message_route_mismatch'), { code:'bridge_message_route_mismatch' })
    }
    const activeRoute = connectionsByTerminal.get(message.terminal_instance_id)
    if (!activeRoute || activeRoute.connection !== connection) {
      throw gatewayError('bridge_connection_replaced')
    }
    connection.lastSeen = now()
    if (message.type === 'data_delta') {
      const wasInitialSyncReady = terminalInitialSyncReady(connection, message.terminal_instance_id)
      const result = await applyDelta(message, { userId:connection.userId, nowUtcMsc:now() })
      if (message.full_snapshot === true && ['applied', 'duplicate'].includes(result.status)
        && REQUIRED_INITIAL_STREAMS.includes(message.stream)) {
        connection.initialSnapshotStreams.get(message.terminal_instance_id)?.add(message.stream)
      }
      safeSend(connection.ws, {
        v:3,
        type:'data_ack',
        message_id:messageId('data_ack'),
        sent_at_utc_msc:now(),
        acked_message_id:message.message_id,
        terminal_instance_id:message.terminal_instance_id,
        connection_epoch:message.connection_epoch,
        stream:message.stream,
        revision:message.revision,
        status:result.status,
        expected_revision:result.expected_revision,
      })
      if (!wasInitialSyncReady && terminalInitialSyncReady(connection, message.terminal_instance_id)) {
        Promise.resolve(onTerminalReady({
          userId:connection.userId,
          terminal:{ ...terminal },
          connectionGeneration:connection.generation,
        })).catch(error => {
          console.warn(`[BridgeV3] terminal ready callback failed user=${connection.userId} error=${error.message}`)
        })
      }
      return
    }
    if (message.type === 'command_result') {
      const stored = await recordResult(message, { allowUncertainResolution:true, nowUtcMsc:now() })
      const pending = pendingResults.get(message.command_id)
      if (pending && pending.connection === connection) {
        clearTimeout(pending.timer)
        pendingResults.delete(message.command_id)
        pending.resolve(stored.command?.result || message)
      }
      safeSend(connection.ws, {
        v:3,
        type:'command_result_ack',
        message_id:messageId('command_result_ack'),
        sent_at_utc_msc:now(),
        acked_message_id:message.message_id,
        command_id:message.command_id,
        terminal_instance_id:message.terminal_instance_id,
        account_ref:message.account_ref,
        connection_epoch:message.connection_epoch,
        status:stored.duplicate ? 'duplicate' : 'applied',
      })
      return
    }
    if (message.type === 'quote') {
      const pending = pendingQuotes.get(message.request_id)
      if (!pending) return
      if (pending.connection !== connection || !sameBridgeRoute(pending.request, message)
        || !sameBrokerSymbol(pending.request.symbol, message.symbol)) {
        throw gatewayError('bridge_quote_response_mismatch')
      }
      clearTimeout(pending.timer)
      pendingQuotes.delete(message.request_id)
      pending.resolve(message)
      return
    }
    if (message.type === 'data_response') {
      const pending = pendingDataRequests.get(message.request_id)
      if (!pending) return
      if (pending.connection !== connection || !sameBridgeRoute(pending.request, message)
        || pending.request.action !== message.action
        || JSON.stringify(pending.request.params) !== JSON.stringify(message.params)) {
        throw gatewayError('bridge_data_response_mismatch')
      }
      clearTimeout(pending.timer)
      pendingDataRequests.delete(message.request_id)
      pending.resolve(message)
      return
    }
    throw Object.assign(new Error('bridge_message_type_unexpected'), { code:'bridge_message_type_unexpected' })
  }

  wss.on('connection', (ws, req) => {
    const connection = {
      ws,
      userId:null,
      authenticated:false,
      ready:false,
      sessionId:null,
      terminals:new Map(),
      initialSnapshotStreams:new Map(),
      closed:false,
      authQueue:[],
      authQueueBytes:0,
    }
    const url = new URL(req.url, 'http://localhost')
    const onMessage = raw => {
      if (!connection.authenticated) {
        const size = byteLength(raw)
        if (connection.authQueue.length >= AUTH_QUEUE_MAX_MESSAGES
          || connection.authQueueBytes + size > AUTH_QUEUE_MAX_BYTES) {
          connection.authQueue = []
          protocolError(ws, 'bridge_auth_queue_overflow', null, { closeCode:1009 })
          return
        }
        connection.authQueue.push(raw)
        connection.authQueueBytes += size
        return
      }
      handleMessage(connection, raw).catch(error => {
        const validation = Array.isArray(error.details) ? ` details=${error.details.join('|')}` : ''
        console.warn(`[BridgeV3] message rejected user=${connection.userId ?? 'unknown'} code=${error.code || 'bridge_message_rejected'}${validation}`)
        protocolError(ws, error.code || 'bridge_message_rejected', error.message, {
          closeCode:connection.ready ? null : 4002,
        })
      })
    }
    ws.on('message', onMessage)
    ws.on('close', () => {
      if (connection.closed) return
      connection.closed = true
      unregisterConnection(connection)
    })
    ws.on('error', () => {})

    authenticate(connection, url).then(async () => {
      const queued = connection.authQueue
      connection.authQueue = []
      connection.authQueueBytes = 0
      for (const raw of queued) {
        if (connection.closed) break
        try { await handleMessage(connection, raw) } catch (error) {
          const validation = Array.isArray(error.details) ? ` details=${error.details.join('|')}` : ''
          console.warn(`[BridgeV3] queued message rejected user=${connection.userId ?? 'unknown'} code=${error.code || 'bridge_message_rejected'}${validation}`)
          protocolError(ws, error.code || 'bridge_message_rejected', error.message, {
            closeCode:connection.ready ? null : 4002,
          })
          break
        }
      }
    }).catch(error => {
      console.warn(`[BridgeV3] authentication rejected code=${error.code || 'bridge_auth_failed'}`)
      protocolError(ws, error.code || 'bridge_auth_failed', null, { closeCode:4002 })
    })
  })

  async function sendCommand(userId, command, { timeoutMs = 5_000 } = {}) {
    const nowUtcMsc = now()
    assertBridgeV3Message(command, { nowUtcMsc })
    if (command.type !== 'command') throw Object.assign(new Error('bridge_command_type_invalid'), { code:'bridge_command_type_invalid' })
    const ledger = await createLedgerEntry(command, { userId:Number(userId), nowUtcMsc })
    if (!['queued'].includes(ledger.command.status)) {
      return ledger.command.result
        ? { ...ledger.command.result, duplicate:true }
        : { status:ledger.command.status, command_id:command.command_id, duplicate:true }
    }

    const routed = connectionsByTerminal.get(command.terminal_instance_id)
    if (!routed || !connectionAlive(routed.connection) || routed.connection.userId !== Number(userId)
      || !sameBridgeRoute(routeFromTerminal(routed.terminal), command)) {
      return { status:'queued', command_id:command.command_id, error:'bridge_terminal_not_connected' }
    }
    if (command.action !== 'query_execution'
      && !terminalInitialSyncReady(routed.connection, command.terminal_instance_id)) {
      return { status:'queued', command_id:command.command_id, error:'bridge_terminal_initial_sync_pending' }
    }
    await markDispatched(command.command_id, {
      connectionEpoch:command.connection_epoch,
      nowUtcMsc,
    })

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pendingResults.delete(command.command_id)
        markUncertain(command.command_id, { reason:'bridge_result_timeout', nowUtcMsc:now() })
          .then(({ command:stored }) => resolve({ status:'uncertain', command_id:command.command_id,
            evidence:stored?.result || null }))
          .catch(error => resolve({ status:'uncertain', command_id:command.command_id,
            error:error.code || error.message }))
      }, timeoutMs)
      pendingResults.set(command.command_id, { resolve, timer, connection:routed.connection })
      if (!safeSend(routed.connection.ws, command)) {
        clearTimeout(timer)
        pendingResults.delete(command.command_id)
        markUncertain(command.command_id, { reason:'bridge_send_failed', nowUtcMsc:now() })
          .then(() => resolve({ status:'uncertain', command_id:command.command_id, error:'bridge_send_failed' }))
          .catch(error => resolve({ status:'uncertain', command_id:command.command_id,
            error:error.code || error.message }))
      }
    })
  }

  function requestQuote(userId, request, { timeoutMs = 2_000 } = {}) {
    assertBridgeV3Message(request, { nowUtcMsc:now() })
    if (request.type !== 'quote_request') throw gatewayError('bridge_quote_request_type_invalid')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw gatewayError('bridge_quote_timeout_invalid')
    }
    if (pendingQuotes.has(request.request_id)) throw gatewayError('bridge_quote_request_duplicate')

    const routed = connectionsByTerminal.get(request.terminal_instance_id)
    if (!routed || !connectionAlive(routed.connection) || routed.connection.userId !== Number(userId)
      || !sameBridgeRoute(routeFromTerminal(routed.terminal), request)) {
      throw gatewayError('bridge_terminal_not_connected')
    }
    let connectionPending = 0
    for (const pending of pendingQuotes.values()) {
      if (pending.connection === routed.connection) connectionPending += 1
    }
    if (connectionPending >= MAX_PENDING_QUOTES_PER_CONNECTION) {
      throw gatewayError('bridge_quote_capacity_exceeded')
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingQuotes.delete(request.request_id)
        reject(gatewayError('bridge_quote_timeout'))
      }, timeoutMs)
      pendingQuotes.set(request.request_id, { resolve, reject, timer, connection:routed.connection, request })
      if (!safeSend(routed.connection.ws, request)) {
        clearTimeout(timer)
        pendingQuotes.delete(request.request_id)
        reject(gatewayError('bridge_quote_send_failed'))
      }
    })
  }

  function requestData(userId, request, { timeoutMs = 15_000 } = {}) {
    assertBridgeV3Message(request, { nowUtcMsc:now() })
    if (request.type !== 'data_request') throw gatewayError('bridge_data_request_type_invalid')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw gatewayError('bridge_data_request_timeout_invalid')
    }
    if (pendingDataRequests.has(request.request_id)) throw gatewayError('bridge_data_request_duplicate')
    const routed = connectionsByTerminal.get(request.terminal_instance_id)
    if (!routed || !connectionAlive(routed.connection) || routed.connection.userId !== Number(userId)
      || !sameBridgeRoute(routeFromTerminal(routed.terminal), request)) {
      throw gatewayError('bridge_terminal_not_connected')
    }
    let connectionPending = 0
    for (const pending of pendingDataRequests.values()) {
      if (pending.connection === routed.connection) connectionPending += 1
    }
    if (connectionPending >= MAX_PENDING_DATA_REQUESTS_PER_CONNECTION) {
      throw gatewayError('bridge_data_request_capacity_exceeded')
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingDataRequests.delete(request.request_id)
        reject(gatewayError('bridge_data_request_timeout'))
      }, timeoutMs)
      pendingDataRequests.set(request.request_id, {
        resolve, reject, timer, connection:routed.connection, request,
      })
      if (!safeSend(routed.connection.ws, request)) {
        clearTimeout(timer)
        pendingDataRequests.delete(request.request_id)
        reject(gatewayError('bridge_data_request_send_failed'))
      }
    })
  }

  function listConnectedTerminals(userId) {
    const result = []
    for (const { connection, terminal } of connectionsByTerminal.values()) {
      if (connection.userId !== Number(userId) || !connectionAlive(connection)) continue
      result.push({
        terminal_instance_id:terminal.terminal_instance_id,
        platform:terminal.platform,
        account_ref:{ ...terminal.account_ref },
        connection_epoch:terminal.connection_epoch,
        initial_sync_ready:terminalInitialSyncReady(connection, terminal.terminal_instance_id),
        connection_generation:connection.generation,
        last_seen_at_utc_msc:connection.lastSeen,
        stream_observed_at_utc_msc:{ ...(terminal.stream_observed_at_utc_msc || {}) },
      })
    }
    return result
  }

  function listConnectedUsers() {
    const users = new Map()
    for (const { connection } of connectionsByTerminal.values()) {
      if (connection.closed || !connection.ready) continue
      const current = users.get(connection.userId)
      const alive = connectionAlive(connection)
      users.set(connection.userId, {
        userId:Number(connection.userId),
        connected:true,
        alive:Boolean(current?.alive) || alive,
        lastSeen:Math.max(Number(current?.lastSeen || 0), Number(connection.lastSeen || 0)),
        generation:alive
          ? (current?.alive
              ? Math.max(Number(current.generation || 0), Number(connection.generation || 0))
              : Number(connection.generation || 0))
          : Number(current?.generation || connection.generation || 0),
      })
    }
    return Array.from(users.values())
  }

  function isTradeEnabled(userId) {
    for (const { connection } of connectionsByTerminal.values()) {
      if (connection.userId === Number(userId) && connectionAlive(connection)) {
        return connection.tradeEnabled === true
      }
    }
    return false
  }

  function setTradeEnabled(userId, enabled) {
    let changed = false
    for (const { connection } of connectionsByTerminal.values()) {
      if (connection.userId !== Number(userId) || !connectionAlive(connection)) continue
      connection.tradeEnabled = enabled === true
      changed = true
    }
    return changed
  }

  function disconnectUser(userId, reason = 'bridge_session_revoked') {
    const connections = new Set()
    for (const { connection } of connectionsByTerminal.values()) {
      if (connection.userId === Number(userId) && !connection.closed) connections.add(connection)
    }
    for (const connection of connections) {
      connection.tradeEnabled = false
      protocolError(connection.ws, reason, null, { closeCode:4004 })
    }
    return connections.size
  }

  return {
    wss,
    connectionsByTerminal,
    pendingQuotes,
    pendingDataRequests,
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    },
    sendCommand,
    requestQuote,
    requestData,
    listConnectedTerminals,
    listConnectedUsers,
    isTradeEnabled,
    setTradeEnabled,
    disconnectUser,
  }
}
