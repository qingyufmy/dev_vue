import { createActivePrincipalAccess } from '../src/modules/auth/composition.js'
import type { Pool } from 'mysql2/promise'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BridgeGatewayRoute, BridgeSessionHelloEnvelope } from '../src/modules/bridge/domain/bridge-gateway.js'
import { assertSessionHello, BridgeGatewayError } from '../src/modules/bridge/domain/bridge-gateway.js'
import { createBridgeGatewayRoutes } from '../src/modules/bridge/composition.js'
import { createAccountRegistration } from '../src/modules/trading/composition.js'
import { MysqlBridgeCredentialRepository } from '../src/modules/bridge/infrastructure/mysql-bridge-credential-repository.js'
import { RedisBridgeSessionTicketStore } from '../src/modules/bridge/infrastructure/redis-bridge-session-ticket-store.js'
import type { Redis } from 'ioredis'

const createRoutes = (pool: Pool) => createBridgeGatewayRoutes(pool, connection => createAccountRegistration(connection, createActivePrincipalAccess(connection)))

const NOW = '2026-09-06T00:00:00.000Z'
const LATER = '2026-09-06T00:01:00.000Z'

interface Account {
  id: string
  platform: 'mt4' | 'mt5'
  brokerServer: string
  login: string
  deletedAt: string | null
  ownershipRevision: string
  currency?: string
}

interface Credential {
  id?: number
  tokenHash?: string
  userId: number
  installationId: string
  profileId: string
  generation: number
  credentialVersion: number
  revokedAt: string | null
  role: string
  plan: string | null
  planExpiresAt: string | null
  deletionStatus: 'active' | 'deleted'
  deletedAt: string | null
}

interface Profile {
  id: string
  userId: number
  platform: 'mt4' | 'mt5'
  installationId: string
  deletedAt: string | null
}

interface Binding {
  profileId: string
  accountId: string
  instanceId: string
  boundAt: string
  unboundAt: string | null
}

interface Ownership {
  userId: number
  accountId: string
  revision: string
  intervalId: string
  role: 'owner'
  revokedAt: string | null
  intervalRole: 'owner'
  intervalStart: string
  intervalEnd: string | null
  grantedAt: string
}

interface Session {
  id: string
  userId: number
  accountId: string
  profileId: string
  instanceId: string
  legacyEpoch: string
  epoch: number
  connectedAt: string
  lastSeenAt: string
  disconnectedAt: string | null
  reason: string | null
}

interface State {
  accounts: Account[]
  credentials: Credential[]
  profiles: Profile[]
  bindings: Binding[]
  ownerships: Ownership[]
  intervals: Array<{ id: string; userId: number; accountId: string; startedAt: string }>
  sessions: Session[]
  nextSessionId: number
}

type SqlError = Error & { code?: string }

function cloneState(state: State): State {
  return structuredClone(state)
}

function sqlError(message: string, code?: string): SqlError {
  const error = new Error(message) as SqlError
  if (code !== undefined) error.code = code
  return error
}

/**
 * A stateful SQL double. It recognizes the repository's explicit statements,
 * applies writes to a transaction snapshot, and restores that snapshot on
 * rollback. It intentionally has no catch-all successful response: an
 * unrecognized statement fails, so the tests cannot pass while SQL routing is
 * accidentally removed or changed.
 */
class FakePool {
  state: State = {
    accounts: [{
      id: '42', platform: 'mt5', brokerServer: 'DPrime-Demo 5', login: '8950701',
      deletedAt: null, ownershipRevision: '3', currency: 'EUR',
    }],
    credentials: [{
      id: 1, tokenHash: 'a'.repeat(64),
      userId: 7, installationId: 'install-1', profileId: 'profile-1', generation: 2,
      credentialVersion: 4, revokedAt: null, role: 'user', plan: 'pro', planExpiresAt: '2099-01-01T00:00:00.000Z',
      deletionStatus: 'active', deletedAt: null,
    }],
    profiles: [],
    intervals: [],
    bindings: [],
    ownerships: [{
      userId: 7, accountId: '42', revision: '3', intervalId: 'interval-42', role: 'owner', revokedAt: null,
      intervalRole: 'owner', intervalStart: '2026-09-01T00:00:00.000Z', intervalEnd: null,
      grantedAt: '2026-09-01T00:00:00.000Z',
    }],
    sessions: [],
    nextSessionId: 1,
  }

  readonly calls: Array<{ sql: string; params: unknown[] }> = []
  readonly transactions: string[] = []
  failOn: string | null = null
  failureCode = 'ER_LOCK_WAIT_TIMEOUT'
  private lastAccountId = ''
  private transactionState: State | null = null

  private get current(): State { return this.transactionState ?? this.state }

  asPool() { return this as unknown as Pool }

  async getConnection() { return this }

  async beginTransaction() {
    if (this.transactionState) throw sqlError('nested transaction')
    this.transactionState = cloneState(this.state)
    this.transactions.push('begin')
  }

  async commit() {
    if (!this.transactionState) throw sqlError('commit without transaction')
    this.state = this.transactionState
    this.transactionState = null
    this.transactions.push('commit')
  }

  async rollback() {
    this.transactionState = null
    this.transactions.push('rollback')
  }

  release() { this.transactions.push('release') }

  async execute<T = unknown>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
    const placeholders = (sql.match(/\?/g) ?? []).length
    if (placeholders !== params.length) throw sqlError(`fake_sql_params:${placeholders}:${params.length}`)
    this.calls.push({ sql, params })
    if (this.failOn && sql.includes(this.failOn)) {
      this.failOn = null
      throw sqlError('simulated storage failure', this.failureCode)
    }

    if (sql.startsWith('SELECT id AS session_id,user_id,')) {
      const [tokenHash, installationId, profileId] = params
      const rows = this.current.credentials.filter(row => row.tokenHash === tokenHash && row.installationId === installationId
        && row.profileId === profileId && row.credentialVersion === 4)
        .map(row => ({ session_id: row.id, user_id: row.userId, installation_id: row.installationId,
          profile_id: row.profileId, generation: row.generation, revoked_at: row.revokedAt }))
      return [rows as T, []]
    }
    if (sql.startsWith('UPDATE bridge_refresh_sessions')) {
      const [id, tokenHash, installationId, profileId, generation] = params
      const row = this.current.credentials.find(item => item.id === id && item.tokenHash === tokenHash
        && item.installationId === installationId && item.profileId === profileId && item.generation === generation
        && item.credentialVersion === 4 && item.revokedAt === null)
      if (row) row.revokedAt = NOW
      return [{ affectedRows: row ? 1 : 0 } as T, []]
    }

