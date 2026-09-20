import { BridgeGatewayError, type BridgeGatewayRoute, type BridgeSessionHelloEnvelope } from '../domain/bridge-gateway.js'
import type { BridgeSessionTicketClaims } from '../application/bridge-credential-ports.js'

/**
 * These values are persisted in the route and are therefore part of the
 * server-side authorization proof.  They are deliberately stricter than the
 * wire envelope's generic opaque identifiers: the corresponding MySQL columns
 * are ASCII VARCHAR(128) values.
 */
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/
const OWNERSHIP_REVISION = /^[1-9][0-9]{0,19}$/
const MAX_EPOCH = Number.MAX_SAFE_INTEGER
const MAX_GENERATION = 4_294_967_295

export interface AuthorizeContext {
  terminal: BridgeSessionHelloEnvelope['payload']['terminals'][number]
  claims: BridgeSessionTicketClaims
  connectionId: string
  connectedAt: string
}

export interface FrozenRouteProof {
  installationId: string
  credentialGeneration: number
  ownershipRevision: string
}

export function assertAuthorizeContext(
  claims: BridgeSessionTicketClaims,
  hello: BridgeSessionHelloEnvelope,
  connectionId: string,
  connectedAt: string,
): AuthorizeContext {
  if (!claims || !Number.isSafeInteger(claims.userId) || claims.userId < 1
    || !deviceId(claims.installationId) || !deviceId(claims.profileId)
    || !Number.isSafeInteger(claims.generation) || claims.generation < 1 || claims.generation > MAX_GENERATION) {
    throw gatewayError('bridge_route_binding_invalid', 403)
  }
  if (!hello?.payload || hello.payload.installation_id !== claims.installationId
    || hello.payload.profile_id !== claims.profileId || !deviceId(hello.payload.installation_id)
    || !deviceId(hello.payload.profile_id) || !routeId(connectionId)
    || !Number.isFinite(Date.parse(connectedAt))) {
    throw gatewayError('bridge_session_claim_mismatch', 403)
  }
  const terminal = hello.payload.terminals?.[0]
  const epoch = terminal?.route?.connection_epoch
  if (!terminal || (terminal.platform !== 'mt4' && terminal.platform !== 'mt5')
    || typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1 || epoch > MAX_EPOCH
    || !routeId(terminal.route?.terminal_instance_id)
    || typeof terminal.route?.account_ref?.broker_server !== 'string'
    || terminal.route.account_ref.broker_server.length < 1 || terminal.route.account_ref.broker_server.length > 128
    || typeof terminal.route.account_ref.login !== 'string'
    || terminal.route.account_ref.login.length < 1 || terminal.route.account_ref.login.length > 64) {
    throw gatewayError('bridge_session_route_invalid', 400)
  }
  return { terminal, claims, connectionId, connectedAt }
}

export function assertFrozenRouteProof(route: BridgeGatewayRoute): asserts route is BridgeGatewayRoute & Required<FrozenRouteProof> {
  const generation = route?.credentialGeneration
  if (!route || !deviceId(route.installationId) || typeof generation !== 'number'
    || !Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION
    || !ownershipRevision(route.ownershipRevision)) {
    throw gatewayError('bridge_route_proof_missing', 403)
  }
}

export function hasFrozenRouteProof(route: BridgeGatewayRoute): route is BridgeGatewayRoute & Required<FrozenRouteProof> {
  const generation = route?.credentialGeneration
  return Boolean(route && deviceId(route.installationId) && typeof generation === 'number'
    && Number.isSafeInteger(generation) && generation >= 1 && generation <= MAX_GENERATION
    && ownershipRevision(route.ownershipRevision))
}

export function profileDisplayName(profileId: string) {
  // Profile IDs are constrained to the ASCII device-id alphabet.  Returning
  // the ID itself keeps first registration deterministic and cannot inject
  // control characters into the display field.
  return profileId
}

export function deviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID.test(value)
}

/** Opaque wire identifiers may contain a colon (for example a namespaced
 * terminal instance), but must still be non-empty protocol identifiers. */
export function routeId(value: unknown): value is string {
  return typeof value === 'string' && ROUTE_ID.test(value)
}

export function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum
}

export function ownershipRevision(value: unknown): value is string {
  return typeof value === 'string' && OWNERSHIP_REVISION.test(value)
}

export function epoch(value: unknown) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > MAX_EPOCH) {
    throw gatewayError('bridge_route_storage_invalid', 503)
  }
  return numeric
}

export function gatewayError(code: string, status: 400 | 403 | 404 | 409 | 503) {
  return new BridgeGatewayError(code, status)
}

export function translateStorageError(error: unknown): BridgeGatewayError {
  if (error instanceof BridgeGatewayError) return error
  const code = String((error as { code?: unknown })?.code ?? '')
  if (code === 'ER_DUP_ENTRY') return gatewayError('bridge_route_conflict', 409)
  if (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT') return gatewayError('bridge_route_storage_unavailable', 503)
  const translated = gatewayError('bridge_route_storage_unavailable', 503)
  if (/^ER_[A-Z0-9_]{1,80}$/.test(code)) translated.cause = { code }
  return translated
}
