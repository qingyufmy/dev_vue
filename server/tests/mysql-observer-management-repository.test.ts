import { createAdminPrincipalAccess, createActivePrincipalAccess } from '../src/modules/auth/composition.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import {
  MysqlObserverManagementRepository,
} from '../src/modules/trading/infrastructure/mysql-observer-management-repository.js'
import { ObserverManagementError, type ObserverManagementCommand, type ObserverManagementWrite } from '../src/modules/trading/application/observer-management-ports.js'

type Row = Record<string, unknown>

const now = new Date('2026-09-05T08:00:00.000Z')

function sourceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    display_name: '黄金观摩源',
    notes: null,
    operator_user_id: 1,
    trading_account_id: null,
    analysis_strategy_id: null,
    status: 'disabled',
    configuration_status: 'pending',
    created_by_user_id: 1,
    created_at_utc: now,
    updated_at_utc: now,
    revision: '1',
    ...overrides,
  }
}

function channelRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    source_id: null,
    source_trading_account_id: null,
    display_name: '黄金频道',
    slug: 'gold',
    description: null,
    audience: 'assigned',
    active: 0,
    is_default: 0,
    sort_order: 0,
    created_at_utc: now,
    updated_at_utc: now,
    revision: '1',
    ...overrides,
  }
}

function header(insertId = 1, affectedRows = 1) {
  return { insertId, affectedRows }
}

/**
 * A deterministic SQL double.  It deliberately models only the whitelisted
 * statements used by this repository; a query outside that surface fails so
 * the tests cannot accidentally bless an unbounded SELECT or an extra write.
 */
class FakeManagementPool {
  registryRevision = 0
  admin = true
  ownerProof = true
  readonly ownerProofUserIds: number[] = []
  strategyProof = true
  activeUsers = new Set([1, 7])
  failGetConnection = false
  failOutbox = false
  forceAccessUpdateConflict = false
  nextSourceId = 10
  nextChannelId = 20
  readonly sources = new Map<string, Row>()
  readonly channels = new Map<string, Row>()
  readonly accesses = new Map<string, Row>()
  readonly receipts = new Map<string, Row>()
  readonly operations: Row[] = []
  readonly outbox: Row[] = []
  readonly calls: Array<{ client: 'pool' | 'connection'; sql: string; params: unknown[] }> = []
  readonly transactionEvents: string[] = []

  private snapshot: {
    registryRevision: number
    sources: Map<string, Row>
    channels: Map<string, Row>
    accesses: Map<string, Row>
    receipts: Map<string, Row>
    operations: Row[]
    outbox: Row[]
  } | null = null

  readonly connection = {
    execute: (sql: string, params: unknown[] = []) => this.handle(sql, params, 'connection'),
    beginTransaction: async () => {
      this.transactionEvents.push('begin')
      this.snapshot = this.saveState()
    },
    commit: async () => {
      this.transactionEvents.push('commit')
      this.snapshot = null
    },
    rollback: async () => {
      this.transactionEvents.push('rollback')
      if (this.snapshot) this.restoreState(this.snapshot)
      this.snapshot = null
    },
    release: () => { this.transactionEvents.push('release') },
  }

  async execute(sql: string, params: unknown[] = []) { return this.handle(sql, params, 'pool') }

  async getConnection() {
    if (this.failGetConnection) throw new Error('connection_unavailable')
    return this.connection
  }

  asPool() { return this as unknown as Pool }