    if (sql.includes('SELECT s.user_id,s.generation')) {
      const [userId, installationId, profileId, generation] = params
      const rows = this.validCredentials().filter(row => row.userId === Number(userId)
        && row.installationId === installationId && row.profileId === profileId && row.generation === Number(generation))
        .map(row => ({ user_id: row.userId, generation: row.generation, role: row.role, plan: row.plan, plan_expires_at: row.planExpiresAt }))
      return [rows as T, []]
    }

    if (sql.includes('SELECT CAST(a.id AS CHAR) id')) {
      const [platform, server, login] = params.map(String)
      const rows = this.current.accounts.filter(row => row.platform === platform
        && row.brokerServer === server && row.login === login && row.deletedAt === null)
        .map(row => ({ id: row.id, platform: row.platform, broker_server: row.brokerServer, account_login: row.login, currency: row.currency }))
      return [rows as T, []]
    }

    if (sql.startsWith('SELECT id FROM users WHERE id=?')) {
      const user = this.current.credentials.find(row => row.userId === Number(params[0]))
      return [(user?.deletionStatus === 'active' && user.deletedAt === null ? [{ id: user.userId }] : []) as T, []]
    }

    if (sql.includes('SELECT CAST(a.ownership_revision AS CHAR)')) {
      const [userId, accountId] = params
      const account = this.current.accounts.find(row => row.id === String(accountId) && row.deletedAt === null)
      const rows = account ? this.validOwnerships().filter(row => row.userId === Number(userId)
        && row.accountId === account.id && row.revision === account.ownershipRevision)
        .map(row => ({ ownership_revision: row.revision, interval_id: row.intervalId })) : []
      return [rows as T, []]
    }

    if (sql.includes('SELECT connection_epoch_v4')) {
      const [userId, profileId] = params
      const rows = this.current.sessions.filter(row => row.userId === Number(userId)
        && row.profileId === String(profileId) && row.epoch > 0)
        .sort((left, right) => right.epoch - left.epoch)
        .map(row => ({ connection_epoch_v4: row.epoch }))
      return [rows as T, []]
    }

    if (sql.includes('SELECT p.id,p.user_id,p.platform,p.installation_id,p.deleted_at_utc')) {
      const profile = this.current.profiles.find(row => row.id === String(params[0]))
      const rows = profile ? [{
        id: profile.id, user_id: profile.userId, platform: profile.platform,
        installation_id: profile.installationId, deleted_at_utc: profile.deletedAt,
      }] : []
      return [rows as T, []]
    }

    if (sql.includes('SELECT b.terminal_profile_id')) {
      const rows = this.current.bindings.filter(row => row.profileId === String(params[0]) && row.unboundAt === null)
        .map(row => ({ terminal_profile_id: row.profileId, trading_account_id: row.accountId,
          terminal_instance_id: row.instanceId, unbound_at_utc: row.unboundAt }))
      return [rows as T, []]
    }

    if (sql.includes('SELECT s.id,CAST(a.ownership_revision AS CHAR)')) {
      return [this.sessionProofRows(sql, params) as T, []]
    }

    if (sql.includes('INSERT INTO trading_accounts')) {
      const [platform, brokerServer, login, currency] = params.map(String)
      if (this.current.accounts.some(row => row.platform === platform
        && row.brokerServer.toLowerCase() === brokerServer!.toLowerCase() && row.login === login)) {
        throw sqlError('duplicate account', 'ER_DUP_ENTRY')
      }
      this.lastAccountId = String(Math.max(42, ...this.current.accounts.map(row => Number(row.id))) + 1)
      this.current.accounts.push({ id: this.lastAccountId, platform: platform as 'mt4' | 'mt5',
        brokerServer: brokerServer!, login: login!, currency: currency!, deletedAt: null, ownershipRevision: '1' })
      return [{ affectedRows: 1 } as T, []]
    }
    if (sql.includes('SELECT CAST(LAST_INSERT_ID() AS CHAR)')) return [[{ id: this.lastAccountId }] as T, []]
    if (sql.includes('INSERT INTO trading_account_ownership_intervals')) {
      const [id, userId, accountId, startedAt] = params
      this.current.intervals.push({ id: String(id), userId: Number(userId), accountId: String(accountId), startedAt: String(startedAt) })
      return [{ affectedRows: 1 } as T, []]
    }
    if (sql.includes('INSERT INTO trading_account_ownerships')) {
      const [userId, accountId, grantedAt, intervalId] = params
      const interval = this.current.intervals.find(row => row.id === intervalId && row.userId === userId && row.accountId === accountId)
      if (!interval) throw sqlError('missing interval')
      this.current.ownerships.push({ userId: Number(userId), accountId: String(accountId), revision: '1',
        intervalId: String(intervalId), role: 'owner', revokedAt: null, intervalRole: 'owner',
        intervalStart: interval.startedAt, intervalEnd: null, grantedAt: String(grantedAt) })
      return [{ affectedRows: 1 } as T, []]
    }

    if (sql.includes('INSERT INTO terminal_profiles')) {
      const [id, userId, _displayName, platform, installationId] = params.map(String) as [string, string, string, string, string]
      if (this.current.profiles.some(row => row.id === id)) throw sqlError('duplicate profile', 'ER_DUP_ENTRY')
      this.current.profiles.push({ id, userId: Number(userId), platform: platform as 'mt4' | 'mt5',
        installationId, deletedAt: null })
      return [{ affectedRows: 1 } as T, []]
    }

    if (sql.includes('UPDATE terminal_profiles')) {
      const [platform, id, userId, installationId] = params
      const row = this.current.profiles.find(item => item.id === id && item.userId === Number(userId)
        && item.installationId === installationId && item.deletedAt === null)
      if (row) row.platform = platform as 'mt4' | 'mt5'
      return [{ affectedRows: row ? 1 : 0 } as T, []]
    }

    if (sql.includes('UPDATE terminal_account_bindings')) {
      const [unboundAt, profileId] = params.map(String) as [string, string]
      for (const row of this.current.bindings) {
        if (row.profileId === profileId && row.unboundAt === null) row.unboundAt = unboundAt
      }
      return [{ affectedRows: 1 } as T, []]
    }

