import { inBridgeRouteTransaction as inTransaction } from './mysql-bridge-route-transaction.js'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { BridgeGatewayRouteRepository } from '../application/bridge-gateway-ports.js'
import { assertTerminalAccountFacts, BridgeGatewayError, type BridgeGatewayRoute } from '../domain/bridge-gateway.js'
import type { BridgeAccountRegistration } from '../application/bridge-account-registration.js'
import {
  assertAuthorizeContext, assertFrozenRouteProof, boundedText, deviceId, epoch, gatewayError, hasFrozenRouteProof,
  profileDisplayName, routeId, translateStorageError,
} from './mysql-bridge-route-authorization.js'

interface CredentialRow extends RowDataPacket {
  user_id: number | string
  generation: number | string
}

interface ProfileRow extends RowDataPacket {
  id: string
  user_id: number | string
  platform: 'mt4' | 'mt5' | string
  installation_id: string
  deleted_at_utc: Date | string | null
}

interface EpochRow extends RowDataPacket { connection_epoch_v4: string | number | null }

interface BindingRow extends RowDataPacket {
  terminal_profile_id: string
  trading_account_id: string | number
  terminal_instance_id: string
  unbound_at_utc: Date | string | null
}

interface SessionProofRow extends RowDataPacket {
  id: string | number
  ownership_revision: string | number
}

const PROFILE_COLUMNS = 'p.id,p.user_id,p.platform,p.installation_id,p.deleted_at_utc'
const BINDING_COLUMNS = 'b.terminal_profile_id,CAST(b.trading_account_id AS CHAR) trading_account_id,b.terminal_instance_id,b.unbound_at_utc'

/**
 * MySQL-backed owner route registration for the Bridge V4 gateway.
 *
 * Registration is deliberately the only place that changes a profile binding.
 * A ticket proves the current V4 device credential; the account and ownership
 * joins below prove that the account still belongs to that user. Redis leases
 * and terminal I/O stay outside this transaction.
 */
export class MysqlBridgeGatewayRouteRepository implements BridgeGatewayRouteRepository {
  constructor(
    private readonly pool: Pool,
    private readonly accountRegistrationForTransaction: (connection: PoolConnection) => BridgeAccountRegistration,
  ) {}

  async authorizeAndOpen(input: Parameters<BridgeGatewayRouteRepository['authorizeAndOpen']>[0]) {
    const context = assertAuthorizeContext(input.claims, input.hello, input.connectionId, input.connectedAt)
    const facts = assertTerminalAccountFacts(context.terminal, Date.parse(context.connectedAt))
    return inTransaction(this.pool, async connection => {
      const registration = this.accountRegistrationForTransaction(connection)
      const account = await registration.lockAccount({ platform: context.terminal.platform,
        brokerServer: context.terminal.route.account_ref.broker_server, login: context.terminal.route.account_ref.login })
      if (!account && !facts) throw gatewayError('bridge_route_account_not_found', 403)
      if (account && facts && account.currency !== facts.currency) {
        throw gatewayError('bridge_session_account_currency_mismatch', 409)
      }
      // Only an INSERT protected by the durable identity key can establish a new
      // account. Deleted/collation-conflicting identities fail; never revive them.
      let accountId: string
      if (account) accountId = databaseId(account.id)
      else {
        const created = await registration.createAccount({ platform: context.terminal.platform,
          brokerServer: facts!.broker_server, login: facts!.login, currency: facts!.currency, registeredAt: context.connectedAt })
        if (!created.ok) throw gatewayError(created.reason === 'storage_invalid' ? 'bridge_route_storage_invalid' : 'bridge_route_storage_unavailable', 503)
        accountId = created.accountId
      }

      const ownership = account ? await registration.lockCurrentOwnership({ userId: context.claims.userId, accountId }) : '1'
      if (!ownership) throw gatewayError('bridge_route_binding_invalid', 403)

      // Keep the same account -> owner -> credential -> profile -> binding /
      // session lock order used by the projection writers.
      await assertCurrentCredential(connection, context.claims.userId, context.claims.installationId,
        context.claims.profileId, context.claims.generation)

      const profile = await registerOrLoadProfile(connection, context.claims.userId, context.claims.profileId,
        context.claims.installationId, context.terminal.platform)
      await assertProfile(profile, context.claims.userId, context.claims.profileId, context.claims.installationId,
        context.terminal.platform)
      if (!account) {
        const granted = await registration.grantFirstOwnership({ userId: context.claims.userId, accountId, registeredAt: context.connectedAt })
        if (!granted.ok) throw gatewayError(granted.reason === 'storage_invalid' ? 'bridge_route_storage_invalid' : 'bridge_route_storage_unavailable', 503)
      }

      // Fence the incoming epoch before any active binding is closed. The
      // profile lock above scopes the fence: two profiles can share a terminal
      // instance without stealing each other's epoch sequence.
      await assertLatestEpoch(connection, context.claims.userId, context.claims.profileId,
        context.terminal.route.connection_epoch, 'bridge_connection_epoch_stale')

      await registerOrReplaceBinding(connection, context.claims.profileId, accountId,
        context.terminal.route.terminal_instance_id, context.connectedAt)

      const connectionEpoch = context.terminal.route.connection_epoch
      const [inserted] = await connection.execute<ResultSetHeader>(`INSERT INTO bridge_connection_sessions
        (user_id,trading_account_id,terminal_profile_id,terminal_instance_id,connection_epoch,connection_epoch_v4,
         connected_at_utc,last_seen_at_utc,disconnected_at_utc,disconnect_reason)
        VALUES (?,?,?,?,?,?,?,?,?,'bridge_session_pending')`, [
        context.claims.userId, accountId, context.claims.profileId, context.terminal.route.terminal_instance_id,
        `v4:${context.connectionId}`, connectionEpoch, context.connectedAt, context.connectedAt, context.connectedAt,
      ])
      if (inserted.affectedRows !== 1) throw gatewayError('bridge_route_storage_unavailable', 503)

      return {
        userId: context.claims.userId,
        accountId,
        platform: context.terminal.platform,
        timezoneOffsetMinutes: context.terminal.timezone_offset_minutes ?? null,
        terminalProfileId: context.claims.profileId,
        terminalInstanceId: context.terminal.route.terminal_instance_id,
        brokerServer: context.terminal.route.account_ref.broker_server,
        login: context.terminal.route.account_ref.login,
        connectionEpoch,
        connectionId: context.connectionId,
        sessionId: input.hello.payload.session_id,
        installationId: context.claims.installationId,
        credentialGeneration: context.claims.generation,
        ownershipRevision: ownership,
      } satisfies BridgeGatewayRoute
    })
  }

