import { BrowserRealtimeHub } from '../src/modules/trading/transport/realtime/browser-realtime-hub.js'
import { readFile } from 'node:fs/promises'
import type { Pool } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import { type TradingReadRepository, type AccountLiveRouteReader } from '../src/modules/trading/index.js'
import { MysqlTradingRepository } from '../src/modules/trading/infrastructure/mysql-trading-repository.js'
import { createProjectionReservationAbsorber } from '../src/modules/execution/composition.js'

type Row = Record<string, unknown>

class FakePool {
  readonly calls: Array<{ sql: string; params: unknown[] }> = []
  currentRows: Row[] = []
  historyRows: Row[] = []
  heartbeatRows: Row[] = []
  permissionRows: Row[] = []
  snapshotRows: Row[] = []
  sourceRows: Row[] = []
  sourceRowsQueue: Row[][] = []
  positionRows: Row[] = []
  trustedAccountRows: Row[] = [{ id: '42' }]
  trustedOwnerRows: Row[] = [{ interval_id: 'interval-a', ownership_revision: 3 }]
  trustedCredentialRows: Row[] = [{ id: 1 }]
  trustedCredentialGeneration = 1
  trustedBindingRows: Row[] = [{ terminal_profile_id: 'profile-a' }]
  trustedSessionRows: Row[] = [{ id: 1 }]
  clockRows: Row[] = []
  trustedRevisionRows: Row[] = [{ revision: 0 }]
  transactionCalls: string[] = []

  async execute(sql: string, params: unknown[] = []) {
    const placeholders = (sql.match(/\?/g) ?? []).length
    if (placeholders !== params.length) throw new Error(`fake_sql_params:${placeholders}:${params.length}`)
    this.calls.push({ sql, params })
    if (sql.startsWith('SELECT id FROM trading_accounts WHERE id=')) return [this.trustedAccountRows, []]
    if (sql.includes('SELECT o.interval_id')) return [this.trustedOwnerRows, []]
    if (sql.includes('FROM bridge_refresh_sessions s') && sql.includes('s.credential_version=4')) {
      return Number(params[4]) === this.trustedCredentialGeneration ? [this.trustedCredentialRows, []] : [[], []]
    }
    if (sql.includes('SELECT b.terminal_profile_id')) return [this.trustedBindingRows, []]
    if (sql.includes('SELECT s.id')) return [this.trustedSessionRows, []]
    if (sql.includes('SELECT s.last_seen_at_utc')) return [this.heartbeatRows, []]
    if (sql.includes('WHERE EXISTS (') && sql.includes('trading_account_ownership_intervals')) return [this.historyRows, []]
    if (sql.includes('SELECT snap.timezone_offset_minutes,snap.clock_status')) return [this.clockRows, []]
    if (sql.includes('FROM account_runtime_snapshots snap') && sql.includes('snap.balance')) return [this.snapshotRows, []]
    if (sql.includes('FROM account_runtime_snapshots snap') && sql.includes('snap.trade_permission')) return [this.permissionRows, []]
    if (sql.includes('FROM trading_projection_revisions pr') && sql.includes('LEFT JOIN trading_projection_provenance_v4')) return [this.sourceRowsQueue.shift() ?? this.sourceRows, []]
    if (sql.includes('FROM open_position_snapshots')) return [this.positionRows, []]
    if (sql.includes('SELECT revision FROM trading_projection_revisions') && sql.includes('FOR UPDATE')) return [this.trustedRevisionRows, []]
    if (sql.includes('FROM trading_accounts a') && sql.includes('INNER JOIN trading_account_ownership_intervals oi')) return [this.currentRows, []]
    return [[], []]
  }

  async getConnection() { return this }
  async beginTransaction() { this.transactionCalls.push('begin') }
  async commit() { this.transactionCalls.push('commit') }
  async rollback() { this.transactionCalls.push('rollback') }
  release() { this.transactionCalls.push('release') }

  asPool() { return this as unknown as Pool }
}

