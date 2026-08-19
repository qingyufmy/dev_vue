import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { WebSocketServer } from 'ws'

import { queryOne } from '../db.js'
import { consumeBridgeConnectionTicket } from '../bridge-auth-session.js'
import {
  createCommandLedgerEntry,
  expireQueuedCommands,
  markCommandDeliveryUncertain,
  markCommandDispatched,
  recordCommandResult,
  countOutstandingCommands,
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
export const BRIDGE_V3_TRANSPORT_PING_TIMEOUT_MS = BRIDGE_V3_CONNECTION_STALE_MS
export const BRIDGE_V3_ELIGIBILITY_RECHECK_MS = 30_000
// One native outbox pump can enqueue up to 200 records. Keep one complete
// recovery batch admissible while retaining a hard per-connection ceiling.
export const BRIDGE_V3_INBOUND_QUEUE_MAX_MESSAGES = 256
export const BRIDGE_V3_INBOUND_QUEUE_MAX_BYTES = 8 * 1024 * 1024
const AUTH_QUEUE_MAX_MESSAGES = 16
const AUTH_QUEUE_MAX_BYTES = 1024 * 1024
const INBOUND_QUEUE_PAUSE_MESSAGES = 192
const INBOUND_QUEUE_RESUME_MESSAGES = 64
const INBOUND_QUEUE_PAUSE_BYTES = 6 * 1024 * 1024
const INBOUND_QUEUE_RESUME_BYTES = 2 * 1024 * 1024
const MAX_PENDING_QUOTES_PER_CONNECTION = 64
const MAX_PENDING_DATA_REQUESTS_PER_CONNECTION = 32
const TRANSPORT_PING_INTERVAL_MS = 10_000
const REQUIRED_INITIAL_STREAMS = Object.freeze(['account', 'positions', 'orders'])
const RELEASE_NOTICE_MINIMUM_BRIDGE_VERSION = Object.freeze([3, 1, 2])
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

function supportsReleaseNotice(version) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(version || ''))
  if (!match) return false
  const parts = [Number(match[1]), Number(match[2]), Number(match[3] || 0)]
  for (let index = 0; index < RELEASE_NOTICE_MINIMUM_BRIDGE_VERSION.length; index++) {
    if (parts[index] !== RELEASE_NOTICE_MINIMUM_BRIDGE_VERSION[index]) {
      return parts[index] > RELEASE_NOTICE_MINIMUM_BRIDGE_VERSION[index]
    }
  }
  return true
}