    if (sql.includes('INSERT INTO terminal_account_bindings')) {
      const [profileId, accountId, instanceId, boundAt] = params.map(String) as [string, string, string, string]
      this.current.bindings.push({ profileId, accountId, instanceId, boundAt, unboundAt: null })
      return [{ affectedRows: 1 } as T, []]
    }

    if (sql.includes('INSERT INTO bridge_connection_sessions')) {
      const [userId, accountId, profileId, instanceId, legacyEpoch, epoch, connectedAt, lastSeenAt, disconnectedAt] = params
      this.current.sessions.push({ id: String(this.current.nextSessionId++), userId: Number(userId),
        accountId: String(accountId), profileId: String(profileId), instanceId: String(instanceId),
        legacyEpoch: String(legacyEpoch), epoch: Number(epoch), connectedAt: String(connectedAt),
        lastSeenAt: String(lastSeenAt), disconnectedAt: String(disconnectedAt), reason: 'bridge_session_pending' })
      return [{ affectedRows: 1 } as T, []]
    }

    if (sql.includes("SET disconnected_at_utc=?,disconnect_reason='bridge_connection_replaced'")) {
      const [at, userId, legacyEpoch, accountId, profileId] = params.map(String) as [string, string, string, string, string]
      for (const row of this.current.sessions) {
        if (String(row.userId) === userId && row.disconnectedAt === null && row.legacyEpoch !== legacyEpoch
          && (row.accountId === accountId || row.profileId === profileId)) {
          row.disconnectedAt = at
          row.reason = 'bridge_connection_replaced'
        }
      }
      return [{ affectedRows: 1 } as T, []]
    }

    if (sql.includes('SET disconnected_at_utc=NULL,disconnect_reason=NULL')) {
      const [at, userId, accountId, profileId, instanceId, legacyEpoch, epoch] = params.map(String) as [string, string, string, string, string, string, string]
      const target = this.current.sessions.find(row => String(row.userId) === userId && row.accountId === accountId
        && row.profileId === profileId && row.instanceId === instanceId && row.legacyEpoch === legacyEpoch
        && String(row.epoch) === epoch && row.reason === 'bridge_session_pending')
      if (!target) return [{ affectedRows: 0 } as T, []]
      target.disconnectedAt = null
      target.reason = null
      target.lastSeenAt = at
      return [{ affectedRows: 1 } as T, []]
    }

    if (sql.includes('SET last_seen_at_utc=? WHERE')) {
      const [at, userId, accountId, profileId, instanceId, legacyEpoch, epoch] = params.map(String) as [string, string, string, string, string, string, string]
      const target = this.current.sessions.find(row => String(row.userId) === userId && row.accountId === accountId
        && row.profileId === profileId && row.instanceId === instanceId && row.legacyEpoch === legacyEpoch
        && String(row.epoch) === epoch && row.disconnectedAt === null && row.reason === null)
      if (!target) return [{ affectedRows: 0 } as T, []]
      target.lastSeenAt = at
      return [{ affectedRows: 1 } as T, []]
    }

    if (sql.includes('SET disconnected_at_utc=?,disconnect_reason=?')) {
      const [at, reason, userId, accountId, profileId, instanceId, legacyEpoch, epoch] = params.map(String) as [string, string, string, string, string, string, string, string]
      for (const row of this.current.sessions) {
        if (String(row.userId) === userId && row.accountId === accountId && row.profileId === profileId
          && row.instanceId === instanceId && row.legacyEpoch === legacyEpoch && String(row.epoch) === epoch
          && (row.disconnectedAt === null || row.reason === 'bridge_session_pending')) {
          row.disconnectedAt = at
          row.reason = reason
        }
      }
      return [{ affectedRows: 1 } as T, []]
    }

    throw sqlError(`unrecognized SQL: ${sql.slice(0, 80)}`)
  }

  private validCredentials() {
    return this.current.credentials.filter(row => row.credentialVersion === 4 && row.revokedAt === null
      && row.deletionStatus === 'active' && row.deletedAt === null
      && (row.role === 'admin' || (row.plan === 'pro' && (row.planExpiresAt === null
        || Date.parse(row.planExpiresAt) > Date.now()))))
  }

  private validOwnerships() {
    return this.current.ownerships.filter(row => row.role === 'owner' && row.revokedAt === null
      && row.intervalRole === 'owner' && row.intervalEnd === null && row.intervalStart === row.grantedAt
      && Date.parse(row.intervalStart) <= Date.parse(NOW))
  }

  private sessionProofRows(_sql: string, params: unknown[]) {
    const platform = String(params[0])
    const brokerServer = String(params[1])
    const login = String(params[2])
    const profileId = String(params[3])
    const userId = Number(params[4])
    const installationId = String(params[5])
    const instanceId = String(params[7])
    const credentialUserId = Number(params[9])
    const generation = Number(params[12])
    const accountId = String(params[14])
    const legacyEpoch = String(params[17])
    const epoch = Number(params[18])
    const ownershipRevision = String(params[19])
    const pending = _sql.includes("s.disconnect_reason='bridge_session_pending'")
    const account = this.current.accounts.find(row => row.id === accountId && row.platform === platform
      && row.brokerServer === brokerServer && row.login === login && row.deletedAt === null)
    const profile = this.current.profiles.find(row => row.id === profileId && row.userId === userId
      && row.installationId === installationId && row.platform === platform && row.deletedAt === null)
    const binding = this.current.bindings.find(row => row.profileId === profileId && row.accountId === accountId
      && row.instanceId === instanceId && row.unboundAt === null)
    const ownership = account && this.validOwnerships().filter(row => row.userId === userId && row.accountId === account.id
      && row.revision === account.ownershipRevision && row.revision === ownershipRevision)
    const credentials = this.validCredentials().filter(row => row.userId === credentialUserId
      && row.userId === userId && row.installationId === installationId && row.profileId === profileId
      && row.generation === generation)
    if (!account || !profile || !binding || !ownership?.length || !credentials.length) return []
    const sessions = this.current.sessions.filter(row => row.userId === userId && row.accountId === accountId
      && row.profileId === profileId && row.instanceId === instanceId && row.legacyEpoch === legacyEpoch
      && row.epoch === epoch && (pending ? row.reason === 'bridge_session_pending'
        : row.disconnectedAt === null && row.reason === null))
    return sessions.flatMap(session => ownership.flatMap(() => credentials.map(() => ({
      id: session.id, ownership_revision: ownershipRevision,
    }))))
  }
}

