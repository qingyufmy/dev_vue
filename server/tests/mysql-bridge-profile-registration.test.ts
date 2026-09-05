import type { Pool } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import type { BridgeGatewayRoute, BridgeSessionHelloEnvelope } from '../src/modules/bridge/domain/bridge-gateway.js'
import { BridgeGatewayError } from '../src/modules/bridge/domain/bridge-gateway.js'
import { MysqlBridgeGatewayRouteRepository } from '../src/modules/bridge/infrastructure/mysql-bridge-gateway-route-repository.js'

const NOW = '2026-09-06T00:00:00.000Z'
const LATER = '2026-09-06T00:01:00.000Z'

interface Account {
  id: string
  platform: 'mt4' | 'mt5'
  brokerServer: string
  login: string
  deletedAt: string | null
  ownershipRevision: string
}

interface Credential {
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
      deletedAt: null, ownershipRevision: '3',
    }],
    credentials: [{
      userId: 7, installationId: 'install-1', profileId: 'profile-1', generation: 2,
      credentialVersion: 4, revokedAt: null, role: 'user', plan: 'pro', planExpiresAt: '2099-01-01T00:00:00.000Z',
      deletionStatus: 'active', deletedAt: null,
    }],
    profiles: [],
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
      throw sqlError('simulated storage failure', 'ER_LOCK_WAIT_TIMEOUT')
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
        .map(row => ({ id: row.id, platform: row.platform, broker_server: row.brokerServer, account_login: row.login }))
      return [rows as T, []]
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

    if (sql.includes('INSERT INTO terminal_profiles')) {
      const [id, userId, _displayName, platform, installationId] = params.map(String) as [string, string, string, string, string]
      if (this.current.profiles.some(row => row.id === id)) throw sqlError('duplicate profile', 'ER_DUP_ENTRY')
      this.current.profiles.push({ id, userId: Number(userId), platform: platform as 'mt4' | 'mt5',
        installationId, deletedAt: null })
      return [{ affectedRows: 1 } as T, []]
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
    claims: claims(options), hello: hello(options), connectionId: options.connectionId ?? 'connection-1', connectedAt: NOW,
  }
}

