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
  contextRows: Row[] = [contextRow()]
  observerRows: Row[] = [observerRow()]
  asPool() { return this as unknown as Pool }
  async execute(sql: string, params: unknown[] = []) {
    const placeholders = (sql.match(/\?/g) ?? []).length
    if (placeholders !== params.length) throw new Error(`fake_sql_params:${placeholders}:${params.length}`)
    if (sql.includes('SELECT user_id, mode')) return [this.contextRows, []]
    if (sql.includes('FROM observer_channels c')) return [this.observerRows, []]
    throw new Error('unexpected-context-read')
  }
}

function repository(pool: FakeObserverPool) {
  const reader = new MysqlObserverAccessReader(pool.asPool(), principals(() => pool.observerRows), () => now)
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

})

function principals(rows: () => Record<string, unknown>[]) {
  return { async readMany(ids: readonly number[]) {
    const row = rows()[0]
    const facts = new Map<number, { userId: number; plan: string; planExpiresAtUtc: string | null; tokenVersion: number }>()
    if (!row) return facts
    for (const id of ids) {
      const viewer = id === 9
      if (viewer ? row.viewer_deletion_status !== 'active' || row.viewer_deleted_at !== null
        : row.operator_deletion_status !== 'active' || row.operator_deleted_at !== null) continue
      const expiry = viewer ? row.viewer_plan_expires_at : null
      facts.set(id, { userId: id, plan: String(viewer ? row.viewer_plan : 'free'),
        planExpiresAtUtc: expiry instanceof Date ? expiry.toISOString() : expiry as string | null,
        tokenVersion: Number(viewer ? row.viewer_token_version : 0) })
    }
    return facts
  } }
}
