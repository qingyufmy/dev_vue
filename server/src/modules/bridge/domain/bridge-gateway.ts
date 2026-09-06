import type { BridgeRoute, BridgeWireRoute } from '../../execution/domain/bridge-command.js'

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface BridgeTerminalHello {
  route: BridgeWireRoute
  platform: 'mt4' | 'mt5'
  terminal_version: string
  trade_permission: 'full' | 'read_only' | 'disabled' | 'unknown'
  timezone_offset_minutes?: number | null
  clock_status: 'calibrated' | 'observer_bootstrap' | 'stale' | 'unavailable'
  account_facts?: {
    currency: string
    login: string
    broker_server: string
    observed_at_utc_msc: number
  }
}

export interface BridgeSessionHelloEnvelope {
  v: 4
  message_id: string
  type: 'session.hello'
  sent_at_utc_msc: number
  correlation_id: string | null
  payload: {
    session_id: string
    installation_id: string
    profile_id: string
    bridge_version: string
    protocol_versions: number[]
    platforms: Array<'mt4' | 'mt5'>
    capabilities: string[]
    limits: BridgeProtocolLimits
    terminals: BridgeTerminalHello[]
  }
}

export interface BridgeProtocolLimits {
  max_frame_bytes: number
  max_page_size: number
  max_inflight_queries: number
  max_inflight_commands: number
}

export interface BridgeGatewayRoute extends BridgeRoute {
  /** Server-only proof. Missing legacy/in-memory proof never authorizes a production route. */
  installationId?: string
  credentialGeneration?: number
  ownershipRevision?: string
  userId: number
  accountId: string
  platform: 'mt4' | 'mt5'
  timezoneOffsetMinutes: number | null
  terminalProfileId: string
  connectionId: string
  sessionId: string
}

export interface BridgeSessionWelcomeEnvelope {
  v: 4
  message_id: string
  type: 'session.welcome'
  sent_at_utc_msc: number
  correlation_id: string
  payload: {
    session_id: string
    connection_id: string
    accepted_protocol_version: 4
    heartbeat_interval_ms: number
    limits: BridgeProtocolLimits
  }
}

export interface BridgeHeartbeatEnvelope {
  v: 4
  message_id: string
  type: 'system.heartbeat'
  sent_at_utc_msc: number
  correlation_id: string | null
  payload: {
    session_id: string
    last_received_message_id: string | null
    queue: {
      commands: number
      results: number
      queries: number
      stream_events: number
    }
  }
}

export class BridgeGatewayError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'BridgeGatewayError'
  }
}

export function assertSessionHello(value: BridgeSessionHelloEnvelope) {
  if (!value || value.v !== 4 || value.type !== 'session.hello') fail('bridge_session_hello_invalid')
  if (!opaque(value.message_id)) fail('bridge_session_hello_invalid')
  utcMsc(value.sent_at_utc_msc)
  const payload = value.payload
  if (!payload || !opaque(payload.session_id)
    || typeof payload.installation_id !== 'string' || !DEVICE_ID.test(payload.installation_id)
    || typeof payload.profile_id !== 'string' || !DEVICE_ID.test(payload.profile_id)) fail('bridge_session_hello_invalid')
  if (typeof payload.bridge_version !== 'string' || payload.bridge_version.length < 1 || payload.bridge_version.length > 64) fail('bridge_session_hello_invalid')
  if (!Array.isArray(payload.protocol_versions) || payload.protocol_versions.length !== 1 || payload.protocol_versions[0] !== 4) fail('bridge_protocol_version_unsupported', 409)
  if (!Array.isArray(payload.terminals) || payload.terminals.length !== 1) fail('bridge_session_route_count_invalid', 409)
  const terminal = payload.terminals[0]!
  if (!terminal || !terminal.route || typeof terminal.route.terminal_instance_id !== 'string' || terminal.route.terminal_instance_id.length > 128) fail('bridge_session_route_invalid')
  if (!Array.isArray(payload.platforms) || payload.platforms.length < 1 || payload.platforms.length > 2
    || new Set(payload.platforms).size !== payload.platforms.length
    || payload.platforms.some(platform => platform !== 'mt4' && platform !== 'mt5')
    || !payload.platforms.includes(terminal.platform)) fail('bridge_session_platform_invalid')
  if (!Array.isArray(payload.capabilities) || payload.capabilities.length > 128
    || new Set(payload.capabilities).size !== payload.capabilities.length
    || payload.capabilities.some(capability => typeof capability !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(capability))) {
    fail('bridge_session_capabilities_invalid')
  }
  assertWireRoute(terminal.route)
  assertTerminalAccountFacts(terminal)
  if (typeof terminal.terminal_version !== 'string' || terminal.terminal_version.length > 64) fail('bridge_session_terminal_version_invalid')
  if (!['full', 'read_only', 'disabled', 'unknown'].includes(terminal.trade_permission)) fail('bridge_session_trade_permission_invalid')
  if (!['calibrated', 'observer_bootstrap', 'stale', 'unavailable'].includes(terminal.clock_status)) fail('bridge_session_clock_invalid')
  if (terminal.timezone_offset_minutes !== undefined && terminal.timezone_offset_minutes !== null
    && (!Number.isInteger(terminal.timezone_offset_minutes) || terminal.timezone_offset_minutes < -840 || terminal.timezone_offset_minutes > 840)) {
    fail('bridge_session_clock_invalid')
  }
  limits(payload.limits)
  return value
}