  async activate(route: BridgeGatewayRoute, activatedAt: string) {
    assertGatewayRoute(route)
    assertTimestamp(activatedAt)
    return inTransaction(this.pool, async connection => {
      if (!await assertCurrentRouteBase(connection, route, this.accountRegistrationForTransaction(connection))) {
        throw gatewayError('bridge_session_open_missing', 409)
      }
      const pending = await selectSessionProof(connection, route, 'pending', true)
      if (!pending) throw gatewayError('bridge_session_open_missing', 409)
      await assertLatestEpoch(connection, route.userId, route.terminalProfileId,
        route.connectionEpoch, 'bridge_connection_epoch_superseded', 'activate')

      await connection.execute(`UPDATE bridge_connection_sessions
        SET disconnected_at_utc=?,disconnect_reason='bridge_connection_replaced'
        WHERE user_id=? AND disconnected_at_utc IS NULL
          AND (connection_epoch IS NULL OR connection_epoch<>?)
          AND (trading_account_id=? OR terminal_profile_id=?)`, [
        activatedAt, route.userId, `v4:${route.connectionId}`, route.accountId, route.terminalProfileId,
      ])
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE bridge_connection_sessions
        SET disconnected_at_utc=NULL,disconnect_reason=NULL,last_seen_at_utc=?
        WHERE user_id=? AND trading_account_id=? AND terminal_profile_id=? AND terminal_instance_id=?
          AND connection_epoch=? AND connection_epoch_v4=? AND disconnect_reason='bridge_session_pending'`, [
        activatedAt, route.userId, route.accountId, route.terminalProfileId, route.terminalInstanceId,
        `v4:${route.connectionId}`, route.connectionEpoch,
      ])
      if (updated.affectedRows !== 1) throw gatewayError('bridge_session_open_missing', 409)
    })
  }

  async touch(route: BridgeGatewayRoute, seenAt: string) {
    if (!hasFrozenRouteProof(route)) return false
    assertGatewayRoute(route)
    assertTimestamp(seenAt)
    return inTransaction(this.pool, async connection => {
      if (!await assertCurrentRouteBase(connection, route, this.accountRegistrationForTransaction(connection))) return false
      const current = await selectSessionProof(connection, route, 'active', true)
      if (!current) return false
      const latest = await latestEpoch(connection, route.userId, route.terminalProfileId)
      if (latest !== route.connectionEpoch) return false
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE bridge_connection_sessions
        SET last_seen_at_utc=? WHERE user_id=? AND trading_account_id=? AND terminal_profile_id=?
          AND terminal_instance_id=? AND connection_epoch=? AND connection_epoch_v4=?
          AND disconnected_at_utc IS NULL AND disconnect_reason IS NULL`, [
        seenAt, route.userId, route.accountId, route.terminalProfileId, route.terminalInstanceId,
        `v4:${route.connectionId}`, route.connectionEpoch,
      ])
      return updated.affectedRows === 1
    })
  }

  async isAuthorized(route: BridgeGatewayRoute) {
    if (!hasFrozenRouteProof(route)) return false
    assertGatewayRoute(route)
    try {
      const current = await selectSessionProof(this.pool, route, 'active', false)
      if (!current) return false
      const latest = await latestEpoch(this.pool, route.userId, route.terminalProfileId)
      return latest === route.connectionEpoch
    } catch (error) {
      if (error instanceof BridgeGatewayError) throw error
      throw translateStorageError(error)
    }
  }

  async close(route: BridgeGatewayRoute, reason: string, disconnectedAt: string) {
    assertGatewayRoute(route, false)
    assertTimestamp(disconnectedAt)
    return inTransaction(this.pool, async connection => {
      await connection.execute(`UPDATE bridge_connection_sessions
        SET disconnected_at_utc=?,disconnect_reason=?
        WHERE user_id=? AND trading_account_id=? AND terminal_profile_id=? AND terminal_instance_id=?
          AND connection_epoch=? AND connection_epoch_v4=?
          AND (disconnected_at_utc IS NULL OR disconnect_reason='bridge_session_pending')`, [
        disconnectedAt, reason.slice(0, 64), route.userId, route.accountId, route.terminalProfileId,
        route.terminalInstanceId, `v4:${route.connectionId}`, route.connectionEpoch,
      ])
    })
  }
}