interface InputOptions {
  userId?: number
  installationId?: string
  profileId?: string
  platform?: 'mt4' | 'mt5'
  brokerServer?: string
  login?: string
  instanceId?: string
  epoch?: number
  connectionId?: string
  sessionId?: string
  connectedAt?: string
}

function claims(options: InputOptions = {}) {
  return {
    userId: options.userId ?? 7,
    installationId: options.installationId ?? 'install-1',
    profileId: options.profileId ?? 'profile-1',
    generation: 2,
  }
}

function hello(options: InputOptions = {}): BridgeSessionHelloEnvelope {
  const platform = options.platform ?? 'mt5'
  return {
    v: 4, message_id: 'message-1', type: 'session.hello', sent_at_utc_msc: Date.parse(NOW), correlation_id: null,
    payload: {
      session_id: options.sessionId ?? 'session-1', installation_id: options.installationId ?? 'install-1',
      profile_id: options.profileId ?? 'profile-1', bridge_version: '4.0.0', protocol_versions: [4],
      platforms: [platform], capabilities: [], limits: { max_frame_bytes: 65_536, max_page_size: 100,
        max_inflight_queries: 4, max_inflight_commands: 1 },
      terminals: [{ platform, terminal_version: 'test', trade_permission: 'full', clock_status: 'calibrated',
        timezone_offset_minutes: 0, route: { terminal_instance_id: options.instanceId ?? 'instance-1',
          account_ref: { broker_server: options.brokerServer ?? 'DPrime-Demo 5', login: options.login ?? '8950701' },
          connection_epoch: options.epoch ?? 1 } }],
    },
  }
}

function registrationInput(options: InputOptions = {}) {
  return {
    claims: claims(options), hello: hello(options), connectionId: options.connectionId ?? 'connection-1', connectedAt: options.connectedAt ?? NOW,
  }
}

async function open(repository: ReturnType<typeof createRoutes>, options: InputOptions = {}) {
  return repository.authorizeAndOpen(registrationInput(options))
}

function errorCode(error: unknown) {
  return error instanceof BridgeGatewayError ? error.code : String(error)
}

function addAccount(pool: FakePool, id: string, login: string, revision: string, userId = 7) {
  pool.state.accounts.push({ id, platform: 'mt5', brokerServer: 'DPrime-Demo 5', login, deletedAt: null,
    ownershipRevision: revision })
  pool.state.ownerships.push({ userId, accountId: id, revision, intervalId: `interval-${id}`, role: 'owner', revokedAt: null,
    intervalRole: 'owner', intervalStart: '2026-09-01T00:00:00.000Z', intervalEnd: null,
    grantedAt: '2026-09-01T00:00:00.000Z' })
}