/** Authenticated client facts; these do not independently prove broker ownership. */
export function assertTerminalAccountFacts(terminal: BridgeTerminalHello, receivedAtMsc?: number) {
  if (terminal.account_facts === undefined) return undefined
  const facts = terminal.account_facts
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)
    || Object.keys(facts).some(key => !['currency', 'login', 'broker_server', 'observed_at_utc_msc'].includes(key))
    || typeof facts.currency !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/.test(facts.currency) || /\s/.test(facts.currency)
    || facts.login !== terminal.route.account_ref.login || facts.broker_server !== terminal.route.account_ref.broker_server
    || !Number.isSafeInteger(facts.observed_at_utc_msc) || facts.observed_at_utc_msc < 1) {
    fail('bridge_session_account_facts_invalid')
  }
  if (receivedAtMsc !== undefined && (!Number.isFinite(receivedAtMsc)
    || facts.observed_at_utc_msc < receivedAtMsc - 60_000 || facts.observed_at_utc_msc > receivedAtMsc + 5_000)) {
    fail('bridge_session_account_facts_stale')
  }
  return facts
}

export function assertHeartbeat(value: unknown): BridgeHeartbeatEnvelope {
  if (!value || typeof value !== 'object') fail('bridge_heartbeat_invalid')
  const envelope = value as Partial<BridgeHeartbeatEnvelope>
  if (envelope.v !== 4 || envelope.type !== 'system.heartbeat' || !opaque(envelope.message_id as string)) fail('bridge_heartbeat_invalid')
  utcMsc(envelope.sent_at_utc_msc as number)
  const payload = envelope.payload
  if (!payload || !opaque(payload.session_id)) fail('bridge_heartbeat_invalid')
  if (payload.last_received_message_id !== null && !opaque(payload.last_received_message_id)) fail('bridge_heartbeat_invalid')
  const queue = payload.queue
  if (!queue || Object.keys(queue).some(key => !['commands', 'results', 'queries', 'stream_events'].includes(key))
    || !queueCount(queue.commands) || !queueCount(queue.results) || !queueCount(queue.queries) || !queueCount(queue.stream_events)) {
    fail('bridge_heartbeat_invalid')
  }
  return envelope as BridgeHeartbeatEnvelope
}

export function assertWireRoute(route: BridgeWireRoute) {
  if (!route || !opaque(route.terminal_instance_id)
    || typeof route.account_ref?.broker_server !== 'string' || route.account_ref.broker_server.length < 1 || route.account_ref.broker_server.length > 128
    || typeof route.account_ref?.login !== 'string' || route.account_ref.login.length < 1 || route.account_ref.login.length > 64
    || !Number.isSafeInteger(route.connection_epoch) || route.connection_epoch < 1) fail('bridge_session_route_invalid')
  return route
}

export function welcomeEnvelope(route: BridgeGatewayRoute, hello: BridgeSessionHelloEnvelope, now = new Date()): BridgeSessionWelcomeEnvelope {
  const limitsValue: BridgeProtocolLimits = {
    max_frame_bytes: Math.min(hello.payload.limits.max_frame_bytes, 524_288),
    max_page_size: Math.min(hello.payload.limits.max_page_size, 500),
    max_inflight_queries: Math.min(hello.payload.limits.max_inflight_queries, 32),
    max_inflight_commands: 1,
  }
  return {
    v: 4,
    message_id: `welcome:${route.connectionId}`,
    type: 'session.welcome',
    sent_at_utc_msc: now.getTime(),
    correlation_id: hello.message_id,
    payload: {
      session_id: route.sessionId,
      connection_id: route.connectionId,
      accepted_protocol_version: 4,
      heartbeat_interval_ms: 15_000,
      limits: limitsValue,
    },
  }
}

function limits(value: BridgeProtocolLimits) {
  if (!value || !integer(value.max_frame_bytes, 65_536, 524_288) || !integer(value.max_page_size, 1, 500)
    || !integer(value.max_inflight_queries, 1, 64) || !integer(value.max_inflight_commands, 1, 32)) fail('bridge_session_limits_invalid')
}
function integer(value: number, minimum: number, maximum: number) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum }
function queueCount(value: number) { return Number.isSafeInteger(value) && value >= 0 }
function opaque(value: string) { return typeof value === 'string' && OPAQUE_ID.test(value) }
function utcMsc(value: number) { if (!Number.isSafeInteger(value) || value < 1) fail('bridge_session_time_invalid') }
function fail(code: string, status = 400): never { throw new BridgeGatewayError(code, status) }