  private async handle(sql: string, params: unknown[], client: 'pool' | 'connection'): Promise<[unknown, unknown]> {
    this.calls.push({ client, sql, params })
    if (this.failOutbox && sql.includes('INSERT INTO outbox_events')) throw new Error('outbox_write_failed')

    if (sql.includes('SELECT revision FROM observer_management_registry')) {
      return [[{ revision: String(this.registryRevision) }], []]
    }
    if (sql.includes("SELECT id FROM users") && sql.includes("role='admin'")) {
      return [this.admin ? [{ id: 1 }] : [], []]
    }
    if (sql.includes('FROM observer_management_operations WHERE actor_user_id=')) {
      const key = `${String(params[0])}:${String(params[1])}`
      const receipt = this.receipts.get(key)
      return [receipt ? [receipt] : [], []]
    }

    if (sql.includes('FROM observer_sources s WHERE s.id>?')) return [this.rowsAfterId(this.sources, params[0]), []]
    if (sql.includes('FROM observer_channels c WHERE c.id>?')) return [this.rowsAfterId(this.channels, params[0]), []]
    if (sql.includes('FROM observer_channel_accesses x WHERE x.observer_channel_id=? AND x.user_id>?')) {
      const channelId = String(params[0])
      const after = Number(params[1])
      return [[...this.accesses.values()]
        .filter(row => String(row.observer_channel_id) === channelId && Number(row.user_id) > after)
        .sort((left, right) => Number(left.user_id) - Number(right.user_id))
        .slice(0, Number(params[2])), []]
    }
    if (sql.includes('FROM observer_management_operations o WHERE o.id>?')) {
      return [this.operations.filter(row => String(row.id) > String(params[0])).slice(0, Number(params[1])), []]
    }

    if (sql.includes('FROM observer_sources s WHERE s.id=?')) {
      const row = this.sources.get(String(params[0]))
      return [row ? [{ ...row }] : [], []]
    }
    if (sql.includes('FROM observer_channels c WHERE c.id=?')) {
      const row = this.channels.get(String(params[0]))
      return [row ? [{ ...row }] : [], []]
    }
    if (sql.includes('FROM observer_channels c WHERE c.is_default=1')) {
      const row = [...this.channels.values()].find(item => item.is_default === 1 || item.is_default === true)
      return [row ? [{ ...row }] : [], []]
    }
    if (sql.includes('FROM observer_accounts')) throw new Error('unexpected_sql')
    if (sql.includes('FROM trading_accounts a')) {
      this.ownerProofUserIds.push(Number(params[0]))
      return [this.ownerProof ? [{
        id: params[1], ownership_revision: '2', interval_id: 'interval-1', granted_at_utc: now,
        started_at_utc: now, ended_at_utc: null, interval_role: 'owner', owner_user_id: params[0],
        deletion_status: 'active', deleted_at: null,
      }] : [], []]
    }
    if (sql.includes('FROM strategies s')) return [this.strategyProof ? [{ id: params[0] }] : [], []]
    if (sql.includes("SELECT id FROM users") && sql.includes("deletion_status='active'")) {
      const id = Number(params[0])
      return [this.activeUsers.has(id) ? [{ id }] : [], []]
    }
    if (sql.includes('FROM observer_channel_accesses x WHERE x.observer_channel_id=? AND x.user_id=?')) {
      const row = this.accesses.get(`${String(params[0])}:${String(params[1])}`)
      return [row ? [{ ...row }] : [], []]
    }

    if (sql.includes('INSERT INTO observer_sources')) {
      const id = String(++this.nextSourceId)
      this.sources.set(id, sourceRow(id, {
        display_name: params[0], notes: params[1], operator_user_id: params[2],
        trading_account_id: params[3], analysis_strategy_id: params[4], created_by_user_id: params[5],
      }))
      return [header(Number(id)), []]
    }
    if (sql.includes('INSERT INTO observer_channels')) {
      const id = String(++this.nextChannelId)
      this.channels.set(id, channelRow(id, {
        source_trading_account_id: params[0], display_name: params[1], created_by_user_id: params[2],
        source_id: params[3], slug: params[4], description: params[5], audience: params[6], sort_order: params[7],
      }))
      return [header(Number(id)), []]
    }
    if (sql.includes('INSERT INTO observer_channel_accesses')) {
      const key = `${String(params[0])}:${String(params[1])}`
      this.accesses.set(key, {
        observer_channel_id: params[0], user_id: params[1], granted_at_utc: now,
        revoked_at_utc: sql.includes('UTC_TIMESTAMP(3)' ) && !sql.includes(',NULL,') ? now : null,
        granted_by_user_id: params[2], revision: '1',
      })
      return [header(), []]
    }
    if (sql.includes('INSERT INTO observer_management_operations')) {
      const result = JSON.parse(String(params[6])) as Row
      const audit = JSON.parse(String(params[7])) as Row
      const operation = {
        id: params[0], actor_user_id: params[1], idempotency_key: params[2], request_hash: params[3],
        action: params[4], target_id: params[5], result_json: result, audit_json: audit, created_at_utc: now,
      }
      this.operations.push(operation)
      this.receipts.set(`${String(params[1])}:${String(params[2])}`, operation)
      return [header(), []]
    }
    if (sql.includes('INSERT INTO outbox_events')) {
      this.outbox.push({ event_id: params[0], aggregate_type: params[1], aggregate_id: params[2], event_type: params[3], payload_json: JSON.parse(String(params[4])) })
      return [header(), []]
    }

    if (sql.includes('UPDATE observer_management_registry')) {
      this.registryRevision += 1
      return [header(0), []]
    }
    if (sql.includes('UPDATE observer_sources SET')) {
      const id = String(params[6])
      const row = this.sources.get(id)
      if (!row) return [header(0, 0), []]
      Object.assign(row, {
        display_name: params[0], notes: params[1], trading_account_id: params[2], analysis_strategy_id: params[3],
        status: params[4], configuration_status: params[5], revision: String(Number(row.revision) + 1), updated_at_utc: now,
      })
      return [header(0), []]
    }
    if (sql.includes('UPDATE observer_channels SET source_trading_account_id=?') && sql.includes('WHERE source_id=?')) {
      const accountId = params[0]
      for (const row of this.channels.values()) {
        if (String(row.source_id) === String(params[1])) {
          row.source_trading_account_id = accountId
          row.revision = String(Number(row.revision) + 1)
        }
      }
      return [header(0), []]
    }
    if (sql.includes('UPDATE observer_channels SET is_default=0') && sql.includes('WHERE source_id=?')) {
      for (const row of this.channels.values()) {
        if (String(row.source_id) === String(params[0]) && (row.is_default === 1 || row.is_default === true)) {
          row.is_default = 0
          row.revision = String(Number(row.revision) + 1)
        }
      }
      return [header(0), []]
    }
    if (sql.includes('UPDATE observer_channels SET') && sql.includes('WHERE id=? AND revision=?')) {
      const row = this.channels.get(String(params[9]))
      if (!row || Number(row.revision) !== Number(params[10])) return [header(0, 0), []]
      Object.assign(row, {
        source_trading_account_id: params[0], display_name: params[1], active: params[2], source_id: params[3],
        slug: params[4], description: params[5], audience: params[6], is_default: params[7], sort_order: params[8],
        revision: String(Number(row.revision) + 1), updated_at_utc: now,
      })
      return [header(0), []]
    }
    if (sql.includes('UPDATE observer_channels SET is_default=0') && sql.includes('WHERE id=?')) {
      const row = this.channels.get(String(params[0]))
      if (row) { row.is_default = 0; row.revision = String(Number(row.revision) + 1) }
      return [header(0), []]
    }
    if (sql.includes('UPDATE observer_channels SET is_default=1')) {
      const row = this.channels.get(String(params[0]))
      if (row) { row.is_default = 1; row.revision = String(Number(row.revision) + 1) }
      return [header(0), []]
    }
    if (sql.includes('UPDATE observer_channel_accesses SET')) {
      if (this.forceAccessUpdateConflict) return [header(0, 0), []]
      const key = `${String(params[4])}:${String(params[5])}`
      const row = this.accesses.get(key)
      if (!row || Number(row.revision) !== Number(params[6])) return [header(0, 0), []]
      row.revoked_at_utc = params[1] === 1 ? null : now
      row.granted_by_user_id = params[2]
      row.revision = String(params[3])
      return [header(0), []]
    }
    throw new Error(`unexpected_sql:${sql}`)
  }