describe('MysqlBridgeGatewayRouteRepository P5A registration', () => {
  it('rejects pre-revocation tickets and all old route proofs after exact credential revocation, preserving account history', async () => {
    const pool = new FakePool()
    const repository = createRoutes(pool.asPool())
    const active = await open(repository)
    await repository.activate(active, NOW)
    const pending = await open(repository, { epoch: 2, connectionId: 'connection-2' })
    const ticketsByKey = new Map<string, string>()
    const tickets = new RedisBridgeSessionTicketStore({
      set: async (key: string, value: string) => { ticketsByKey.set(key, value); return 'OK' },
      eval: async (_script: string, _count: number, key: string) => {
        const value = ticketsByKey.get(key); ticketsByKey.delete(key); return value ?? null
      },
    } as unknown as Redis)
    const oldTicket = await tickets.issue(claims())
    const before = structuredClone(pool.state)
    await new MysqlBridgeCredentialRepository(pool.asPool()).revokeDeviceRefresh({
      tokenHash: 'a'.repeat(64), installationId: 'install-1', profileId: 'profile-1',
    })
    const consumedClaims = await tickets.consume(oldTicket.token)
    expect(consumedClaims).toEqual(claims())
    await expect(repository.authorizeAndOpen({ ...registrationInput({ epoch: 3 }), claims: consumedClaims }))
      .rejects.toMatchObject({ code: 'bridge_route_binding_invalid', status: 403 })
    expect(await repository.isAuthorized(active)).toBe(false)
    expect(await repository.touch(active, LATER)).toBe(false)
    await expect(repository.activate(pending, LATER)).rejects.toMatchObject({ code: 'bridge_session_open_missing' })
    expect(pool.state.accounts).toEqual(before.accounts)
    expect(pool.state.ownerships).toEqual(before.ownerships)
    expect(pool.state.profiles).toEqual(before.profiles)
    expect(pool.state.bindings).toEqual(before.bindings)
    expect(pool.state.sessions).toEqual(before.sessions)
  })

  function firstInput(options: InputOptions = {}) {
    const input = registrationInput(options)
    const terminal = input.hello.payload.terminals[0]!
    terminal.account_facts = { ...terminal.route.account_ref, currency: 'EUR', observed_at_utc_msc: Date.parse(input.connectedAt) }
    return input
  }

  it('creates a never registered account and one owner interval from server time, reusing them on reconnect', async () => {
    const pool = new FakePool()
    pool.state.accounts = []
    pool.state.ownerships = []
    const repository = createRoutes(pool.asPool())
    const input = firstInput()
    input.hello.payload.terminals[0]!.account_facts!.observed_at_utc_msc -= 59_000
    const route = await repository.authorizeAndOpen(input)
    expect(route).toMatchObject({ accountId: '43', ownershipRevision: '1', userId: 7 })
    expect(pool.state.accounts).toEqual([expect.objectContaining({ currency: 'EUR', ownershipRevision: '1' })])
    expect(pool.state.ownerships).toEqual([expect.objectContaining({ grantedAt: NOW, intervalStart: NOW, revision: '1' })])
    expect(pool.state.intervals).toHaveLength(1)
    await repository.activate(route, NOW)
    expect(await repository.isAuthorized(route)).toBe(true)
    await open(repository, { epoch: 2, connectionId: 'connection-2' })
    expect(pool.state.accounts).toHaveLength(1)
    expect(pool.state.ownerships).toHaveLength(1)
    expect(pool.state.intervals).toHaveLength(1)
  })

  it('never adds ownership to existing orphan, revoked, or other-owner accounts despite valid facts', async () => {
    for (const kind of ['orphan', 'revoked', 'other'] as const) {
      const pool = new FakePool()
      if (kind === 'orphan') pool.state.ownerships = []
      if (kind === 'revoked') pool.state.ownerships[0]!.revokedAt = NOW
      if (kind === 'other') pool.state.ownerships[0]!.userId = 8
      const before = structuredClone(pool.state)
      await expect(createRoutes(pool.asPool()).authorizeAndOpen(firstInput()))
        .rejects.toMatchObject({ code: 'bridge_route_binding_invalid', status: 403 })
      expect(pool.state).toEqual(before)
    }
  })

  it('preserves a claimed account against a different authenticated user and never overwrites its currency', async () => {
    const pool = new FakePool()
    pool.state.accounts = []
    pool.state.ownerships = []
    const repository = createRoutes(pool.asPool())
    await repository.authorizeAndOpen(firstInput())
    pool.state.credentials.push({ ...pool.state.credentials[0]!, userId: 8, profileId: 'profile-2' })
    const before = structuredClone(pool.state)
    await expect(repository.authorizeAndOpen(firstInput({ userId: 8, profileId: 'profile-2', connectionId: 'connection-2' })))
      .rejects.toMatchObject({ code: 'bridge_route_binding_invalid' })
    const mismatch = firstInput({ epoch: 2, connectionId: 'connection-2' })
    mismatch.hello.payload.terminals[0]!.account_facts!.currency = 'USD'
    await expect(repository.authorizeAndOpen(mismatch)).rejects.toMatchObject({ code: 'bridge_session_account_currency_mismatch', status: 409 })
    expect(pool.state).toEqual(before)
  })

  it('refuses soft-deleted and collation-conflicting identities without reviving or adopting them', async () => {
    for (const kind of ['deleted', 'case'] as const) {
      const pool = new FakePool()
      if (kind === 'deleted') pool.state.accounts[0]!.deletedAt = NOW
      const before = structuredClone(pool.state)
      const input = firstInput(kind === 'case' ? { brokerServer: 'dprime-demo 5' } : {})
      await expect(createRoutes(pool.asPool()).authorizeAndOpen(input))
        .rejects.toMatchObject({ code: 'bridge_route_conflict', status: 409 })
      expect(pool.state).toEqual(before)
    }
  })

  it('requires first-account facts and rejects malformed, mismatched and stale facts even for existing owners', async () => {
    const pool = new FakePool()
    pool.state.accounts = []
    await expect(open(createRoutes(pool.asPool())))
      .rejects.toMatchObject({ code: 'bridge_route_account_not_found' })
    const cases = [
      { currency: undefined }, { currency: '' }, { currency: 'USD\n' }, { currency: '1234567890123' }, { currency: '欧元' },
      { login: 'other' }, { broker_server: 'other' }, { observed_at_utc_msc: 0 },
      { observed_at_utc_msc: Number.MAX_SAFE_INTEGER + 1 }, { observed_at_utc_msc: Date.parse(NOW) - 60_001 },
      { observed_at_utc_msc: Date.parse(NOW) + 5_001 },
    ]
    for (const patch of cases) {
      const existing = new FakePool()
      const input = firstInput()
      Object.assign(input.hello.payload.terminals[0]!.account_facts!, patch)
      await expect(createRoutes(existing.asPool()).authorizeAndOpen(input)).rejects.toBeInstanceOf(BridgeGatewayError)
      expect(existing.calls).toHaveLength(0)
      if ('currency' in patch) expect(() => assertSessionHello(input.hello)).toThrow(BridgeGatewayError)
    }
  })

  it('accepts the inclusive account-fact time boundaries', async () => {
    for (const offset of [-60_000, 5_000]) {
      const pool = new FakePool()
      const input = firstInput()
      input.hello.payload.terminals[0]!.account_facts!.observed_at_utc_msc += offset
      await expect(createRoutes(pool.asPool()).authorizeAndOpen(input)).resolves.toMatchObject({ accountId: '42' })
    }
  })

  it('keeps the published currency alphabet consistent with runtime validation', () => {
    const schema = JSON.parse(readFileSync(new URL('../../contracts/bridge-v4.schema.json', import.meta.url), 'utf8'))
    const helloSchema = schema.$defs.SessionHelloPayload
    const pattern = new RegExp(helloSchema.properties.terminals.items.properties.account_facts.properties.currency.pattern)
    for (const currency of ['USD', 'USC', 'EUR', 'a._-123456789', 'USD\n', '\nUSD', 'USD ', '', '-USD', '欧元', '1234567890123']) {
      const input = firstInput()
      input.hello.payload.terminals[0]!.account_facts!.currency = currency
      if (pattern.test(currency)) expect(() => assertSessionHello(input.hello), currency).not.toThrow()
      else expect(() => assertSessionHello(input.hello), currency).toThrow(BridgeGatewayError)
    }
  })

  it('rolls back all first-account writes when credentials, profiles or later storage reject the registration', async () => {
    for (const kind of ['credential', 'entitlement', 'profile', 'interval', 'owner', 'session'] as const) {
      const pool = new FakePool()
      pool.state.accounts = []
      pool.state.ownerships = []
      if (kind === 'credential') pool.state.credentials[0]!.revokedAt = NOW
      if (kind === 'entitlement') pool.state.credentials[0]!.plan = 'free'
      if (kind === 'profile') pool.state.profiles.push({ id: 'profile-1', userId: 8, platform: 'mt5', installationId: 'install-1', deletedAt: null })
      if (kind === 'interval') pool.failOn = 'INSERT INTO trading_account_ownership_intervals'
      if (kind === 'owner') pool.failOn = 'INSERT INTO trading_account_ownerships'
      if (kind === 'session') pool.failOn = 'INSERT INTO bridge_connection_sessions'
      const before = structuredClone(pool.state)
      await expect(createRoutes(pool.asPool()).authorizeAndOpen(firstInput())).rejects.toBeInstanceOf(BridgeGatewayError)
      expect(pool.state).toEqual(before)
      expect(pool.transactions).toEqual(['begin', 'rollback', 'release'])
    }
  })

  it('fails duplicate first-account inserts without retrying or overwriting the winner', async () => {
    for (const [code, status] of [['ER_DUP_ENTRY', 409]] as const) {
      const pool = new FakePool()
      pool.state.accounts = []
      pool.state.ownerships = []
      pool.failOn = 'INSERT INTO trading_accounts'
      pool.failureCode = code
      await expect(createRoutes(pool.asPool()).authorizeAndOpen(firstInput())).rejects.toMatchObject({ status })
      expect(pool.state.accounts).toHaveLength(0)
      expect(pool.state.ownerships).toHaveLength(0)
      expect(pool.calls.filter(call => call.sql.includes('INSERT INTO trading_accounts'))).toHaveLength(1)
      expect(pool.transactions).toEqual(['begin', 'rollback', 'release'])
    }
  })

  it.each(['INSERT INTO trading_accounts', 'INSERT INTO trading_account_ownership_intervals', 'INSERT INTO bridge_connection_sessions'])(
    'rechecks first-account registration after a rolled-back deadlock at %s', async statement => {
      const pool = new FakePool()
      pool.state.accounts = []; pool.state.ownerships = []
      pool.failOn = statement; pool.failureCode = 'ER_LOCK_DEADLOCK'
      await expect(createRoutes(pool.asPool()).authorizeAndOpen(firstInput())).resolves.toMatchObject({ userId: 7 })
      expect(pool.state.accounts).toHaveLength(1)
      expect(pool.state.ownerships).toHaveLength(1)
      expect(pool.state.intervals).toHaveLength(1)
      expect(pool.state.sessions).toHaveLength(1)
      expect(pool.transactions).toEqual(['begin', 'rollback', 'release', 'begin', 'commit', 'release'])
    })

  it('maps registration port failures to existing errors and rolls back the same transaction', async () => {
    for (const stage of ['create', 'grant'] as const) {
      for (const reason of ['storage_invalid', 'storage_unavailable'] as const) {
        const pool = new FakePool()
        pool.state.accounts = []
        pool.state.ownerships = []
        const before = structuredClone(pool.state)
        const repository = createBridgeGatewayRoutes(pool.asPool(), connection => {
          const registration = createAccountRegistration(connection, createActivePrincipalAccess(connection))
          return {
            lockAccount: registration.lockAccount.bind(registration),
            lockCurrentOwnership: registration.lockCurrentOwnership.bind(registration),
            createAccount: stage === 'create' ? async () => ({ ok: false as const, reason }) : registration.createAccount.bind(registration),
            grantFirstOwnership: stage === 'grant' ? async () => ({ ok: false as const, reason }) : registration.grantFirstOwnership.bind(registration),
          }
        })
        await expect(repository.authorizeAndOpen(firstInput())).rejects.toMatchObject({ code: `bridge_route_${reason}`, status: 503 })
        expect(pool.state).toEqual(before)
        expect(pool.transactions).toEqual(['begin', 'rollback', 'release'])
      }
    }
  })

  it('registers a first profile and owner binding, then returns frozen proof', async () => {
    const pool = new FakePool()
    const route = await open(createRoutes(pool.asPool()))

    expect(route).toMatchObject({ userId: 7, accountId: '42', platform: 'mt5', brokerServer: 'DPrime-Demo 5',
      login: '8950701', terminalProfileId: 'profile-1', installationId: 'install-1', credentialGeneration: 2,
      ownershipRevision: '3', connectionEpoch: 1 })
    expect(pool.state.profiles).toEqual([expect.objectContaining({ id: 'profile-1', userId: 7, platform: 'mt5',
      installationId: 'install-1', deletedAt: null })])
    expect(pool.state.bindings).toEqual([expect.objectContaining({ profileId: 'profile-1', accountId: '42',
      instanceId: 'instance-1', unboundAt: null })])
    expect(pool.state.sessions).toEqual([expect.objectContaining({ reason: 'bridge_session_pending', epoch: 1 })])
    const names = pool.calls.map(call => call.sql)
    expect(names.findIndex(sql => sql.includes('SELECT CAST(a.id AS CHAR) id')))
      .toBeLessThan(names.findIndex(sql => sql.includes('SELECT CAST(a.ownership_revision AS CHAR)')))
    expect(names.findIndex(sql => sql.includes('SELECT CAST(a.ownership_revision AS CHAR)')))
      .toBeLessThan(names.findIndex(sql => sql.startsWith('SELECT id FROM users WHERE id=?')))
    expect(names.findIndex(sql => sql.startsWith('SELECT id FROM users WHERE id=?')))
      .toBeLessThan(names.findIndex(sql => sql.includes('SELECT s.user_id,s.generation')))
    expect(names.find(sql => sql.startsWith('SELECT id FROM users WHERE id=?'))).toContain('FOR UPDATE')
    expect(names.every(sql => !/SELECT\s+\*/i.test(sql))).toBe(true)
    const credentialSql = names.find(sql => sql.includes('SELECT s.user_id,s.generation')) ?? ''
    expect(credentialSql).toMatch(/s\.credential_version=4/)
    expect(credentialSql).toMatch(/u\.plan='pro'/)
    expect(credentialSql).not.toMatch(/s\.expires_at\s*>/)
    const ownershipSql = names.find(sql => sql.includes('SELECT CAST(a.ownership_revision AS CHAR)')) ?? ''
    expect(ownershipSql).toMatch(/o\.role='owner'/)
    expect(ownershipSql).toMatch(/oi\.ended_at_utc IS NULL/)
    expect(ownershipSql).toMatch(/o\.revision=a\.ownership_revision/)
    expect(ownershipSql).not.toMatch(/JOIN users/)
    // A shared user/owner lock followed by the credential's update lock
    // would introduce a needless lock-upgrade race across two connections.
    expect(ownershipSql).toContain('FOR UPDATE')
    expect(ownershipSql).not.toContain('FOR SHARE')
    const epochSql = names.find(sql => sql.includes('SELECT connection_epoch_v4')) ?? ''
    expect(epochSql).toMatch(/user_id=\? AND terminal_profile_id=\?/)
  })

  it('does not duplicate an identical binding on reconnect', async () => {
    const pool = new FakePool()
    const repository = createRoutes(pool.asPool())
    await open(repository)
    await open(repository, { epoch: 2, connectionId: 'connection-2', sessionId: 'session-2' })
    expect(pool.state.bindings).toHaveLength(1)
    expect(pool.state.bindings[0]).toMatchObject({ accountId: '42', unboundAt: null })
    expect(pool.state.sessions).toHaveLength(2)
  })

  it('closes the old binding and preserves its history when changing accounts', async () => {
    const pool = new FakePool()
    addAccount(pool, '43', '8950702', '4')
    const repository = createRoutes(pool.asPool())
    await open(repository)
    await open(repository, { login: '8950702', epoch: 2, connectionId: 'connection-2', sessionId: 'session-2' })
    expect(pool.state.bindings).toHaveLength(2)
    expect(pool.state.bindings.find(row => row.accountId === '42')).toMatchObject({ unboundAt: NOW })
    expect(pool.state.bindings.find(row => row.accountId === '43')).toMatchObject({ unboundAt: null })
    expect(pool.state.sessions).toHaveLength(2)
  })

  it('requires exact account identity and ticket/profile agreement', async () => {
    const cases: Array<{ name: string; options: InputOptions; expected: string; prepare?: (pool: FakePool) => void }> = [
      { name: 'mt4 cannot use an mt5 account', options: { platform: 'mt4' }, expected: 'bridge_route_account_not_found' },
      { name: 'server is binary exact', options: { brokerServer: 'dprimE-demo 5' }, expected: 'bridge_route_account_not_found' },
      { name: 'login is binary exact', options: { login: '8950701 ' }, expected: 'bridge_route_account_not_found' },
      { name: 'cross user credential is denied', options: { userId: 8 }, expected: 'bridge_route_binding_invalid' },
      { name: 'hello cannot change the ticket installation', options: { installationId: 'install-2' }, expected: 'bridge_route_binding_invalid' },
      { name: 'another owner profile cannot be adopted', options: {}, expected: 'bridge_route_binding_invalid',
        prepare: pool => pool.state.profiles.push({ id: 'profile-1', userId: 8, platform: 'mt5', installationId: 'install-1', deletedAt: null }) },
    ]
    for (const value of cases) {
      const pool = new FakePool()
      value.prepare?.(pool)
      await expect(open(createRoutes(pool.asPool()), value.options), value.name)
        .rejects.toSatisfy(error => errorCode(error) === value.expected)
    }
  })

  it('fails closed for missing/old ownership and invalid credentials', async () => {
    const cases: Array<{ name: string; mutate: (pool: FakePool) => void }> = [
      { name: 'no owner', mutate: pool => { pool.state.ownerships = [] } },
      { name: 'closed ownership interval', mutate: pool => { pool.state.ownerships[0]!.intervalEnd = LATER } },
      { name: 'old account revision', mutate: pool => { pool.state.accounts[0]!.ownershipRevision = '4' } },
      { name: 'revoked credential', mutate: pool => { pool.state.credentials[0]!.revokedAt = LATER } },
      { name: 'expired pro plan', mutate: pool => { pool.state.credentials[0]!.planExpiresAt = '2020-01-01T00:00:00.000Z' } },
      { name: 'multiple current credentials', mutate: pool => { pool.state.credentials.push({ ...pool.state.credentials[0]! }) } },
    ]
    for (const value of cases) {
      const pool = new FakePool()
      value.mutate(pool)
      await expect(open(createRoutes(pool.asPool())), value.name)
        .rejects.toSatisfy(error => errorCode(error) === 'bridge_route_binding_invalid')
    }
  })

  it('rejects a stale profile epoch before changing bindings', async () => {
    const pool = new FakePool()
    const repository = createRoutes(pool.asPool())
    await open(repository, { epoch: 4 })
    const before = { profiles: pool.state.profiles.length, bindings: pool.state.bindings.length, sessions: pool.state.sessions.length }
    await expect(open(repository, { epoch: 3, connectionId: 'connection-3', sessionId: 'session-3' }))
      .rejects.toMatchObject({ code: 'bridge_connection_epoch_stale', status: 409 })
    expect(pool.state.profiles).toHaveLength(before.profiles)
    expect(pool.state.bindings).toHaveLength(before.bindings)
    expect(pool.state.sessions).toHaveLength(before.sessions)
  })

  it('does not activate or keep an active route after credential or ownership proof changes', async () => {
    const pendingCases: Array<{ name: string; mutate: (pool: FakePool) => void }> = [
      { name: 'credential revoked while pending', mutate: pool => { pool.state.credentials[0]!.revokedAt = LATER } },
      { name: 'credential generation rotated while pending', mutate: pool => {
        pool.state.credentials[0]!.generation = 3
      } },
      { name: 'ownership revision changed while pending', mutate: pool => {
        pool.state.accounts[0]!.ownershipRevision = '4'
      } },
    ]
    for (const value of pendingCases) {
      const pool = new FakePool()
      const repository = createRoutes(pool.asPool())
      const route = await open(repository)
      value.mutate(pool)
      await expect(repository.activate(route, LATER), value.name)
        .rejects.toMatchObject({ code: 'bridge_session_open_missing', status: 409 })
      expect(pool.state.sessions[0]).toMatchObject({ reason: 'bridge_session_pending' })
    }

    const activeCases: Array<{ name: string; mutate: (pool: FakePool) => void }> = [
      { name: 'credential revoked while active', mutate: pool => { pool.state.credentials[0]!.revokedAt = LATER } },
      { name: 'credential generation rotated while active', mutate: pool => {
        pool.state.credentials[0]!.generation = 3
      } },
      { name: 'ownership revision changed while active', mutate: pool => {
        pool.state.accounts[0]!.ownershipRevision = '4'
      } },
    ]
    for (const value of activeCases) {
      const pool = new FakePool()
      const repository = createRoutes(pool.asPool())
      const route = await open(repository)
      await repository.activate(route, LATER)
      value.mutate(pool)
      await expect(repository.touch(route, LATER), value.name).resolves.toBe(false)
      await expect(repository.isAuthorized(route), value.name).resolves.toBe(false)
    }
  })

  it('does not adopt deleted or mismatched profiles', async () => {
    const cases: Array<{ name: string; prepare: (pool: FakePool) => InputOptions }> = [
      { name: 'profile belongs to another user', prepare: pool => {
        pool.state.profiles.push({ id: 'profile-1', userId: 8, platform: 'mt5', installationId: 'install-1', deletedAt: null })
        return {}
      } },
      { name: 'profile installation is immutable', prepare: pool => {
        pool.state.profiles.push({ id: 'profile-1', userId: 7, platform: 'mt5', installationId: 'install-2', deletedAt: null })
        return {}
      } },
      { name: 'deleted profile cannot be revived', prepare: pool => {
        pool.state.profiles.push({ id: 'profile-1', userId: 7, platform: 'mt5', installationId: 'install-1', deletedAt: LATER })
        return {}
      } },
    ]
    for (const value of cases) {
      const pool = new FakePool()
      const options = value.prepare(pool)
      await expect(open(createRoutes(pool.asPool()), options), value.name)
        .rejects.toSatisfy(error => errorCode(error) === 'bridge_route_binding_invalid')
    }
  })

  it('switches an owned MT5 profile to an owned MT4 account without replacing its credential', async () => {
    const pool = new FakePool()
    const repository = createRoutes(pool.asPool())
    const old = await open(repository)
    await repository.activate(old, NOW)
    pool.state.accounts.push({ id: '44', platform: 'mt4', brokerServer: 'DPrime-Demo 5', login: '8950704', deletedAt: null, ownershipRevision: '1' })
    pool.state.ownerships.push({ ...pool.state.ownerships[0]!, accountId: '44', revision: '1', intervalId: 'interval-44' })
    const credentials = structuredClone(pool.state.credentials)
    const switched = await open(repository, { platform: 'mt4', login: '8950704', epoch: 2, connectedAt: LATER, connectionId: 'connection-2' })
    expect(switched.terminalProfileId).toBe(old.terminalProfileId)
    expect(pool.state.credentials).toEqual(credentials)
    expect(pool.state.profiles[0]!.platform).toBe('mt4')
    expect(pool.state.bindings[0]!.unboundAt).not.toBeNull()
    await expect(repository.isAuthorized(old)).resolves.toBe(false)
    await repository.activate(switched, LATER)
    await expect(repository.isAuthorized(switched)).resolves.toBe(true)
  })

  it('rolls back a platform change when a later epoch check fails', async () => {
    const pool = new FakePool()
    const repository = createRoutes(pool.asPool())
    await open(repository, { epoch: 5 })
    pool.state.accounts.push({ id: '44', platform: 'mt4', brokerServer: 'DPrime-Demo 5', login: '8950704', deletedAt: null, ownershipRevision: '1' })
    pool.state.ownerships.push({ ...pool.state.ownerships[0]!, accountId: '44', revision: '1', intervalId: 'interval-44' })
    await expect(open(repository, { platform: 'mt4', login: '8950704', epoch: 4 })).rejects.toBeInstanceOf(BridgeGatewayError)
    expect(pool.state.profiles[0]!.platform).toBe('mt5')
    expect(pool.state.bindings).toHaveLength(1)
  })

  it('rolls back profile/binding/session writes on a mid-transaction storage error', async () => {
    const pool = new FakePool()
    pool.failOn = 'INSERT INTO bridge_connection_sessions'
    await expect(open(createRoutes(pool.asPool())))
      .rejects.toMatchObject({ code: 'bridge_route_storage_unavailable', status: 503 })
    expect(pool.state.profiles).toHaveLength(0)
    expect(pool.state.bindings).toHaveLength(0)
    expect(pool.state.sessions).toHaveLength(0)
    expect(pool.transactions).toEqual(['begin', 'rollback', 'release'])
  })

  it('activates only the latest pending proof and replaces the prior active session', async () => {
    const pool = new FakePool()
    const repository = createRoutes(pool.asPool())
    const first = await open(repository)
    await repository.activate(first, LATER)
    expect(pool.state.sessions[0]).toMatchObject({ disconnectedAt: null, reason: null })
    const second = await open(repository, { epoch: 2, connectionId: 'connection-2', sessionId: 'session-2' })
    await repository.activate(second, LATER)
    expect(pool.state.sessions.find(row => row.id === '1')).toMatchObject({ reason: 'bridge_connection_replaced' })
    expect(pool.state.sessions.find(row => row.id === '2')).toMatchObject({ disconnectedAt: null, reason: null })
    await expect(repository.activate(first, LATER)).rejects.toMatchObject({ code: 'bridge_session_open_missing', status: 409 })
    await expect(repository.isAuthorized(first)).resolves.toBe(false)
    await expect(repository.isAuthorized(second)).resolves.toBe(true)
  })

  it('touches and authorizes an active route, then fails closed after binding revocation', async () => {
    const pool = new FakePool()
    const repository = createRoutes(pool.asPool())
    const route = await open(repository)
    await repository.activate(route, LATER)
    await expect(repository.touch(route, LATER)).resolves.toBe(true)
    await expect(repository.isAuthorized(route)).resolves.toBe(true)
    pool.state.bindings[0]!.unboundAt = LATER
    await expect(repository.touch(route, LATER)).resolves.toBe(false)
    await expect(repository.isAuthorized(route)).resolves.toBe(false)
    const legacy: BridgeGatewayRoute = { ...route }
    delete legacy.installationId
    delete legacy.credentialGeneration
    delete legacy.ownershipRevision
    await expect(repository.isAuthorized(legacy)).resolves.toBe(false)
  })

  it('scopes epochs to user/profile: a new profile may start at a low epoch', async () => {
    const pool = new FakePool()
    const repository = createRoutes(pool.asPool())
    await open(repository, { epoch: 9 })
    pool.state.credentials.push({ ...pool.state.credentials[0]!, installationId: 'install-2', profileId: 'profile-2' })
    const second = await open(repository, { profileId: 'profile-2', installationId: 'install-2', epoch: 1,
      connectionId: 'connection-2', sessionId: 'session-2' })
    expect(second.terminalProfileId).toBe('profile-2')
    expect(second.connectionEpoch).toBe(1)
    await expect(open(repository, { epoch: 8, instanceId: 'instance-2', connectionId: 'connection-3', sessionId: 'session-3' }))
      .rejects.toMatchObject({ code: 'bridge_connection_epoch_stale', status: 409 })
    const epochCall = pool.calls.find(call => call.sql.includes('SELECT connection_epoch_v4'))
    expect(epochCall?.params).toEqual([7, 'profile-1'])
  })

  it('translates database failures and always releases the transaction connection', async () => {
    const pool = new FakePool()
    pool.failOn = 'SELECT CAST(a.id AS CHAR) id'
    await expect(open(createRoutes(pool.asPool())))
      .rejects.toMatchObject({ code: 'bridge_route_storage_unavailable', status: 503 })
    expect(pool.transactions).toEqual(['begin', 'rollback', 'release'])
  })
})