async function assertCurrentCredential(
  connection: QueryExecutor,
  userId: number,
  installationId: string,
  profileId: string,
  generation: number,
) {
  const [rows] = await connection.execute<CredentialRow[]>(`SELECT s.user_id,s.generation,u.role,u.plan,u.plan_expires_at
    FROM bridge_refresh_sessions s
    INNER JOIN users u ON u.id=s.user_id
    WHERE s.user_id=? AND s.installation_id=? AND s.profile_id=? AND s.generation=?
      AND s.credential_version=4 AND s.revoked_at IS NULL
      AND u.deletion_status='active' AND u.deleted_at IS NULL
      AND (u.role='admin' OR (u.plan='pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at>UTC_TIMESTAMP(3))))
    FOR UPDATE`, [userId, installationId, profileId, generation])
  // The SQL predicate is the single entitlement authority. In particular,
  // expires_at is intentionally absent: V4 refresh credentials are rotated
  // independently from the legacy compatibility expiry column.
  if (rows.length !== 1) {
    throw gatewayError('bridge_route_binding_invalid', 403)
  }
}

type QueryExecutor = Pick<Pool, 'execute'>

type ProvenRoute = BridgeGatewayRoute & Required<{
  installationId: string
  credentialGeneration: number
  ownershipRevision: string
}>

/**
 * Recheck the durable authorization dimensions in the same order as route
 * registration and the account projection writers. The session proof query
 * below then verifies the exact pending/active session without making a
 * session row the first lock in the transaction.
 */
async function assertCurrentRouteBase(connection: QueryExecutor, route: ProvenRoute, registration: BridgeAccountRegistration): Promise<boolean> {
  const account = await registration.lockAccount({ platform: route.platform, brokerServer: route.brokerServer, login: route.login })
  if (!account || databaseId(account.id) !== route.accountId) return false

  const currentOwnership = await registration.lockCurrentOwnership({ userId: route.userId, accountId: route.accountId })
  if (currentOwnership !== route.ownershipRevision) return false

  try {
    await assertCurrentCredential(connection, route.userId, route.installationId, route.terminalProfileId,
      route.credentialGeneration)
  } catch (error) {
    if (error instanceof BridgeGatewayError && error.code === 'bridge_route_binding_invalid') return false
    throw error
  }

  const [profiles] = await connection.execute<ProfileRow[]>(`SELECT ${PROFILE_COLUMNS}
    FROM terminal_profiles p WHERE p.id=? LIMIT 1 FOR UPDATE`, [route.terminalProfileId])
  const profile = profiles[0]
  if (!profile) return false
  try {
    await assertProfile(profile, route.userId, route.terminalProfileId, route.installationId, route.platform)
  } catch (error) {
    if (error instanceof BridgeGatewayError && error.code === 'bridge_route_binding_invalid') return false
    throw error
  }
  return true
}