  private rowsAfterId(values: Map<string, Row>, cursor: unknown) {
    const after = Number(cursor)
    return [...values.values()]
      .filter(row => Number(row.id) > after)
      .sort((left, right) => Number(left.id) - Number(right.id))
      .slice(0, 101)
  }

  private saveState() {
    return {
      registryRevision: this.registryRevision,
      sources: cloneMap(this.sources), channels: cloneMap(this.channels), accesses: cloneMap(this.accesses),
      receipts: cloneMap(this.receipts), operations: this.operations.map(row => ({ ...row })), outbox: this.outbox.map(row => ({ ...row })),
    }
  }

  private restoreState(state: NonNullable<FakeManagementPool['snapshot']>) {
    this.registryRevision = state.registryRevision
    replaceMap(this.sources, state.sources); replaceMap(this.channels, state.channels); replaceMap(this.accesses, state.accesses); replaceMap(this.receipts, state.receipts)
    this.operations.splice(0, this.operations.length, ...state.operations)
    this.outbox.splice(0, this.outbox.length, ...state.outbox)
  }
}

function cloneMap(values: Map<string, Row>) { return new Map([...values].map(([key, value]) => [key, { ...value }])) }
function replaceMap(target: Map<string, Row>, source: Map<string, Row>) { target.clear(); for (const [key, value] of source) target.set(key, { ...value }) }

function repository(pool: FakeManagementPool) { return new MysqlObserverManagementRepository(pool.asPool(), createAdminPrincipalAccess, createActivePrincipalAccess) }

function sourceCreate(): ObserverManagementCommand {
  return {
    kind: 'source.create',
    config: {
      displayName: '黄金观摩源', notes: null, tradingAccountId: null, analysisStrategyId: null, status: 'disabled',
    },
  }
}

function write(pool: FakeManagementPool, command: ObserverManagementCommand, key = 'source-write-1', hash = 'a'.repeat(64)) {
  const input: ObserverManagementWrite = { actorUserId: 1, idempotencyKey: key, requestHash: hash, command }
  return repository(pool).execute(input)
}