function account(overrides: Row = {}): Row {
  return {
    id: '42', platform: 'mt5', account_login: '596520', broker_server: 'Demo', currency: 'USD',
    owner_user_id: 7, ownership_interval_id: 'interval-a', ownership_revision: 3,
    profile_id: 'profile-a', terminal_instance_id: 'instance-a', bridge_state: 'offline',
    trade_permission: 0, snapshot_trade_permission: 0, connection_paused: 0, last_seen_at_utc: null,
    ...overrides,
  }
}

function route(overrides: Partial<BridgeGatewayRoute> = {}): BridgeGatewayRoute {
  return {
    userId: 7, accountId: '42', platform: 'mt5', brokerServer: 'Demo', login: '596520',
    terminalProfileId: 'profile-a', terminalInstanceId: 'instance-a', connectionEpoch: 4,
    connectionId: 'connection-a', sessionId: 'session-a', timezoneOffsetMinutes: 0,
    installationId: 'installation-a', credentialGeneration: 1, ownershipRevision: '3',
    ...overrides,
  }
}

function source(overrides: Row = {}): Row {
  return {
    revision: 4, source_user_id: 7, source_interval_id: 'interval-a', source_ownership_revision: 3,
    source_profile_id: 'profile-a', source_instance_id: 'instance-a', source_connection_epoch: 4,
    projection_revision: 4, ...overrides,
  }
}

function snapshot(overrides: Row = {}): Row {
  return {
    ...account(), ...source(), trade_permission: 1, balance: '10000.00', equity: '10010.00',
    margin_amount: '100.00', free_margin: '9910.00', floating_profit: '10.00', leverage: 100,
    timezone_offset_minutes: 0, clock_status: 'calibrated', observed_at_utc: new Date('2026-09-05T08:00:00.000Z'), revision: 4,
    ...overrides,
  }
}

function leaseFor(value: BridgeGatewayRoute | null) {
  return { current: vi.fn(async () => value) }
}