async function assertLatestEpoch(
  connection: QueryExecutor,
  userId: number,
  profileId: string,
  incoming: number,
  code: string,
  mode: 'open' | 'activate' = 'open',
) {
  const latest = await latestEpoch(connection, userId, profileId, true)
  if (mode === 'activate') {
    // The pending session itself is the latest row. Activation must accept
    // that exact epoch, while rejecting a newer replacement (or a missing
    // row) rather than accidentally treating the pending row as stale.
    if (latest !== incoming) throw gatewayError(code, 409)
    return
  }
  if (latest !== null && latest >= incoming) throw gatewayError(code, 409)
}

async function latestEpoch(connection: QueryExecutor, userId: number, profileId: string, lock = false) {
  const [rows] = await connection.execute<EpochRow[]>(`SELECT connection_epoch_v4
    FROM bridge_connection_sessions
    WHERE user_id=? AND terminal_profile_id=? AND connection_epoch_v4 IS NOT NULL
    ORDER BY connection_epoch_v4 DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [userId, profileId])
  const row = rows[0]
  return row?.connection_epoch_v4 === null || row?.connection_epoch_v4 === undefined
    ? null : epoch(row.connection_epoch_v4)
}

async function registerOrLoadProfile(
  connection: PoolConnection,
  userId: number,
  profileId: string,
  installationId: string,
  platform: string,
): Promise<ProfileRow> {
  const [rows] = await connection.execute<ProfileRow[]>(`SELECT ${PROFILE_COLUMNS}
    FROM terminal_profiles p WHERE p.id=? LIMIT 1 FOR UPDATE`, [profileId])
  const existing = rows[0]
  if (existing) {
    // Pairing identity is immutable; platform describes the currently selected terminal.
    // Target-account ownership and the current credential were checked before this call.
    await assertProfile(existing, userId, profileId, installationId, existing.platform)
    if (existing.platform !== platform) {
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE terminal_profiles
        SET platform=?,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND user_id=? AND installation_id=?
          AND deleted_at_utc IS NULL`, [platform, profileId, userId, installationId])
      if (updated.affectedRows !== 1) throw gatewayError('bridge_route_storage_unavailable', 503)
      return { ...existing, platform }
    }
    return existing
  }

  const [inserted] = await connection.execute<ResultSetHeader>(`INSERT INTO terminal_profiles
    (id,user_id,display_name,platform,installation_id,created_at_utc,updated_at_utc,deleted_at_utc)
    VALUES (?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),NULL)`, [
    profileId, userId, profileDisplayName(profileId), platform, installationId,
  ])
  if (inserted.affectedRows !== 1) throw gatewayError('bridge_route_storage_unavailable', 503)
  return { id: profileId, user_id: userId, platform, installation_id: installationId, deleted_at_utc: null } as ProfileRow
}

async function assertProfile(
  profile: ProfileRow,
  userId: number,
  profileId: string,
  installationId: string,
  platform: string,
) {
  if (profile.id !== profileId || Number(profile.user_id) !== userId || profile.platform !== platform
    || profile.installation_id !== installationId || profile.deleted_at_utc !== null) {
    throw gatewayError('bridge_route_binding_invalid', 403)
  }
}

async function registerOrReplaceBinding(
  connection: PoolConnection,
  profileId: string,
  accountId: string,
  terminalInstanceId: string,
  boundAt: string,
) {
  const [rows] = await connection.execute<BindingRow[]>(`SELECT ${BINDING_COLUMNS}
    FROM terminal_account_bindings b
    WHERE b.terminal_profile_id=? AND b.unbound_at_utc IS NULL
    FOR UPDATE`, [profileId])
  if (rows.length > 1) throw gatewayError('bridge_route_binding_invalid', 409)
  const existing = rows[0]
  if (existing && String(existing.trading_account_id) === accountId && existing.terminal_instance_id === terminalInstanceId) {
    return existing
  }
  if (existing) {
    await connection.execute(`UPDATE terminal_account_bindings
      SET unbound_at_utc=? WHERE terminal_profile_id=? AND unbound_at_utc IS NULL`, [boundAt, profileId])
  }
  await connection.execute(`INSERT INTO terminal_account_bindings
    (terminal_profile_id,trading_account_id,terminal_instance_id,bound_at_utc,unbound_at_utc)
    VALUES (?,?,?, ?,NULL)`, [profileId, accountId, terminalInstanceId, boundAt])
  return null
}