describe('MysqlObserverManagementRepository', () => {
  it('rejects inactive source operators even when account ownership remains, before writing', async () => {
    const pool = new FakeManagementPool()
    pool.sources.set('10', sourceRow('10', { operator_user_id: 42 }))
    await expect(write(pool, {
      kind: 'source.update', id: '10', expectedRevision: 1,
      config: { displayName: '源', notes: null, tradingAccountId: '7', analysisStrategyId: null, status: 'active' },
    })).rejects.toMatchObject({ code: 'observer_account_not_owned', status: 403 })
    expect(pool.operations).toHaveLength(0)
    expect(pool.outbox).toHaveLength(0)
    expect(pool.registryRevision).toBe(0)
    const ownerIndex = pool.calls.findIndex(call => call.sql.includes('FROM trading_accounts a'))
    const principalIndex = pool.calls.findIndex(call => call.sql.includes('SELECT id FROM users') && !call.sql.includes("role='admin'"))
    expect(ownerIndex).toBeLessThan(principalIndex)
    expect(pool.calls[ownerIndex]!.sql).not.toContain('JOIN users')
    expect(pool.calls[principalIndex]).toMatchObject({ client: 'connection', params: [42] })
    expect(pool.calls[principalIndex]!.sql).toContain('FOR SHARE')
    expect(pool.transactionEvents).toEqual(['begin', 'rollback', 'release'])
  })

  it('rejects a deleted access recipient and rolls back identity capability failures', async () => {
    const pool = new FakeManagementPool()
    pool.channels.set('20', channelRow('20'))
    pool.activeUsers.delete(7)
    const command: ObserverManagementCommand = { kind: 'access.set', channelId: '20', userId: 7, granted: true, expectedRevision: 0 }
    await expect(write(pool, command)).rejects.toMatchObject({ code: 'observer_access_user_not_found', status: 404 })
    const failed = new MysqlObserverManagementRepository(pool.asPool(), createAdminPrincipalAccess, () => ({
      isActive: async () => { throw Error('auth_principal_unavailable') },
    }))
    await expect(failed.execute({ actorUserId: 1, idempotencyKey: 'principal-failure-1', requestHash: 'a'.repeat(64), command }))
      .rejects.toMatchObject({ code: 'observer_management_storage_unavailable', status: 503 })
    expect(pool.accesses.size).toBe(0)
    expect(pool.outbox).toHaveLength(0)
    expect(pool.transactionEvents.slice(-3)).toEqual(['begin', 'rollback', 'release'])
  })

  it('replays a matching receipt without side effects and rejects a hash conflict', async () => {
    const pool = new FakeManagementPool()
    const first = await write(pool, sourceCreate())
    const adminRead = pool.calls.find(call => call.sql.includes("role='admin'"))!
    expect(adminRead.client).toBe('connection')
    expect(adminRead.sql).toContain('FOR SHARE')
    expect(pool.calls.indexOf(adminRead)).toBeLessThan(pool.calls.findIndex(call => call.sql.includes('FROM observer_management_operations')))
    const registryAfterFirst = pool.registryRevision
    const insertsAfterFirst = pool.operations.length

    await expect(write(pool, sourceCreate(), 'source-write-1', 'a'.repeat(64))).resolves.toEqual(first)
    expect(pool.registryRevision).toBe(registryAfterFirst)
    expect(pool.operations).toHaveLength(insertsAfterFirst)
    await expect(write(pool, sourceCreate(), 'source-write-1', 'b'.repeat(64))).rejects.toMatchObject({
      code: 'observer_management_idempotency_conflict', status: 409,
    })
    expect(pool.registryRevision).toBe(registryAfterFirst)
    expect(pool.transactionEvents.slice(-3)).toEqual(['begin', 'rollback', 'release'])
  })

  it('rolls back the business write, receipt, and registry when outbox insertion fails', async () => {
    const pool = new FakeManagementPool()
    pool.failOutbox = true
    await expect(write(pool, sourceCreate())).rejects.toMatchObject({
      code: 'observer_management_storage_unavailable', status: 503,
    })
    expect(pool.sources.size).toBe(0)
    expect(pool.operations).toHaveLength(0)
    expect(pool.outbox).toHaveLength(0)
    expect(pool.registryRevision).toBe(0)
    expect(pool.transactionEvents).toEqual(['begin', 'rollback', 'release'])
  })

  it('revalidates immutable source ownership before binding an account', async () => {
    const pool = new FakeManagementPool()
    pool.ownerProof = false
    await expect(write(pool, {
      kind: 'source.create',
      config: { displayName: '源', notes: null, tradingAccountId: '7', analysisStrategyId: null, status: 'disabled' },
    })).rejects.toMatchObject({ code: 'observer_account_not_owned', status: 403 })
    expect(pool.sources.size).toBe(0)
    expect(pool.calls.some(call => call.sql.includes('trading_account_ownership_intervals') && call.sql.includes('ownership_revision'))).toBe(true)
  })

  it('updates every channel account projection when a source account changes', async () => {
    const pool = new FakeManagementPool()
    pool.sources.set('10', sourceRow('10', {
      status: 'active', configuration_status: 'ready', trading_account_id: '7', revision: '1',
    }))
    pool.channels.set('20', channelRow('20', {
      source_id: '10', source_trading_account_id: '7', active: 1, revision: '3',
    }))
    const result = await write(pool, {
      kind: 'source.update', id: '10', expectedRevision: 1,
      config: { displayName: '源', notes: null, tradingAccountId: '8', analysisStrategyId: null, status: 'active' },
    }, 'source-update-1', 'c'.repeat(64))
    expect(result).toMatchObject({ target_id: '10', revision: 2 })
    expect(pool.channels.get('20')).toMatchObject({ source_trading_account_id: '8', revision: '4' })
    expect(pool.outbox[0]?.payload_json).toEqual({ source_id: '10', channel_id: null, user_id: null, registry_revision: 1 })
  })

  it('rejects a stale source revision before changing the source or registry', async () => {
    const pool = new FakeManagementPool()
    pool.sources.set('10', sourceRow('10', { revision: '2' }))
    await expect(write(pool, {
      kind: 'source.update', id: '10', expectedRevision: 1,
      config: { displayName: '源', notes: null, tradingAccountId: null, analysisStrategyId: null, status: 'disabled' },
    }, 'source-stale-1', '0'.repeat(64))).rejects.toMatchObject({
      code: 'observer_source_revision_conflict', status: 409,
    })
    expect(pool.sources.get('10')?.revision).toBe('2')
    expect(pool.registryRevision).toBe(0)
    expect(pool.operations).toHaveLength(0)
    expect(pool.outbox).toHaveLength(0)
  })

  it('rejects a stale channel revision before changing the channel or registry', async () => {
    const pool = new FakeManagementPool()
    pool.channels.set('20', channelRow('20', { revision: '2' }))
    await expect(write(pool, {
      kind: 'channel.update', id: '20', expectedRevision: 1,
      config: { displayName: '频道', sourceId: null, slug: 'gold', description: null, audience: 'assigned', active: false, sortOrder: 0 },
    }, 'channel-stale-1', '2'.repeat(64))).rejects.toMatchObject({
      code: 'observer_channel_revision_conflict', status: 409,
    })
    expect(pool.channels.get('20')?.revision).toBe('2')
    expect(pool.registryRevision).toBe(0)
    expect(pool.operations).toHaveLength(0)
    expect(pool.outbox).toHaveLength(0)
  })

  it('rejects a stale access revision without creating a new grant version', async () => {
    const pool = new FakeManagementPool()
    pool.channels.set('20', channelRow('20', { active: 1 }))
    pool.accesses.set('20:7', {
      observer_channel_id: '20', user_id: 7, granted_at_utc: now, revoked_at_utc: null,
      granted_by_user_id: 1, revision: '2',
    })
    await expect(write(pool, {
      kind: 'access.set', channelId: '20', userId: 7, granted: false, expectedRevision: 1,
    }, 'access-stale-1', '3'.repeat(64))).rejects.toMatchObject({
      code: 'observer_access_revision_conflict', status: 409,
    })
    expect(pool.accesses.get('20:7')?.revision).toBe('2')
    expect(pool.registryRevision).toBe(0)
    expect(pool.operations).toHaveLength(0)
    expect(pool.outbox).toHaveLength(0)
  })

  it('rechecks admin lifecycle before replaying an otherwise valid receipt', async () => {
    const pool = new FakeManagementPool()
    const first = await write(pool, sourceCreate(), 'admin-replay-1', '4'.repeat(64))
    pool.admin = false
    await expect(write(pool, sourceCreate(), 'admin-replay-1', '4'.repeat(64))).rejects.toMatchObject({
      code: 'observer_management_admin_required', status: 403,
    })
    expect(pool.registryRevision).toBe(first.registry_revision)
    expect(pool.operations).toHaveLength(1)
    expect(pool.sources.size).toBe(1)
  })

  it('requires a ready active channel and matching source projection for the default slot', async () => {
    const pool = new FakeManagementPool()
    pool.sources.set('10', sourceRow('10', {
      status: 'active', configuration_status: 'ready', trading_account_id: '7', revision: '2',
    }))
    pool.channels.set('20', channelRow('20', {
      source_id: '10', source_trading_account_id: '7', active: 1, revision: '4',
    }))
    await expect(write(pool, { kind: 'channel.default', channelId: '20', expectedRevision: 0 }, 'default-1', 'd'.repeat(64))).resolves.toMatchObject({
      target_id: '20', registry_revision: 1,
    })
    expect(pool.channels.get('20')).toMatchObject({ is_default: 1, revision: '5' })

    const unavailable = new FakeManagementPool()
    unavailable.channels.set('20', channelRow('20', { source_id: '10', source_trading_account_id: '7', active: 0 }))
    await expect(write(unavailable, { kind: 'channel.default', channelId: '20', expectedRevision: 0 }, 'default-2', 'e'.repeat(64))).rejects.toMatchObject({
      code: 'observer_channel_not_available', status: 409,
    })
  })

  it('switches the default channel atomically and increments both channel revisions', async () => {
    const pool = new FakeManagementPool()
    pool.sources.set('10', sourceRow('10', {
      status: 'active', configuration_status: 'ready', trading_account_id: '7', revision: '1',
    }))
    pool.channels.set('20', channelRow('20', {
      source_id: '10', source_trading_account_id: '7', active: 1, is_default: 1, revision: '3',
    }))
    pool.channels.set('21', channelRow('21', {
      source_id: '10', source_trading_account_id: '7', active: 1, is_default: 0, revision: '5', slug: 'silver',
    }))
    const result = await write(pool, { kind: 'channel.default', channelId: '21', expectedRevision: 0 }, 'default-switch-1', '5'.repeat(64))
    expect(result).toMatchObject({ target_id: '21', revision: 6, registry_revision: 1 })
    expect(pool.channels.get('20')).toMatchObject({ is_default: 0, revision: '4' })
    expect(pool.channels.get('21')).toMatchObject({ is_default: 1, revision: '6' })
    expect(pool.outbox[0]?.payload_json).toEqual({ source_id: null, channel_id: null, user_id: null, registry_revision: 1 })
  })

  it('rejects a stale registry revision before switching defaults and rolls back', async () => {
    const pool = new FakeManagementPool()
    pool.registryRevision = 2
    pool.sources.set('10', sourceRow('10', { status: 'active', configuration_status: 'ready', trading_account_id: '7' }))
    pool.channels.set('20', channelRow('20', { source_id: '10', source_trading_account_id: '7', active: 1, is_default: 1 }))
    await expect(write(pool, { kind: 'channel.default', channelId: null, expectedRevision: 1 }, 'default-stale-registry-1', '6'.repeat(64))).rejects.toMatchObject({
      code: 'observer_management_revision_conflict', status: 409,
    })
    expect(pool.registryRevision).toBe(2)
    expect(pool.channels.get('20')).toMatchObject({ is_default: 1, revision: '1' })
    expect(pool.operations).toHaveLength(0)
    expect(pool.outbox).toHaveLength(0)
    expect(pool.transactionEvents.slice(-3)).toEqual(['begin', 'rollback', 'release'])
  })

  it('clears defaults when disabling a source even when its ownership is no longer valid', async () => {
    const pool = new FakeManagementPool()
    pool.ownerProof = false
    pool.sources.set('10', sourceRow('10', {
      status: 'active', configuration_status: 'ready', trading_account_id: '7', revision: '1',
    }))
    pool.channels.set('20', channelRow('20', {
      source_id: '10', source_trading_account_id: '7', active: 1, is_default: 1, revision: '3',
    }))
    const result = await write(pool, {
      kind: 'source.update', id: '10', expectedRevision: 1,
      config: { displayName: '源', notes: null, tradingAccountId: '7', analysisStrategyId: null, status: 'disabled' },
    }, 'source-disable-1', '7'.repeat(64))
    expect(result).toMatchObject({ target_id: '10', revision: 2, registry_revision: 1 })
    expect(pool.sources.get('10')).toMatchObject({ status: 'disabled', trading_account_id: '7', revision: '2' })
    expect(pool.channels.get('20')).toMatchObject({ is_default: 0, revision: '4' })
    expect(pool.ownerProofUserIds).toEqual([])
    expect(pool.outbox[0]?.payload_json).toEqual({ source_id: '10', channel_id: null, user_id: null, registry_revision: 1 })
  })

  it('emits a channel-only invalidation when a channel changes source', async () => {
    const pool = new FakeManagementPool()
    pool.sources.set('10', sourceRow('10'))
    pool.sources.set('11', sourceRow('11'))
    pool.channels.set('20', channelRow('20', { source_id: '10', revision: '4' }))
    await expect(write(pool, {
      kind: 'channel.update', id: '20', expectedRevision: 4,
      config: { displayName: '频道', sourceId: '11', slug: 'gold', description: null, audience: 'assigned', active: false, sortOrder: 0 },
    }, 'channel-swap-1', '8'.repeat(64))).resolves.toMatchObject({ target_id: '20', revision: 5 })
    expect(pool.channels.get('20')).toMatchObject({ source_id: '11', revision: '5' })
    expect(pool.outbox[0]?.payload_json).toEqual({ source_id: null, channel_id: '20', user_id: null, registry_revision: 1 })
  })

  it('keeps the source operator immutable while revalidating ownership with that operator', async () => {
    const pool = new FakeManagementPool()
    pool.activeUsers.add(42)
    pool.sources.set('10', sourceRow('10', { operator_user_id: 42, created_by_user_id: 42 }))
    await expect(write(pool, {
      kind: 'source.update', id: '10', expectedRevision: 1,
      config: { displayName: '源', notes: null, tradingAccountId: '7', analysisStrategyId: null, status: 'disabled' },
    }, 'source-operator-1', '9'.repeat(64))).resolves.toMatchObject({ target_id: '10', revision: 2 })
    expect(pool.sources.get('10')).toMatchObject({ operator_user_id: 42, trading_account_id: '7' })
    expect(pool.ownerProofUserIds).toEqual([42])
    const sourceUpdate = pool.calls.find(call => call.sql.includes('UPDATE observer_sources SET'))
    expect(sourceUpdate?.sql).not.toContain('operator_user_id')
  })

  it('creates a revoke tombstone at revision zero and later increments it without changing audience', async () => {
    const pool = new FakeManagementPool()
    pool.channels.set('20', channelRow('20', { active: 1, audience: 'all' }))
    await expect(write(pool, { kind: 'access.set', channelId: '20', userId: 7, granted: false, expectedRevision: 0 }, 'access-1', 'f'.repeat(64))).resolves.toMatchObject({
      target_id: '20', revision: 1,
    })
    expect(pool.accesses.get('20:7')).toMatchObject({ revision: '1', revoked_at_utc: now })
    await expect(write(pool, { kind: 'access.set', channelId: '20', userId: 7, granted: true, expectedRevision: 1 }, 'access-2', '1'.repeat(64))).resolves.toMatchObject({
      target_id: '20', revision: 2,
    })
    expect(pool.accesses.get('20:7')).toMatchObject({ revision: '2', revoked_at_utc: null })
    expect(pool.channels.get('20')?.audience).toBe('all')
  })

  it('treats an idempotent same-grant write as a no-op for the access version', async () => {
    const pool = new FakeManagementPool()
    pool.channels.set('20', channelRow('20', { active: 1, audience: 'all' }))
    pool.accesses.set('20:7', {
      observer_channel_id: '20', user_id: 7, granted_at_utc: now, revoked_at_utc: null,
      granted_by_user_id: 1, revision: '1',
    })
    const command: ObserverManagementCommand = { kind: 'access.set', channelId: '20', userId: 7, granted: true, expectedRevision: 1 }
    const first = await write(pool, command, 'access-noop-1', 'a'.repeat(64))
    expect(first).toMatchObject({ target_id: '20', revision: 1, registry_revision: 1 })
    expect(pool.accesses.get('20:7')?.revision).toBe('1')
    expect(pool.calls.filter(call => call.sql.includes('UPDATE observer_channel_accesses SET'))).toHaveLength(0)
    await expect(write(pool, command, 'access-noop-1', 'a'.repeat(64))).resolves.toEqual(first)
    expect(pool.registryRevision).toBe(1)
    expect(pool.operations).toHaveLength(1)
  })

  it('rolls back when an access compare-and-set update affects no rows', async () => {
    const pool = new FakeManagementPool()
    pool.forceAccessUpdateConflict = true
    pool.channels.set('20', channelRow('20', { active: 1 }))
    pool.accesses.set('20:7', {
      observer_channel_id: '20', user_id: 7, granted_at_utc: now, revoked_at_utc: now,
      granted_by_user_id: 1, revision: '1',
    })
    await expect(write(pool, { kind: 'access.set', channelId: '20', userId: 7, granted: true, expectedRevision: 1 }, 'access-cas-1', 'b'.repeat(64))).rejects.toMatchObject({
      code: 'observer_access_revision_conflict', status: 409,
    })
    expect(pool.accesses.get('20:7')).toMatchObject({ revision: '1', revoked_at_utc: now })
    expect(pool.registryRevision).toBe(0)
    expect(pool.operations).toHaveLength(0)
    expect(pool.outbox).toHaveLength(0)
  })

  it('refuses to bump a saturated registry revision before writing business state', async () => {
    const pool = new FakeManagementPool()
    pool.registryRevision = Number.MAX_SAFE_INTEGER
    await expect(write(pool, sourceCreate(), 'registry-overflow-1', 'c'.repeat(64))).rejects.toMatchObject({
      code: 'observer_management_revision_conflict', status: 409,
    })
    expect(pool.sources.size).toBe(0)
    expect(pool.registryRevision).toBe(Number.MAX_SAFE_INTEGER)
    expect(pool.operations).toHaveLength(0)
    expect(pool.outbox).toHaveLength(0)
    expect(pool.calls.some(call => call.sql.includes('UPDATE observer_management_registry'))).toBe(false)
  })

  it('rejects a saturated source revision before issuing the source update', async () => {
    const pool = new FakeManagementPool()
    pool.sources.set('10', sourceRow('10', { revision: String(Number.MAX_SAFE_INTEGER) }))
    await expect(write(pool, {
      kind: 'source.update', id: '10', expectedRevision: Number.MAX_SAFE_INTEGER,
      config: { displayName: '源', notes: null, tradingAccountId: null, analysisStrategyId: null, status: 'disabled' },
    }, 'source-overflow-1', 'd'.repeat(64))).rejects.toMatchObject({
      code: 'observer_source_revision_conflict', status: 409,
    })
    expect(pool.sources.get('10')?.revision).toBe(String(Number.MAX_SAFE_INTEGER))
    expect(pool.registryRevision).toBe(0)
    expect(pool.operations).toHaveLength(0)
    expect(pool.outbox).toHaveLength(0)
    expect(pool.calls.some(call => call.sql.includes('UPDATE observer_sources SET'))).toBe(false)
  })

  it('rejects a saturated access revision before issuing the access update', async () => {
    const pool = new FakeManagementPool()
    pool.channels.set('20', channelRow('20', { active: 1 }))
    pool.accesses.set('20:7', {
      observer_channel_id: '20', user_id: 7, granted_at_utc: now, revoked_at_utc: now,
      granted_by_user_id: 1, revision: String(Number.MAX_SAFE_INTEGER),
    })
    await expect(write(pool, {
      kind: 'access.set', channelId: '20', userId: 7, granted: true, expectedRevision: Number.MAX_SAFE_INTEGER,
    }, 'access-overflow-1', 'e'.repeat(64))).rejects.toMatchObject({
      code: 'observer_access_revision_conflict', status: 409,
    })
    expect(pool.accesses.get('20:7')?.revision).toBe(String(Number.MAX_SAFE_INTEGER))
    expect(pool.registryRevision).toBe(0)
    expect(pool.operations).toHaveLength(0)
    expect(pool.outbox).toHaveLength(0)
    expect(pool.calls.some(call => call.sql.includes('UPDATE observer_channel_accesses SET'))).toBe(false)
  })

  it('returns whitelisted operation fields, keeps access pagination channel-scoped, and caps page size', async () => {
    const pool = new FakeManagementPool()
    pool.operations.push({
      id: '00000000-0000-4000-8000-000000000001', action: 'source.create', actor_user_id: 1, target_id: '10',
      result_json: { operation_id: '00000000-0000-4000-8000-000000000001', target_id: '10', revision: 1, registry_revision: 1 },
      audit_json: { kind: 'source.create' }, created_at_utc: now, idempotency_key: 'secret-key', request_hash: 'secret-hash',
    })
    const page = await repository(pool).list(1, { kind: 'operations', afterId: null, limit: 10 })
    expect(page.items[0]).toEqual(expect.objectContaining({ action: 'source.create', audit: { kind: 'source.create' } }))
    expect(page.items[0]).not.toHaveProperty('idempotency_key')
    expect(page.items[0]).not.toHaveProperty('request_hash')

    await expect(repository(pool).list(1, { kind: 'accesses', afterId: null, limit: 10 })).rejects.toMatchObject({
      code: 'observer_management_access_channel_required', status: 400,
    })
    await expect(repository(pool).list(1, { kind: 'accesses', afterId: '7', limit: 100, channelId: '20' })).resolves.toMatchObject({
      items: [], next_cursor: null,
    })
    const accessQuery = pool.calls.at(-1)
    expect(accessQuery?.sql).toContain('x.observer_channel_id=? AND x.user_id>?')
    expect(accessQuery?.params).toEqual(['20', '7', 101])
  })

  it('uses numeric keyset ordering for IDs and returns the real next user cursor at the page cap', async () => {
    const pool = new FakeManagementPool()
    pool.sources.set('2', sourceRow('2'))
    pool.sources.set('10', sourceRow('10'))
    await expect(repository(pool).list(1, { kind: 'sources', afterId: '2', limit: 100 })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: '10' })], next_cursor: null,
    })

    pool.channels.set('20', channelRow('20', { active: 1 }))
    for (let userId = 1; userId <= 101; userId += 1) {
      pool.accesses.set(`20:${userId}`, {
        observer_channel_id: '20', user_id: userId, granted_at_utc: now, revoked_at_utc: null,
        granted_by_user_id: 1, revision: '1',
      })
    }
    const page = await repository(pool).list(1, { kind: 'accesses', afterId: null, limit: 100, channelId: '20' })
    expect(page.items).toHaveLength(100)
    expect(page.items[0]).toMatchObject({ user_id: 1 })
    expect(page.items.at(-1)).toMatchObject({ user_id: 100 })
    expect(page.next_cursor).toBe('100')
    const accessQuery = pool.calls.at(-1)
    expect(accessQuery?.params).toEqual(['20', '0', 101])
  })

  it('keeps every repository SELECT projection explicit', () => {
    const source = readFileSync(new URL('../src/modules/trading/infrastructure/mysql-observer-management-repository.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/SELECT\s+\*/i)
  })

  it('maps connection acquisition failures to the stable storage error', async () => {
    const pool = new FakeManagementPool()
    pool.failGetConnection = true
    await expect(write(pool, sourceCreate())).rejects.toBeInstanceOf(ObserverManagementError)
    await expect(write(pool, sourceCreate(), 'source-write-2', '2'.repeat(64))).rejects.toMatchObject({
      code: 'observer_management_storage_unavailable', status: 503,
    })
  })
})