describe('MysqlTradingRepository P3 offline account read model', () => {
  it('accepts only the consumer route fields and rejects an epoch mismatch in private projections', async () => {
    const pool = new FakePool()
    pool.currentRows = [account()]
    pool.heartbeatRows = [{ last_seen_at_utc: new Date() }]
    pool.permissionRows = [source({ trade_permission: 1 })]
    pool.sourceRows = [source({ source_connection_epoch: 3 })]
    const reader: AccountLiveRouteReader = { current: async () => ({
      userId: 7, accountId: '42', platform: 'mt5', brokerServer: 'Demo', login: '596520',
      terminalProfileId: 'profile-a', terminalInstanceId: 'instance-a', connectionId: 'connection-a', connectionEpoch: 4,
    }) }
    const repository = new MysqlTradingRepository(pool.asPool(), reader)
    expect((await repository.listAccounts(7))[0]?.bridgeState).toBe('online')
    await expect(repository.listPositions('42', 7)).resolves.toEqual({ revision: 0, items: [] })
    expect(pool.calls.some(call => call.sql.includes('FROM open_position_snapshots'))).toBe(false)
  })

  it.each([false, true])('commits or rolls back absorption on the projection connection (event failure=%s)', async eventFailure => {
    const pool = new FakePool()
    const original = pool.execute.bind(pool)
    pool.execute = async (sql, params = []) => {
      if (sql.includes('FROM risk_reservations_v4 r')) return [[{
        reservation_id: 'reservation-1', reservation_revision: 2, action: 'position.close',
        params_json: { ticket: '123' }, expected_state_json: null, result_json: {},
        action_json: { expectedState: { positionsRevision: 1 } }, completed_at_utc: new Date('2026-09-05T07:00:00Z'),
      }], []]
      if (sql.includes('UPDATE risk_reservations_v4')) {
        pool.transactionCalls.push('reservation-update')
        return [{ affectedRows: 1 }, []] as never
      }
      if (sql.includes('INSERT INTO risk_reservation_events_v4')) {
        pool.transactionCalls.push('reservation-event')
        if (eventFailure) throw new Error('event-write-failed')
      }
      return original(sql, params)
    }
    const repository = new MysqlTradingRepository(pool.asPool(), null, undefined, connection => {
      expect(connection).toBe(pool)
      expect(pool.calls.some(call => call.sql.includes('INSERT INTO trading_projection_provenance_v4'))).toBe(true)
      return createProjectionReservationAbsorber(connection)
    })
    const write = repository.applyTrustedProjection({ route: route(),
      projection: { accountId: '42', resource: 'positions', resourceId: 'open', revision: 4, data: [] },
      tradeStates: [], observedAt: '2026-09-05T08:00:00.000Z',
    })
    if (eventFailure) await expect(write).rejects.toThrow('event-write-failed')
    else await expect(write).resolves.toEqual({ applied: true, absorbedReservationIds: ['reservation-1'] })
    expect(pool.transactionCalls).toEqual(['begin', 'reservation-update', 'reservation-event', eventFailure ? 'rollback' : 'commit', 'release'])
  })

  it('rolls back a position projection when the absorption capability is absent', async () => {
    const pool = new FakePool()
    await expect(new MysqlTradingRepository(pool.asPool()).applyTrustedProjection({ route: route(),
      projection: { accountId: '42', resource: 'positions', resourceId: 'open', revision: 4, data: [] },
      tradeStates: [], observedAt: '2026-09-05T08:00:00.000Z',
    })).rejects.toThrow('projection_reservation_absorber_unavailable')
    expect(pool.transactionCalls).toEqual(['begin', 'rollback', 'release'])
  })

  it('keeps account identity visible without a profile and separates history from current access', async () => {
    const pool = new FakePool()
    pool.currentRows = [account({ profile_id: null, terminal_instance_id: null })]
    const current = await new MysqlTradingRepository(pool.asPool(), leaseFor(route())).listAccounts(7)
    expect(current).toEqual([expect.objectContaining({ id: '42', terminalProfileId: null, terminalInstanceId: null, bridgeState: 'offline', tradePermission: false })])

    pool.historyRows = [account({ profile_id: null, terminal_instance_id: null })]
    const history = await new MysqlTradingRepository(pool.asPool(), leaseFor(route())).listAccounts(7, 'history')
    expect(history).toEqual([expect.objectContaining({ id: '42', terminalProfileId: null, terminalInstanceId: null, bridgeState: 'offline', tradePermission: false })])
    const historySql = pool.calls.find(call => call.sql.includes('WHERE EXISTS ('))?.sql ?? ''
    expect(historySql).not.toContain('a.deleted_at_utc IS NULL')
  })

  it('requires a Redis route and fresh SQL heartbeat before reporting online', async () => {
    const cases: Array<{ name: string; lease: BridgeGatewayRoute | null; heartbeat: Row[]; row?: Row; expected: 'online' | 'offline' | 'paused' }> = [
      { name: 'fresh matching lease and heartbeat', lease: route(), heartbeat: [{ last_seen_at_utc: new Date() }], expected: 'online' },
      { name: 'missing lease', lease: null, heartbeat: [{ last_seen_at_utc: new Date() }], expected: 'offline' },
      { name: 'stale heartbeat', lease: route(), heartbeat: [], expected: 'offline' },
      { name: 'different user', lease: route({ userId: 8 }), heartbeat: [{ last_seen_at_utc: new Date() }], expected: 'offline' },
      { name: 'different profile', lease: route({ terminalProfileId: 'profile-b' }), heartbeat: [{ last_seen_at_utc: new Date() }], expected: 'offline' },
      { name: 'paused account', lease: route(), heartbeat: [{ last_seen_at_utc: new Date() }], row: account({ connection_paused: 1 }), expected: 'paused' },
    ]
    for (const value of cases) {
      const pool = new FakePool(); pool.currentRows = [value.row ?? account()]; pool.heartbeatRows = value.heartbeat
      pool.permissionRows = [source({ trade_permission: 1 })]
      const leases = leaseFor(value.lease)
      const result = (await new MysqlTradingRepository(pool.asPool(), leases).listAccounts(7))[0]!
      expect(result.bridgeState, value.name).toBe(value.expected)
      expect(result.tradePermission, value.name).toBe(value.expected === 'online')
      expect(leases.current).toHaveBeenCalledTimes(value.expected === 'paused' ? 0 : 1)
    }

    const zeroPool = new FakePool(); zeroPool.currentRows = [account()]
    zeroPool.heartbeatRows = [{ last_seen_at_utc: new Date() }]
    zeroPool.permissionRows = [source({ trade_permission: 0 })]
    const zero = (await new MysqlTradingRepository(zeroPool.asPool(), leaseFor(route())).listAccounts(7))[0]!
    expect(zero).toMatchObject({ bridgeState: 'online', tradePermission: false })
  })

  it('fails closed when the lease reader is absent or Redis throws', async () => {
    const pool = new FakePool(); pool.currentRows = [account()]
    const unavailable = { current: vi.fn(async () => { throw new Error('redis_unavailable') }) }
    await expect(new MysqlTradingRepository(pool.asPool(), unavailable).listAccounts(7)).resolves.toEqual([
      expect.objectContaining({ bridgeState: 'offline', tradePermission: false, lastSeenAt: null }),
    ])
    await expect(new MysqlTradingRepository(pool.asPool()).listAccounts(7)).resolves.toEqual([
      expect.objectContaining({ bridgeState: 'offline', tradePermission: false, lastSeenAt: null }),
    ])
  })

  it('only returns a private snapshot when its owner interval, binding, epoch and revision proof still match', async () => {
    const pool = new FakePool()
    pool.currentRows = [account()]
    pool.snapshotRows = [snapshot()]
    pool.sourceRows = [source()]
    pool.heartbeatRows = [{ last_seen_at_utc: new Date() }]
    pool.permissionRows = [source({ trade_permission: 1 })]
    const repository = new MysqlTradingRepository(pool.asPool(), leaseFor(route()))
    await expect(repository.getAccountSnapshot('42', 7)).resolves.toMatchObject({ id: '42', balance: '10000.00', tradePermission: true })

    pool.snapshotRows = [snapshot({ source_user_id: 8 })]
    pool.sourceRows = [source({ source_user_id: 8 })]
    await expect(repository.getAccountSnapshot('42', 7)).resolves.toBeNull()

    pool.snapshotRows = [snapshot({ source_interval_id: 'interval-old' })]
    pool.sourceRows = [source({ source_interval_id: 'interval-old' })]
    await expect(repository.getAccountSnapshot('42', 7)).resolves.toBeNull()

    pool.snapshotRows = []
    pool.sourceRows = []
    await expect(repository.getAccountSnapshot('42', 7)).resolves.toBeNull()
  })

  it('fails closed with revision zero for missing, stale or epoch-mismatched private collections', async () => {
    const pool = new FakePool(); pool.currentRows = [account()]; pool.positionRows = [{ payload_json: { accountId: '42', ticket: '1' }, revision: 4 }]
    pool.sourceRows = []; pool.heartbeatRows = [{ last_seen_at_utc: new Date() }]
    const lease = leaseFor(route())
    const repository = new MysqlTradingRepository(pool.asPool(), lease)
    await expect(repository.listPositions('42', 7)).resolves.toMatchObject({ revision: 0, items: [] })

    pool.sourceRows = [source({ projection_revision: 3 })]
    await expect(repository.listPositions('42', 7)).resolves.toMatchObject({ revision: 0, items: [] })

    pool.sourceRows = [source()]
    lease.current.mockResolvedValue(route({ connectionEpoch: 5 }))
    await expect(repository.listPositions('42', 7)).resolves.toMatchObject({ revision: 0, items: [] })

    lease.current.mockResolvedValue(route())
    pool.positionRows = [{ payload_json: { accountId: 'foreign', ticket: '1' }, revision: 4 }]
    await expect(repository.listPositions('42', 7)).resolves.toMatchObject({ revision: 0, items: [] })

    pool.positionRows = [{ payload_json: { accountId: '42', ticket: '1' }, revision: 4 }]
    pool.sourceRowsQueue = [[source()], [source({ revision: 5, projection_revision: 5 })]]
    await expect(repository.listPositions('42', 7)).resolves.toMatchObject({ revision: 0, items: [] })
  })

  it('stores the retained clock and returns exactly that evidence to the publisher', async () => {
    const pool = new FakePool()
    pool.clockRows = [{ timezone_offset_minutes: 0, clock_status: 'calibrated' }]
    const repository = new MysqlTradingRepository(pool.asPool())
    const projection = {
      accountId: '42', resource: 'account.metrics' as const, resourceId: 'current' as const, revision: 5,
      data: {
        id: '42', platform: 'mt5' as const, login: '596520', server: 'Demo', currency: 'USD', terminalProfileId: 'profile-a', terminalInstanceId: 'instance-a', bridgeState: 'online' as const,
        tradePermission: true, lastSeenAt: null, balance: '10000', equity: '10000', margin: '0', freeMargin: '10000', floatingProfit: '0', leverage: 100,
        timezoneOffsetMinutes: null, clockStatus: 'unavailable' as const, observedAt: '2026-09-06T08:00:00.000Z', revision: 5,
      },
    }
    await expect(repository.applyTrustedProjection({ route: route(), projection })).resolves.toMatchObject({ applied: true, clock: { timezoneOffsetMinutes: 0, clockStatus: 'stale' } })
    const read = pool.calls.find(call => call.sql.includes('SELECT snap.timezone_offset_minutes'))!
    expect(read.params).toEqual(['42', 7, 'interval-a', '3', 'profile-a', 'instance-a', 4])
    for (const condition of ['pp.projection_revision=snap.revision', 'snap.trading_account_id=?', 'pp.user_id=?', 'pp.ownership_interval_id=?', 'pp.ownership_revision=?', 'pp.terminal_profile_id=?', 'pp.terminal_instance_id=?', 'pp.connection_epoch=?', 'FOR UPDATE']) expect(read.sql).toContain(condition)
    const saved = pool.calls.find(call => call.sql.startsWith('INSERT INTO account_runtime_snapshots'))!
    expect(saved.params.slice(7, 9)).toEqual([0, 'stale'])
    expect(projection.data.timezoneOffsetMinutes).toBeNull()
    expect(pool.transactionCalls).toEqual(['begin', 'commit', 'release'])
    expect(pool.calls.findIndex(call => call.sql.includes('SELECT revision FROM trading_projection_revisions'))).toBeLessThan(pool.calls.indexOf(read))

    pool.calls.length = 0
    pool.clockRows = [] // No matching provenance, including a changed epoch or owner.
    await expect(repository.applyTrustedProjection({ route: route(), projection })).resolves.toMatchObject({ clock: { timezoneOffsetMinutes: null, clockStatus: 'unavailable' } })
    expect(pool.calls.find(call => call.sql.startsWith('INSERT INTO account_runtime_snapshots'))!.params.slice(7, 9)).toEqual([null, 'unavailable'])

    pool.calls.length = 0
    pool.trustedRevisionRows = [{ revision: 5 }]
    await expect(repository.applyTrustedProjection({ route: route(), projection })).resolves.toEqual({ applied: false, absorbedReservationIds: [] })
    expect(pool.calls.some(call => call.sql.includes('SELECT snap.timezone_offset_minutes'))).toBe(false)
  })

  it('writes provenance only for an applied trusted private projection', async () => {
    const pool = new FakePool()
    const repository = new MysqlTradingRepository(pool.asPool(), null, undefined, createProjectionReservationAbsorber)
    const projection = {
      accountId: '42', resource: 'account.metrics' as const, resourceId: 'current' as const, revision: 4,
      data: {
        id: '42', platform: 'mt5' as const, login: '596520', server: 'Demo', currency: 'USD', terminalProfileId: 'profile-a', terminalInstanceId: 'instance-a', bridgeState: 'online' as const,
        tradePermission: true, lastSeenAt: null, balance: '10000', equity: '10000', margin: '0', freeMargin: '10000', floatingProfit: '0', leverage: 100,
        timezoneOffsetMinutes: 0, clockStatus: 'calibrated' as const, observedAt: '2026-09-05T08:00:00.000Z', revision: 4,
      },
    }
    await expect(repository.applyTrustedProjection({ route: route(), projection })).resolves.toMatchObject({ applied: true, absorbedReservationIds: [] })
    const provenance = pool.calls.find(call => call.sql.includes('INSERT INTO trading_projection_provenance_v4'))
    expect(provenance?.params).toEqual(['42', 'account.metrics', 'current', 7, 'interval-a', '3', 'profile-a', 'instance-a', 4, 4, '2026-09-05T08:00:00.000Z'])

    const positions = {
      accountId: '42', resource: 'positions' as const, resourceId: 'open' as const, revision: 4, data: [],
      tradeStates: [], observedAt: '2026-09-05T08:00:00.000Z',
    }
    await expect(repository.applyTrustedProjection({ route: route(), projection: positions, tradeStates: [], observedAt: positions.observedAt })).resolves.toMatchObject({ applied: true, absorbedReservationIds: [] })
    pool.currentRows = [account()]; pool.sourceRows = [source()]; pool.positionRows = []
    await expect(repository.listPositions('42', 7)).resolves.toEqual({ revision: 4, items: [] })

    const missingOwnerPool = new FakePool(); missingOwnerPool.trustedOwnerRows = []
    await expect(new MysqlTradingRepository(missingOwnerPool.asPool()).applyTrustedProjection({ route: route(), projection })).rejects.toMatchObject({ code: 'trading_context_invalid' })
    expect(missingOwnerPool.transactionCalls).toEqual(['begin', 'rollback', 'release'])
    expect(missingOwnerPool.calls.some(call => call.sql.includes('trading_projection_provenance_v4'))).toBe(false)

    const sameRevisionPool = new FakePool(); sameRevisionPool.trustedRevisionRows = [{ revision: 4 }]
    await expect(new MysqlTradingRepository(sameRevisionPool.asPool()).applyTrustedProjection({ route: route(), projection })).resolves.toEqual({ applied: false, absorbedReservationIds: [] })
    expect(sameRevisionPool.calls.some(call => call.sql.includes('trading_projection_provenance_v4'))).toBe(false)

    const untrusted = new FakePool()
    await new MysqlTradingRepository(untrusted.asPool()).applyProjection(projection)
    expect(untrusted.calls.some(call => call.sql.includes('trading_projection_provenance_v4'))).toBe(false)
  })

  it('requires frozen gateway proof and rechecks the live credential before writing', async () => {
    const projection = {
      accountId: '42', resource: 'account.metrics' as const, resourceId: 'current' as const, revision: 4,
      data: {
        id: '42', platform: 'mt5' as const, login: '596520', server: 'Demo', currency: 'USD', terminalProfileId: 'profile-a', terminalInstanceId: 'instance-a', bridgeState: 'online' as const,
        tradePermission: true, lastSeenAt: null, balance: '10000', equity: '10000', margin: '0', freeMargin: '10000', floatingProfit: '0', leverage: 100,
        timezoneOffsetMinutes: 0, clockStatus: 'calibrated' as const, observedAt: '2026-09-05T08:00:00.000Z', revision: 4,
      },
    }
    const missingProof = new FakePool()
    const missingProofRoute = { ...route() } as import('../src/modules/trading/application/trading-ports.js').TrustedBridgeProjectionRoute
    delete missingProofRoute.installationId
    delete missingProofRoute.credentialGeneration
    delete missingProofRoute.ownershipRevision
    await expect(new MysqlTradingRepository(missingProof.asPool()).applyTrustedProjection({
      route: missingProofRoute,
      projection,
    })).rejects.toMatchObject({ code: 'trading_context_invalid' })
    expect(missingProof.calls.some(call => call.sql.includes('trading_projection_revisions'))).toBe(false)

    for (const configure of [
      (pool: FakePool) => { pool.trustedCredentialRows = [] },
      (pool: FakePool) => { pool.trustedCredentialGeneration = 2 },
      (pool: FakePool) => { pool.trustedOwnerRows = [{ interval_id: 'interval-a', ownership_revision: 4 }] },
    ]) {
      const pool = new FakePool(); configure(pool)
      await expect(new MysqlTradingRepository(pool.asPool()).applyTrustedProjection({ route: route(), projection }))
        .rejects.toMatchObject({ code: 'trading_context_invalid' })
      expect(pool.calls.some(call => call.sql.includes('trading_projection_revisions'))).toBe(false)
      expect(pool.calls.some(call => call.sql.includes('trading_projection_provenance_v4'))).toBe(false)
    }
  })

  it('keeps the id-less in-process projector path without gateway proof requirements', async () => {
    const pool = new FakePool()
    const legacyRoute = { ...route() } as import('../src/modules/trading/application/trading-ports.js').TrustedBridgeProjectionRoute
    delete legacyRoute.connectionId
    delete legacyRoute.installationId
    delete legacyRoute.credentialGeneration
    delete legacyRoute.ownershipRevision
    const projection = {
      accountId: '42', resource: 'account.metrics' as const, resourceId: 'current' as const, revision: 4,
      data: {
        id: '42', platform: 'mt5' as const, login: '596520', server: 'Demo', currency: 'USD', terminalProfileId: 'profile-a', terminalInstanceId: 'instance-a', bridgeState: 'online' as const,
        tradePermission: true, lastSeenAt: null, balance: '10000', equity: '10000', margin: '0', freeMargin: '10000', floatingProfit: '0', leverage: 100,
        timezoneOffsetMinutes: 0, clockStatus: 'calibrated' as const, observedAt: '2026-09-05T08:00:00.000Z', revision: 4,
      },
    }
    await expect(new MysqlTradingRepository(pool.asPool()).applyTrustedProjection({ route: legacyRoute, projection }))
      .resolves.toMatchObject({ applied: true, absorbedReservationIds: [] })
    expect(pool.calls.some(call => call.sql.includes('FROM bridge_refresh_sessions s'))).toBe(false)
  })

  it('allows history-only realtime targets through history ownership but never uses that grant for mixed private resources', async () => {
    const listAccounts = vi.fn(async (_userId: number, access: 'current' | 'history' = 'current') => access === 'history' ? [{ id: '42' }] : [])
    const findOwnedAccount = vi.fn(async () => null)
    const messages: unknown[] = []
    const closes: unknown[] = []
    const repository = { listAccounts, findOwnedAccount } as unknown as TradingReadRepository
    const hub = new BrowserRealtimeHub(repository)
    const target = { accountId: '42', observerChannelId: null, resources: ['trade_history'], afterRevision: { trade_history: null }, publicTarget: {} }
    await expect(hub.subscribeTargets({ userId: 7, targets: [target], sink: { send: value => messages.push(value), close: (...value) => closes.push(value) } })).resolves.toBeTypeOf('function')
    expect(listAccounts).toHaveBeenCalledWith(7, 'history')
    hub.publish({ eventId: 'history-1', type: 'trade.history.changed', occurredAt: new Date().toISOString(), userId: 7, accountId: '42', terminalInstanceId: null, resource: 'trade_history', resourceId: 'history', revision: 1, data: { status: 'stale' } })
    expect(messages).toContainEqual(expect.objectContaining({ event_id: 'history-1' }))

    await expect(hub.subscribeTargets({ userId: 7, targets: [{ ...target, resources: ['trade_history', 'positions'] }], sink: { send() {}, close: (...value) => closes.push(value) } })).resolves.toBeNull()
    expect(findOwnedAccount).toHaveBeenCalledWith(7, '42')
    expect(closes).toContainEqual([4403, 'trading_account_forbidden'])
  })

  it('keeps current SQL profile ambiguity, future grants, and provenance checks explicit', async () => {
    const source = await readFile(new URL('../src/modules/trading/infrastructure/mysql-trading-repository.ts', import.meta.url), 'utf8')
    expect(source).toContain('COUNT(b.terminal_profile_id)=1 AND COUNT(p.id)=1')
    expect(source).toContain('oi.started_at_utc<=UTC_TIMESTAMP(3)')
    expect(source).toContain('pp.projection_revision=pr.revision')
    expect(source).toContain('AND s.connection_epoch=?')
  })
})