async function selectSessionProof(
  executor: Pick<Pool, 'execute'> | PoolConnection,
  route: BridgeGatewayRoute & Required<{ installationId: string; credentialGeneration: number; ownershipRevision: string }>,
  state: 'pending' | 'active',
  lock: boolean,
): Promise<SessionProofRow | null> {
  const sessionState = state === 'pending'
    ? `s.disconnect_reason='bridge_session_pending'`
    : `s.disconnected_at_utc IS NULL AND s.disconnect_reason IS NULL`
  const [rows] = await executor.execute<SessionProofRow[]>(`SELECT s.id,CAST(a.ownership_revision AS CHAR) ownership_revision
    FROM bridge_connection_sessions s
    INNER JOIN trading_accounts a ON a.id=s.trading_account_id
      AND a.platform=? AND BINARY a.broker_server=BINARY ? AND BINARY a.account_login=BINARY ?
      AND a.deleted_at_utc IS NULL
    INNER JOIN terminal_profiles p ON p.id=s.terminal_profile_id AND p.id=?
      AND p.user_id=? AND p.installation_id=? AND p.platform=? AND p.deleted_at_utc IS NULL
    INNER JOIN terminal_account_bindings b ON b.terminal_profile_id=p.id AND b.trading_account_id=a.id
      AND b.terminal_instance_id=? AND b.unbound_at_utc IS NULL
    INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.user_id=?
      AND o.role='owner' AND o.revoked_at_utc IS NULL AND o.revision=a.ownership_revision
    INNER JOIN trading_account_ownership_intervals oi ON oi.id=o.interval_id
      AND oi.user_id=o.user_id AND oi.trading_account_id=o.trading_account_id AND oi.role='owner'
      AND oi.ended_at_utc IS NULL AND oi.started_at_utc=o.granted_at_utc
      AND oi.started_at_utc<=UTC_TIMESTAMP(3)
    INNER JOIN bridge_refresh_sessions r ON r.user_id=? AND r.installation_id=? AND r.profile_id=?
      AND r.generation=? AND r.credential_version=4 AND r.revoked_at IS NULL
    INNER JOIN users u ON u.id=r.user_id AND u.deletion_status='active' AND u.deleted_at IS NULL
      AND (u.role='admin' OR (u.plan='pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at>UTC_TIMESTAMP(3))))
    WHERE s.user_id=? AND s.trading_account_id=? AND s.terminal_profile_id=? AND s.terminal_instance_id=?
      AND s.connection_epoch=? AND s.connection_epoch_v4=? AND a.ownership_revision=? AND ${sessionState}
    ${lock ? 'FOR UPDATE' : ''}`, [
    route.platform, route.brokerServer, route.login, route.terminalProfileId, route.userId, route.installationId,
    route.platform, route.terminalInstanceId, route.userId, route.userId, route.installationId, route.terminalProfileId,
    route.credentialGeneration, route.userId, route.accountId, route.terminalProfileId, route.terminalInstanceId,
    `v4:${route.connectionId}`, route.connectionEpoch, route.ownershipRevision,
  ])
  if (rows.length !== 1) return null
  return rows[0] ?? null
}

function assertGatewayRoute(route: BridgeGatewayRoute): asserts route is ProvenRoute
function assertGatewayRoute(route: BridgeGatewayRoute, requireProof: true): asserts route is ProvenRoute
function assertGatewayRoute(route: BridgeGatewayRoute, requireProof: false): asserts route is BridgeGatewayRoute
function assertGatewayRoute(route: BridgeGatewayRoute, requireProof = true): asserts route is ProvenRoute {
  if (requireProof) assertFrozenRouteProof(route)
  if (!route || !Number.isSafeInteger(route.userId) || route.userId < 1 || !isDatabaseId(route.accountId)
    || !deviceId(route.terminalProfileId) || !routeId(route.terminalInstanceId) || !routeId(route.connectionId)
    || !boundedText(route.brokerServer, 128) || !boundedText(route.login, 64)
    || (route.platform !== 'mt4' && route.platform !== 'mt5')
    || !Number.isSafeInteger(route.connectionEpoch) || route.connectionEpoch < 1 || route.connectionEpoch > Number.MAX_SAFE_INTEGER) {
    throw gatewayError('bridge_route_binding_invalid', 403)
  }
}

function isDatabaseId(value: unknown): value is string {
  return /^[1-9][0-9]{0,19}$/.test(String(value ?? ''))
}

function databaseId(value: unknown): string {
  const id = String(value ?? '')
  if (!/^[1-9][0-9]{0,19}$/.test(id)) throw gatewayError('bridge_route_storage_invalid', 503)
  return id
}

function assertTimestamp(value: string) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw gatewayError('bridge_route_request_invalid', 400)
}