export function createBridgeV3Gateway({
  WebSocketServerImpl = WebSocketServer,
  consumeTicket = consumeBridgeConnectionTicket,
  queryOneFn = queryOne,
  registerTerminal = registerBridgeTerminalSession,
  disconnectTerminals = disconnectBridgeTerminalSessions,
  applyDelta = applyBridgeDataDelta,
  createLedgerEntry = createCommandLedgerEntry,
  expireQueued = expireQueuedCommands,
  markDispatched = markCommandDispatched,
  markUncertain = markCommandDeliveryUncertain,
  recordResult = recordCommandResult,
  countOutstanding = countOutstandingCommands,
  onTerminalRouteInvalidated = async () => {},
  onTerminalReady = async () => {},
  onTerminalDisconnected = async () => {},
  onDataDelta = async () => {},
  now = () => Date.now(),
} = {}) {
  const wss = new WebSocketServerImpl({ noServer:true, maxPayload:BRIDGE_V3_MAX_PAYLOAD_BYTES })
  const connectionsByTerminal = new Map()
  const pendingResults = new Map()
  const pendingQuotes = new Map()
  const pendingDataRequests = new Map()
  const maintenanceByTerminal = new Map()
  const maintenanceLeases = new Map()
  const activeCommandAdmissions = new Map()
  let connectionGeneration = 0
  const heartbeatStreams = new Set(['account', 'positions', 'orders', 'deals'])

  function gatewayError(code) {
    return Object.assign(new Error(code), { code })
  }

  function tradeEnabledForUser(user) {
    return String(user?.role || '').toLowerCase() === 'admin'
      ? user?.trade_send_enabled == null || Number(user.trade_send_enabled) === 1
      : Number(user?.trade_send_enabled) === 1
  }

  function sessionCloseCode(errorCode, ready) {
    if (!ready) return 4002
    return ['bridge_membership_required', 'bridge_session_revoked', 'observer_source_binding_changed'].includes(errorCode)
      ? 4004
      : null
  }

  function activeCommandCount(terminalInstanceIds) {
    return terminalInstanceIds.reduce(
      (total, terminalId) => total + Number(activeCommandAdmissions.get(terminalId) || 0),
      0,
    )
  }

  function releaseLeaseInternal(lease) {
    if (!lease) return false
    if (lease.timer) clearTimeout(lease.timer)
    maintenanceLeases.delete(lease.lease_id)
    for (const terminalId of lease.terminal_instance_ids) {
      if (maintenanceByTerminal.get(terminalId)?.lease_id === lease.lease_id) {
        maintenanceByTerminal.delete(terminalId)
      }
    }
    return true
  }

  function purgeExpiredLeases() {
    const current = now()
    for (const lease of maintenanceLeases.values()) {
      if (lease.expires_at_utc_msc <= current) releaseLeaseInternal(lease)
    }
  }

  function scheduleLeaseExpiry(lease) {
    if (lease.timer) clearTimeout(lease.timer)
    lease.timer = setTimeout(() => releaseLeaseInternal(lease),
      Math.max(1, lease.expires_at_utc_msc - now()))
    lease.timer.unref?.()
  }

  function maintenanceBlock(terminalInstanceId) {
    purgeExpiredLeases()
    return maintenanceByTerminal.get(terminalInstanceId) || null
  }

  function connectionAlive(connection) {
    return !connection.closed && connection.ready
      && now() - Number(connection.lastSeen || 0) <= BRIDGE_V3_CONNECTION_STALE_MS
  }

  function resumeInboundSocket(connection) {
    if (!connection?.inboundSocketPaused) return
    connection.inboundSocketPaused = false
    try { connection.ws?._socket?.resume?.() } catch {}
  }

  function adjustInboundSocketFlow(connection) {
    if (!connection || connection.closed || connection.inboundStopped) return
    const processingSize = connection.inboundProcessing?.size || 0
    const processingCount = connection.inboundProcessing ? 1 : 0
    const totalMessages = connection.inboundQueue.length + processingCount
    const totalBytes = connection.inboundQueueBytes + processingSize
    if (!connection.inboundSocketPaused
      && (totalMessages >= INBOUND_QUEUE_PAUSE_MESSAGES || totalBytes >= INBOUND_QUEUE_PAUSE_BYTES)) {
      try {
        if (typeof connection.ws?._socket?.pause === 'function') {
          connection.ws._socket.pause()
          connection.inboundSocketPaused = true
        }
      } catch {}
    } else if (connection.inboundSocketPaused
      && totalMessages <= INBOUND_QUEUE_RESUME_MESSAGES && totalBytes <= INBOUND_QUEUE_RESUME_BYTES) {
      resumeInboundSocket(connection)
    }
  }

  function clearInboundQueueReferences(connection) {
    if (!connection) return
    connection.authQueue = []
    connection.authQueueBytes = 0
    connection.inboundQueue = []
    connection.inboundQueueBytes = 0
    connection.inboundProcessing = null
    resumeInboundSocket(connection)
  }

  function closeConnection(connection, code, details = null, closeCode = null) {
    if (!connection || connection.closed) return false
    connection.closed = true
    connection.inboundStopped = true
    clearInboundQueueReferences(connection)
    protocolError(connection.ws, code, details, { closeCode })
    unregisterConnection(connection)
    return true
  }

  function closeTransportPingTimeout(connection) {
    if (!connection || connection.closed) return false
    connection.closed = true
    connection.inboundStopped = true
    clearInboundQueueReferences(connection)
    connection.pingOutstandingAt = 0
    try {
      if (typeof connection.ws.terminate === 'function') connection.ws.terminate()
      else connection.ws.close(1001, 'bridge_ping_timeout')
    } catch {}
    unregisterConnection(connection)
    return true
  }

  function terminalInitialSyncReady(connection, terminalInstanceId) {
    const synchronizedStreams = connection.initialSnapshotStreams.get(terminalInstanceId)
    return REQUIRED_INITIAL_STREAMS.every(stream => synchronizedStreams?.has(stream))
  }

  function unregisterConnection(connection) {
    if (connection.pingInterval) clearInterval(connection.pingInterval)
    if (connection.pingTimeoutTimer) clearTimeout(connection.pingTimeoutTimer)
    connection.pingTimeoutTimer = null
    clearInboundQueueReferences(connection)
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
      (SELECT connection_enabled FROM user_bridge_settings WHERE user_id = users.id LIMIT 1) AS connection_enabled,
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
    if (user.connection_enabled != null && Number(user.connection_enabled) !== 1) {
      throw Object.assign(new Error('bridge_runtime_paused'), { code:'bridge_runtime_paused' })
    }
    connection.userId = Number(user.id)
    connection.tokenVersion = Number(credential.tokenVersion || 0)
    connection.nextEligibilityCheckAt = now() + BRIDGE_V3_ELIGIBILITY_RECHECK_MS
    connection.tradeEnabled = tradeEnabledForUser(user)
    connection.observerAccountRef = String(user.plan_source || '') === 'observer_source'
      && user.observer_login_account && user.observer_broker_server
      ? { login:String(user.observer_login_account), broker_server:String(user.observer_broker_server) }
      : null
    connection.authenticated = true
  }

  async function revalidateConnectionEligibility(connection, checkedAt) {
    if (checkedAt < Number(connection.nextEligibilityCheckAt || 0)) return
    // Reserve the next slot before awaiting MySQL so concurrent heartbeats do
    // not turn one connection into multiple entitlement queries.
    connection.nextEligibilityCheckAt = checkedAt + BRIDGE_V3_ELIGIBILITY_RECHECK_MS
    let user
    try {
      user = await queryOneFn(`SELECT id, role, plan_source, token_version,
        (SELECT trade_send_enabled FROM user_bridge_settings WHERE user_id = users.id LIMIT 1) AS trade_send_enabled,
        (SELECT connection_enabled FROM user_bridge_settings WHERE user_id = users.id LIMIT 1) AS connection_enabled,
        (SELECT accounts.login_account FROM ai_observer_sources sources
          JOIN trading_accounts accounts ON accounts.id = sources.trading_account_id
            AND accounts.user_id = users.id AND accounts.is_deleted = 0
          WHERE sources.bridge_user_id = users.id AND sources.status = 'active' LIMIT 1) AS observer_login_account,
        (SELECT accounts.broker_server FROM ai_observer_sources sources
          JOIN trading_accounts accounts ON accounts.id = sources.trading_account_id
            AND accounts.user_id = users.id AND accounts.is_deleted = 0
          WHERE sources.bridge_user_id = users.id AND sources.status = 'active' LIMIT 1) AS observer_broker_server,
        (role = 'admin' OR (plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW()))) AS has_pro_access
        FROM users WHERE id = ? AND deletion_status = 'active' AND deleted_at IS NULL`, [connection.userId])
    } catch {
      // A temporary database outage must not revoke a valid device session.
      // The next heartbeat window will retry the authoritative check.
      return
    }
    if (!user || Number(user.token_version || 0) !== Number(connection.tokenVersion || 0)) {
      throw gatewayError('bridge_session_revoked')
    }
    if (Number(user.has_pro_access) !== 1) {
      connection.tradeEnabled = false
      throw gatewayError('bridge_membership_required')
    }
    if (user.connection_enabled != null && Number(user.connection_enabled) !== 1) {
      connection.tradeEnabled = false
      throw gatewayError('bridge_runtime_paused')
    }
    const planSource = String(user.plan_source || '')
    if (planSource === 'observer_source') {
      const currentRef = user.observer_login_account && user.observer_broker_server
        ? { login:String(user.observer_login_account), broker_server:String(user.observer_broker_server) }
        : null
      if (!currentRef || !connection.observerAccountRef
        || currentRef.login.trim() !== connection.observerAccountRef.login.trim()
        || currentRef.broker_server.trim().toLowerCase()
          !== connection.observerAccountRef.broker_server.trim().toLowerCase()) {
        connection.tradeEnabled = false
        throw gatewayError('observer_source_binding_changed')
      }
    } else if (connection.observerAccountRef) {
      connection.tradeEnabled = false
      throw gatewayError('observer_source_binding_changed')
    }
    connection.tradeEnabled = tradeEnabledForUser(user)
  }

  async function acceptHello(connection, message) {
    assertBridgeV3Message(message, { nowUtcMsc:now() })
    if (message.type !== 'hello') throw Object.assign(new Error('bridge_hello_required'), { code:'bridge_hello_required' })
    if (connection.ready) throw Object.assign(new Error('bridge_hello_duplicate'), { code:'bridge_hello_duplicate' })

    const accepted = []
    const registrations = []
    connection.sessionId = message.session_id
    try {
      for (const terminal of message.terminals) {
        if (connection.observerAccountRef
          && (String(terminal.account_ref.login).trim() !== connection.observerAccountRef.login.trim()
            || String(terminal.account_ref.broker_server).trim().toLowerCase()
              !== connection.observerAccountRef.broker_server.trim().toLowerCase())) {
          throw gatewayError('observer_source_account_mismatch')
        }
        const registration = await registerTerminal({
          userId:connection.userId,
          sessionId:message.session_id,
          terminalInstanceId:terminal.terminal_instance_id,
          platform:terminal.platform,
          brokerServer:terminal.account_ref.broker_server,
          login:terminal.account_ref.login,
          connectionEpoch:terminal.connection_epoch,
          clientVersion:terminal.worker_version || message.bridge_version,
          bridgeVersion:message.bridge_version,
          installationId:message.installation_id || null,
          updateReport:message.update_report || null,
          nowUtcMsc:now(),
        })
        connection.terminals.set(terminal.terminal_instance_id, terminal)
        connection.initialSnapshotStreams.set(terminal.terminal_instance_id, new Set())
        accepted.push(terminal.terminal_instance_id)
        registrations.push({ terminal, registration })
      }
      for (const { terminal, registration } of registrations) {
        if (registration?.accountRebound !== true) continue
        await onTerminalRouteInvalidated({
          userId:connection.userId,
          terminal:{ ...terminal },
          previousRoute:registration.previousRoute || null,
        })
      }
    } catch (error) {
      await disconnectTerminals(message.session_id, connection.userId, { nowUtcMsc:now() }).catch(() => {})
      connection.terminals.clear()
      connection.sessionId = null
      throw error
    }
    connection.bridgeVersion = message.bridge_version
    connection.capabilities = new Set(message.capabilities || [])
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
      await revalidateConnectionEligibility(connection, receivedAt)
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
      if (result.status === 'applied') {
        Promise.resolve(onDataDelta({
          userId:connection.userId,
          terminal:{ ...terminal },
          stream:message.stream,
          revision:message.revision,
          observedAtUtcMsc:message.observed_at_utc_msc,
          fullSnapshot:message.full_snapshot === true,
        })).catch(error => {
          console.warn(`[BridgeV3] data delta callback failed user=${connection.userId} stream=${message.stream} error=${error.message}`)
        })
      }
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
        || !isDeepStrictEqual(pending.request.params, message.params)) {
        throw gatewayError('bridge_data_response_mismatch')
      }
      clearTimeout(pending.timer)
      pendingDataRequests.delete(message.request_id)
      pending.resolve(message)
      return
    }
    throw Object.assign(new Error('bridge_message_type_unexpected'), { code:'bridge_message_type_unexpected' })
  }

  function reportInboundError(connection, error) {
    if (connection.closed) return true
    const code = error?.code || 'bridge_message_rejected'
    const validation = Array.isArray(error?.details) ? ` details=${error.details.join('|')}` : ''
    console.warn(`[BridgeV3] message rejected user=${connection.userId ?? 'unknown'} code=${code}${validation}`)
    const closeCode = sessionCloseCode(code, connection.ready)
    if (closeCode) {
      closeConnection(connection, code, error?.message || null, closeCode)
      return true
    }
    protocolError(connection.ws, code, error?.message || null)
    return false
  }

  function drainInboundQueue(connection) {
    if (connection.closed || connection.inboundStopped || !connection.authReady
      || connection.inboundDrainRunning) return
    connection.inboundDrainRunning = true
    Promise.resolve().then(async () => {
      while (!connection.closed && !connection.inboundStopped && connection.inboundQueue.length) {
        const entry = connection.inboundQueue.shift()
        connection.inboundQueueBytes = Math.max(0, connection.inboundQueueBytes - entry.size)
        connection.inboundProcessing = entry
        adjustInboundSocketFlow(connection)
        try {
          await handleMessage(connection, entry.raw)
        } catch (error) {
          reportInboundError(connection, error)
        } finally {
          if (connection.inboundProcessing === entry) connection.inboundProcessing = null
          adjustInboundSocketFlow(connection)
        }
      }
    }).catch(error => {
      // Keep the detached drain promise handled even if an unexpected callback
      // throws outside handleMessage's normal rejection path.
      try { reportInboundError(connection, error) } catch {}
    }).finally(() => {
      connection.inboundDrainRunning = false
      if (!connection.closed && !connection.inboundStopped && connection.authReady
        && connection.inboundQueue.length) drainInboundQueue(connection)
    })
  }

  function rejectInboundQueueOverflow(connection) {
    if (!connection || connection.closed || connection.inboundStopped) return false
    return closeConnection(connection, 'bridge_inbound_queue_overflow', null, 1013)
  }

  function enqueueInboundMessage(connection, raw) {
    if (!connection || connection.closed || connection.inboundStopped) return false
    const size = byteLength(raw)
    const processingSize = connection.inboundProcessing?.size || 0
    const processingCount = connection.inboundProcessing ? 1 : 0
    if (connection.inboundQueue.length + processingCount >= BRIDGE_V3_INBOUND_QUEUE_MAX_MESSAGES
      || connection.inboundQueueBytes + processingSize + size > BRIDGE_V3_INBOUND_QUEUE_MAX_BYTES) {
      rejectInboundQueueOverflow(connection)
      return false
    }
    connection.inboundQueue.push({ raw, size })
    connection.inboundQueueBytes += size
    adjustInboundSocketFlow(connection)
    drainInboundQueue(connection)
    return true
  }

  function activateInboundQueue(connection) {
    if (connection.closed || connection.inboundStopped) return false
    const queued = connection.authQueue
    const queuedBytes = connection.authQueueBytes
    connection.authQueue = []
    connection.authQueueBytes = 0
    if (queued.length > BRIDGE_V3_INBOUND_QUEUE_MAX_MESSAGES
      || queuedBytes > BRIDGE_V3_INBOUND_QUEUE_MAX_BYTES) {
      rejectInboundQueueOverflow(connection)
      return false
    }
    connection.inboundQueue = queued.map(raw => ({ raw, size:byteLength(raw) }))
    connection.inboundQueueBytes = queuedBytes
    connection.authReady = true
    drainInboundQueue(connection)
    return true
  }

  wss.on('connection', (ws, req) => {
    const connection = {
      ws,
      userId:null,
      authenticated:false,
      authReady:false,
      ready:false,
      sessionId:null,
      capabilities:new Set(),
      terminals:new Map(),
      initialSnapshotStreams:new Map(),
      closed:false,
      authQueue:[],
      authQueueBytes:0,
      inboundQueue:[],
      inboundQueueBytes:0,
      inboundProcessing:null,
      inboundDrainRunning:false,
      inboundStopped:false,
      inboundSocketPaused:false,
      tokenVersion:null,
      nextEligibilityCheckAt:0,
      pingInterval:null,
      pingTimeoutTimer:null,
      pingOutstandingAt:0,
      transportRttMs:null,
    }
    const url = new URL(req.url, 'http://localhost')
    const onMessage = raw => {
      if (connection.closed || connection.inboundStopped) return
      if (!connection.authReady) {
        const size = byteLength(raw)
        if (connection.authQueue.length >= AUTH_QUEUE_MAX_MESSAGES
          || connection.authQueueBytes + size > AUTH_QUEUE_MAX_BYTES) {
          closeConnection(connection, 'bridge_auth_queue_overflow', null, 1009)
          return
        }
        connection.authQueue.push(raw)
        connection.authQueueBytes += size
        return
      }
      enqueueInboundMessage(connection, raw)
    }
    ws.on('message', onMessage)
    ws.on('close', () => {
      if (connection.closed) return
      connection.closed = true
      connection.inboundStopped = true
      clearInboundQueueReferences(connection)
      unregisterConnection(connection)
    })
    ws.on('pong', () => {
      if (!connection.pingOutstandingAt) return
      connection.transportRttMs = Math.max(0, now() - connection.pingOutstandingAt)
      connection.pingOutstandingAt = 0
      if (connection.pingTimeoutTimer) clearTimeout(connection.pingTimeoutTimer)
      connection.pingTimeoutTimer = null
    })
    ws.on('error', () => {})

    if (typeof ws.ping === 'function') {
      connection.pingInterval = setInterval(() => {
        if (connection.closed) return
        const current = now()
        if (connection.pingOutstandingAt
          && current - connection.pingOutstandingAt >= BRIDGE_V3_TRANSPORT_PING_TIMEOUT_MS) {
          closeTransportPingTimeout(connection)
          return
        }
        if (ws.readyState !== 1 || connection.pingOutstandingAt) return
        connection.pingOutstandingAt = current
        connection.pingTimeoutTimer = setTimeout(() => {
          if (connection.closed || !connection.pingOutstandingAt) return
          if (now() - connection.pingOutstandingAt >= BRIDGE_V3_TRANSPORT_PING_TIMEOUT_MS) {
            closeTransportPingTimeout(connection)
          }
        }, BRIDGE_V3_TRANSPORT_PING_TIMEOUT_MS)
        connection.pingTimeoutTimer.unref?.()
        try {
          ws.ping()
        } catch {
          connection.pingOutstandingAt = 0
          if (connection.pingTimeoutTimer) clearTimeout(connection.pingTimeoutTimer)
          connection.pingTimeoutTimer = null
        }
      }, TRANSPORT_PING_INTERVAL_MS)
      connection.pingInterval.unref?.()
    }

    authenticate(connection, url).then(() => {
      activateInboundQueue(connection)
    }).catch(error => {
      if (connection.closed) return
      console.warn(`[BridgeV3] authentication rejected code=${error.code || 'bridge_auth_failed'}`)
      closeConnection(connection, error.code || 'bridge_auth_failed', null, 4002)
    })
  })

  async function sendCommand(userId, command, { timeoutMs = 5_000 } = {}) {
    const nowUtcMsc = now()
    assertBridgeV3Message(command, { nowUtcMsc })
    if (command.type !== 'command') throw Object.assign(new Error('bridge_command_type_invalid'), { code:'bridge_command_type_invalid' })
    if (maintenanceBlock(command.terminal_instance_id)) {
      return {
        status:'rejected',
        command_id:command.command_id,
        error:'bridge_maintenance',
        message:'量见智桥正在安全更新，请稍后重试',
      }
    }
    activeCommandAdmissions.set(
      command.terminal_instance_id,
      Number(activeCommandAdmissions.get(command.terminal_instance_id) || 0) + 1,
    )
    try {
      const ledger = await createLedgerEntry(command, { userId:Number(userId), nowUtcMsc })
      if (!['queued'].includes(ledger.command.status)) {
        return ledger.command.result
          ? { ...ledger.command.result, duplicate:true }
          : { status:ledger.command.status, command_id:command.command_id, duplicate:true }
      }

      // The ledger owns the current transport envelope after a queued retry;
      // never send an older epoch/deadline than the row we are about to mark.
      const dispatchCommand = {
        ...command,
        connection_epoch:Number.isSafeInteger(Number(ledger.command.connection_epoch))
          ? Number(ledger.command.connection_epoch) : command.connection_epoch,
        deadline_utc_msc:Number.isSafeInteger(Number(ledger.command.deadline_at_utc_msc))
          ? Number(ledger.command.deadline_at_utc_msc) : command.deadline_utc_msc,
      }

      const routed = connectionsByTerminal.get(command.terminal_instance_id)
      if (!routed || !connectionAlive(routed.connection) || routed.connection.userId !== Number(userId)
        || !sameBridgeRoute(routeFromTerminal(routed.terminal), dispatchCommand)) {
        return { status:'queued', command_id:command.command_id, error:'bridge_terminal_not_connected' }
      }
      if (command.action !== 'query_execution'
        && !terminalInitialSyncReady(routed.connection, command.terminal_instance_id)) {
        return { status:'queued', command_id:command.command_id, error:'bridge_terminal_initial_sync_pending' }
      }
      await markDispatched(command.command_id, {
        connectionEpoch:dispatchCommand.connection_epoch,
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
        pendingResults.set(command.command_id, {
          resolve, timer, connection:routed.connection,
          terminalInstanceId:command.terminal_instance_id,
        })
        if (!safeSend(routed.connection.ws, dispatchCommand)) {
          clearTimeout(timer)
          pendingResults.delete(command.command_id)
          markUncertain(command.command_id, { reason:'bridge_send_failed', nowUtcMsc:now() })
            .then(() => resolve({ status:'uncertain', command_id:command.command_id, error:'bridge_send_failed' }))
            .catch(error => resolve({ status:'uncertain', command_id:command.command_id,
              error:error.code || error.message }))
        }
      })
    } finally {
      const remaining = Number(activeCommandAdmissions.get(command.terminal_instance_id) || 1) - 1
      if (remaining > 0) activeCommandAdmissions.set(command.terminal_instance_id, remaining)
      else activeCommandAdmissions.delete(command.terminal_instance_id)
    }
  }

  async function acquireMaintenanceLease({
    actorUserId,
    authorizedUserIds,
    installationId,
    targetVersion,
    priority,
    manualRequest,
    terminalInstanceIds,
    expectedDowntimeSeconds = 60,
    ttlSeconds = 90,
  }) {
    const actorId = Number(actorUserId)
    const authorized = new Set((authorizedUserIds || []).map(Number))
    const terminalIds = Array.isArray(terminalInstanceIds) ? terminalInstanceIds.map(String) : []
    if (!Number.isSafeInteger(actorId) || actorId <= 0 || !authorized.has(actorId)
      || typeof installationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(installationId)
      || typeof targetVersion !== 'string' || !/^\d+\.\d+(?:\.\d+){0,2}$/.test(targetVersion)
      || !['normal', 'urgent'].includes(priority) || typeof manualRequest !== 'boolean'
      || terminalIds.length < 1 || terminalIds.length > 64
      || new Set(terminalIds).size !== terminalIds.length
      || terminalIds.some(value => !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value))
      || !Number.isSafeInteger(expectedDowntimeSeconds)
      || expectedDowntimeSeconds < 30 || expectedDowntimeSeconds > 300
      || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 180) {
      throw gatewayError('bridge_maintenance_request_invalid')
    }
    // Expired in-memory leases are safe to purge before route authorization;
    // the durable command sweep must wait until all request and terminal
    // authorization checks have passed so invalid requests remain read-only.
    purgeExpiredLeases()
    const routes = []
    for (const terminalId of terminalIds) {
      const routed = connectionsByTerminal.get(terminalId)
      if (!routed || !connectionAlive(routed.connection)
        || !authorized.has(Number(routed.connection.userId))) {
        throw gatewayError('bridge_maintenance_terminal_forbidden')
      }
      if (maintenanceByTerminal.has(terminalId)) {
        return { acquired:false, code:'bridge_maintenance_lease_conflict', retry_after_seconds:5 }
      }
      routes.push(routed)
    }
    const nowUtcMsc = now()
    await expireQueued({ nowUtcMsc })
    const lease = {
      lease_id:`lease_${randomUUID()}`,
      actor_user_id:actorId,
      installation_id:installationId,
      target_version:targetVersion,
      priority,
      manual_request:manualRequest,
      terminal_instance_ids:[...terminalIds],
      expected_downtime_seconds:expectedDowntimeSeconds,
      expires_at_utc_msc:now() + ttlSeconds * 1000,
      timer:null,
    }
    maintenanceLeases.set(lease.lease_id, lease)
    for (const terminalId of terminalIds) maintenanceByTerminal.set(terminalId, lease)
    try {
      const locallyActive = activeCommandCount(terminalIds)
        + Array.from(pendingResults.values())
          .filter(pending => terminalIds.includes(pending.terminalInstanceId)).length
      const durableOutstanding = await countOutstanding(terminalIds, { nowUtcMsc })
      if (locallyActive > 0 || durableOutstanding > 0) {
        releaseLeaseInternal(lease)
        return {
          acquired:false,
          code:'bridge_maintenance_commands_in_flight',
          retry_after_seconds:5,
        }
      }
      scheduleLeaseExpiry(lease)
      return {
        acquired:true,
        lease_id:lease.lease_id,
        expires_at_utc_msc:lease.expires_at_utc_msc,
        terminal_instance_ids:[...lease.terminal_instance_ids],
      }
    } catch (error) {
      releaseLeaseInternal(lease)
      throw error
    }
  }

  function renewMaintenanceLease(actorUserId, leaseId, { ttlSeconds = 90 } = {}) {
    purgeExpiredLeases()
    const lease = maintenanceLeases.get(String(leaseId || ''))
    if (!lease || lease.actor_user_id !== Number(actorUserId)) {
      throw gatewayError('bridge_maintenance_lease_not_found')
    }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 180) {
      throw gatewayError('bridge_maintenance_request_invalid')
    }
    lease.expires_at_utc_msc = now() + ttlSeconds * 1000
    scheduleLeaseExpiry(lease)
    return { renewed:true, lease_id:lease.lease_id, expires_at_utc_msc:lease.expires_at_utc_msc }
  }

  function releaseMaintenanceLease(actorUserId, leaseId) {
    purgeExpiredLeases()
    const lease = maintenanceLeases.get(String(leaseId || ''))
    if (!lease || lease.actor_user_id !== Number(actorUserId)) {
      throw gatewayError('bridge_maintenance_lease_not_found')
    }
    releaseLeaseInternal(lease)
    return { released:true, lease_id:lease.lease_id }
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
        bridge_version:connection.bridgeVersion || null,
        capabilities:[...(connection.capabilities || [])],
        transport_rtt_msc:Number.isFinite(connection.transportRttMs)
          ? Math.round(connection.transportRttMs) : null,
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
      closeConnection(connection, reason, null, 4004)
    }
    return connections.size
  }

  function broadcastReleaseAvailable({
    releaseId = null,
    releaseVersion,
    rolloutChannel = 'stable',
    reason = 'published',
  } = {}) {
    if (typeof releaseVersion !== 'string'
      || !/^\d+\.\d+(?:\.\d+){0,2}$/.test(releaseVersion)
      || !['internal', 'stable'].includes(rolloutChannel)
      || !['published', 'rollback'].includes(reason)) return 0
    const message = {
      v:3,
      type:'release_available',
      message_id:messageId('release'),
      sent_at_utc_msc:now(),
      release_id:typeof releaseId === 'string' && releaseId ? releaseId : null,
      release_version:releaseVersion,
      rollout_channel:rolloutChannel,
      reason,
    }
    const connections = new Set()
    for (const { connection } of connectionsByTerminal.values()) {
      // Older v3 clients fail closed on unknown message types. They keep the
      // 15-minute HTTPS poll until they have upgraded to the notice-aware build.
      if (connectionAlive(connection) && supportsReleaseNotice(connection.bridgeVersion)) {
        connections.add(connection)
      }
    }
    let delivered = 0
    for (const connection of connections) {
      if (safeSend(connection.ws, message)) delivered += 1
    }
    return delivered
  }

  return {
    wss,
    connectionsByTerminal,
    pendingQuotes,
    pendingDataRequests,
    maintenanceByTerminal,
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
    broadcastReleaseAvailable,
    acquireMaintenanceLease,
    renewMaintenanceLease,
    releaseMaintenanceLease,
  }
}