async function open(repository: MysqlBridgeGatewayRouteRepository, options: InputOptions = {}) {
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
  it('registers a first profile and owner binding, then returns frozen proof', async () => {
    const pool = new FakePool()
    const route = await open(new MysqlBridgeGatewayRouteRepository(pool.asPool()))

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
      .toBeLessThan(names.findIndex(sql => sql.includes('SELECT s.user_id,s.generation')))
    expect(names.every(sql => !/SELECT\s+\*/i.test(sql))).toBe(true)
    const credentialSql = names.find(sql => sql.includes('SELECT s.user_id,s.generation')) ?? ''
    expect(credentialSql).toMatch(/s\.credential_version=4/)
    expect(credentialSql).toMatch(/u\.plan='pro'/)
    expect(credentialSql).not.toMatch(/s\.expires_at\s*>/)
    const ownershipSql = names.find(sql => sql.includes('SELECT CAST(a.ownership_revision AS CHAR)')) ?? ''
    expect(ownershipSql).toMatch(/o\.role='owner'/)
    expect(ownershipSql).toMatch(/oi\.ended_at_utc IS NULL/)
    expect(ownershipSql).toMatch(/o\.revision=a\.ownership_revision/)
    // A shared user/owner lock followed by the credential's update lock
    // would introduce a needless lock-upgrade race across two connections.
    expect(ownershipSql).toContain('FOR UPDATE')
    expect(ownershipSql).not.toContain('FOR SHARE')
    const epochSql = names.find(sql => sql.includes('SELECT connection_epoch_v4')) ?? ''
    expect(epochSql).toMatch(/user_id=\? AND terminal_profile_id=\?/)
  })

  it('does not duplicate an identical binding on reconnect', async () => {
    const pool = new FakePool()
    const repository = new MysqlBridgeGatewayRouteRepository(pool.asPool())
    await open(repository)
    await open(repository, { epoch: 2, connectionId: 'connection-2', sessionId: 'session-2' })
    expect(pool.state.bindings).toHaveLength(1)
    expect(pool.state.bindings[0]).toMatchObject({ accountId: '42', unboundAt: null })
    expect(pool.state.sessions).toHaveLength(2)
  })

  it('closes the old binding and preserves its history when changing accounts', async () => {
    const pool = new FakePool()
    addAccount(pool, '43', '8950702', '4')
    const repository = new MysqlBridgeGatewayRouteRepository(pool.asPool())
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
      await expect(open(new MysqlBridgeGatewayRouteRepository(pool.asPool()), value.options), value.name)
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
      await expect(open(new MysqlBridgeGatewayRouteRepository(pool.asPool())), value.name)
        .rejects.toSatisfy(error => errorCode(error) === 'bridge_route_binding_invalid')
    }
  })

  it('rejects a stale profile epoch before changing bindings', async () => {
    const pool = new FakePool()
    const repository = new MysqlBridgeGatewayRouteRepository(pool.asPool())
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
      const repository = new MysqlBridgeGatewayRouteRepository(pool.asPool())
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
      const repository = new MysqlBridgeGatewayRouteRepository(pool.asPool())
      const route = await open(repository)
      await repository.activate(route, LATER)
      value.mutate(pool)
      await expect(repository.touch(route, LATER), value.name).resolves.toBe(false)
      await expect(repository.isAuthorized(route), value.name).resolves.toBe(false)
    }
  })

  it('does not adopt deleted, mismatched, or cross-platform profiles', async () => {
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
      { name: 'mt4 route cannot reuse an mt5 profile', prepare: pool => {
        pool.state.accounts.push({ id: '44', platform: 'mt4', brokerServer: 'DPrime-Demo 5', login: '8950704', deletedAt: null, ownershipRevision: '1' })
        pool.state.ownerships.push({ userId: 7, accountId: '44', revision: '1', intervalId: 'interval-44', role: 'owner', revokedAt: null,
          intervalRole: 'owner', intervalStart: '2026-09-01T00:00:00.000Z', intervalEnd: null, grantedAt: '2026-09-01T00:00:00.000Z' })
        pool.state.profiles.push({ id: 'profile-1', userId: 7, platform: 'mt5', installationId: 'install-1', deletedAt: null })
        return { platform: 'mt4', login: '8950704' }
      } },
    ]
    for (const value of cases) {
      const pool = new FakePool()
      const options = value.prepare(pool)
      await expect(open(new MysqlBridgeGatewayRouteRepository(pool.asPool()), options), value.name)
        .rejects.toSatisfy(error => errorCode(error) === 'bridge_route_binding_invalid')
    }
  })

  it('rolls back profile/binding/session writes on a mid-transaction storage error', async () => {
    const pool = new FakePool()
    pool.failOn = 'INSERT INTO bridge_connection_sessions'
    await expect(open(new MysqlBridgeGatewayRouteRepository(pool.asPool())))
      .rejects.toMatchObject({ code: 'bridge_route_storage_unavailable', status: 503 })
    expect(pool.state.profiles).toHaveLength(0)
    expect(pool.state.bindings).toHaveLength(0)
    expect(pool.state.sessions).toHaveLength(0)
    expect(pool.transactions).toEqual(['begin', 'rollback', 'release'])
  })

  it('activates only the latest pending proof and replaces the prior active session', async () => {
    const pool = new FakePool()
    const repository = new MysqlBridgeGatewayRouteRepository(pool.asPool())
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
    const repository = new MysqlBridgeGatewayRouteRepository(pool.asPool())
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
    const repository = new MysqlBridgeGatewayRouteRepository(pool.asPool())
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
    await expect(open(new MysqlBridgeGatewayRouteRepository(pool.asPool())))
      .rejects.toMatchObject({ code: 'bridge_route_storage_unavailable', status: 503 })
    expect(pool.transactions).toEqual(['begin', 'rollback', 'release'])
  })
})
