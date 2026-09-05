import { describe, expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlObserverAccessReader } from '../src/modules/trading/infrastructure/mysql-observer-access-reader.js'
import { MysqlTradingRepository } from '../src/modules/trading/infrastructure/mysql-trading-repository.js'

type Row = Record<string, unknown>

const now = new Date('2026-09-05T08:00:00.000Z')

function observerRow(overrides: Row = {}): Row {
  return {
    channel_id: '12', display_name: '黄金观摩', channel_slug: 'gold',
    source_id: '13', source_trading_account_id: '7', source_account_id: '7', ownership_revision: '4',
    channel_active: 1, channel_revision: '3', audience: 'all', source_revision: '2',
    source_status: 'active', source_configuration_status: 'ready', operator_user_id: 42,
    operator_deletion_status: 'active', operator_deleted_at: null, account_deleted_at: null,
    viewer_deletion_status: 'active', viewer_deleted_at: null, viewer_plan: 'free',
    viewer_plan_expires_at: null, viewer_token_version: 1,
    access_granted_at_utc: null, access_revoked_at_utc: null, access_revision: null,
    ...overrides,
  }
}

function contextRow(overrides: Row = {}): Row {
  return {
    user_id: 9, mode: 'observer', trading_account_id: null, observer_channel_id: '12', read_only: 0, revision: 3,
    ...overrides,
  }
}

class FakeObserverPool {
  readonly calls: Array<{ client: 'pool' | 'connection'; sql: string; params: unknown[] }> = []
  readonly transactions: string[] = []
  readonly inserts: unknown[][] = []
  contextRows: Row[] = [contextRow()]
  observerRows: Row[] = [observerRow()]
  revisionRows: Row[] = [{ revision: 3 }]

  readonly connection = {
    execute: async (sql: string, params: unknown[] = []) => this.handle(sql, params, 'connection'),
    beginTransaction: async () => { this.transactions.push('begin') },
    commit: async () => { this.transactions.push('commit') },
    rollback: async () => { this.transactions.push('rollback') },
    release: () => { this.transactions.push('release') },
  }

  async execute(sql: string, params: unknown[] = []) {
    return this.handle(sql, params, 'pool')
  }

  async getConnection() { return this.connection }

  asPool() { return this as unknown as Pool }

  private async handle(sql: string, params: unknown[], client: 'pool' | 'connection') {
    const placeholders = (sql.match(/\?/g) ?? []).length
    if (placeholders !== params.length) throw new Error(`fake_sql_params:${placeholders}:${params.length}`)
    this.calls.push({ client, sql, params })
    if (sql.includes('INSERT INTO trading_contexts')) {
      this.inserts.push(params)
      return [[], []]
    }
    if (sql.includes('SELECT user_id, mode')) return [this.contextRows, []]
    if (sql.includes('SELECT revision FROM trading_contexts')) return [this.revisionRows, []]
    if (sql.includes('FROM observer_channels c')) return [this.observerRows, []]
    return [[], []]
  }
}

function repository(pool: FakeObserverPool) {
  const reader = new MysqlObserverAccessReader(pool.asPool(), () => now)
  return new MysqlTradingRepository(pool.asPool(), null, reader)
}

describe('MysqlTradingRepository observer context authorization', () => {
  it('forces observer contexts to read-only even if a dirty row says otherwise', async () => {
    const pool = new FakeObserverPool()
    const result = await repository(pool).getContext(9)
    expect(result).toMatchObject({ userId: 9, mode: 'observer', accountId: null, observerChannelId: '12', readOnly: true, revision: 3 })
  })

  it('blocks an observer context with no channel or no current authorization', async () => {
    const missingChannel = new FakeObserverPool()
    missingChannel.contextRows = [contextRow({ observer_channel_id: null })]
    await expect(repository(missingChannel).getContext(9)).resolves.toMatchObject({ mode: 'blocked', accountId: null, observerChannelId: null, readOnly: true })

    const missingAuthorization = new FakeObserverPool()
    missingAuthorization.observerRows = []
    await expect(repository(missingAuthorization).getContext(9)).resolves.toMatchObject({ mode: 'blocked', accountId: null, observerChannelId: null, readOnly: true })
  })

  it('rechecks observer authorization on the transaction connection before writing', async () => {
    const pool = new FakeObserverPool()
    const result = await repository(pool).saveContext({
      userId: 9, mode: 'observer', accountId: null, observerChannelId: '12', readOnly: true,
    }, 3)
    expect(result).toMatchObject({ mode: 'observer', observerChannelId: '12', readOnly: true, revision: 4 })
    expect(pool.calls.some(call => call.client === 'connection' && call.sql.includes('FOR SHARE'))).toBe(true)
    expect(pool.inserts).toEqual([[9, 'observer', null, '12', 1, 4]])
    expect(pool.transactions).toEqual(['begin', 'commit', 'release'])
  })

  it('rejects a writable observer context before opening a transaction', async () => {
    const pool = new FakeObserverPool()
    await expect(repository(pool).saveContext({
      userId: 9, mode: 'observer', accountId: null, observerChannelId: '12', readOnly: false,
    }, 3)).rejects.toMatchObject({ code: 'trading_context_invalid' })
    expect(pool.transactions).toEqual([])
    expect(pool.inserts).toEqual([])
  })

  it('rejects an unauthorized observer write and leaves no context row', async () => {
    const pool = new FakeObserverPool()
    pool.observerRows = []
    await expect(repository(pool).saveContext({
      userId: 9, mode: 'observer', accountId: null, observerChannelId: '12', readOnly: true,
    }, 3)).rejects.toMatchObject({ code: 'trading_account_forbidden' })
    expect(pool.inserts).toEqual([])
    expect(pool.transactions).toEqual(['begin', 'rollback', 'release'])
    expect(pool.calls.some(call => call.client === 'connection' && call.sql.includes('FOR SHARE'))).toBe(true)
  })
})
