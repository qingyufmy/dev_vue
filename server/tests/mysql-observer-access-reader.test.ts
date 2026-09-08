import { describe, expect, it, vi } from 'vitest'
import type { ExecuteValues, FieldPacket, RowDataPacket } from 'mysql2/promise'
import { MysqlObserverAccessReader, type ObserverSqlExecutor } from '../src/modules/trading/infrastructure/mysql-observer-access-reader.js'

type TestRow = Record<string, unknown>

class FakeExecutor {
  readonly calls: Array<{ sql: string; params: ExecuteValues[] }> = []
  currentRows: TestRow[] = []
  authorizeRows: TestRow[] = []
  listPages: TestRow[][] = []
  failure: Error | null = null

  async execute<T extends RowDataPacket[]>(sql: string, params: ExecuteValues[] = []): Promise<[T, FieldPacket[]]> {
    if (this.failure) throw this.failure
    this.calls.push({ sql, params })
    const rows = sql.includes('c.id>?') ? (this.listPages.shift() ?? []) : this.authorizeRows
    this.currentRows = rows
    return [rows as unknown as T, []]
  }
}

const now = new Date('2026-09-05T08:00:00.000Z')

function row(overrides: TestRow = {}): TestRow {
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

function reader(executor: FakeExecutor) {
  return new MysqlObserverAccessReader(executor as unknown as ObserverSqlExecutor, principals(() => executor.currentRows), () => now)
}

function readerWithClock(executor: FakeExecutor, values: Date[]) {
  let index = 0
  return new MysqlObserverAccessReader(executor as unknown as ObserverSqlExecutor, principals(() => executor.currentRows), () => values[Math.min(index++, values.length - 1)]!)
}

describe('MysqlObserverAccessReader', () => {
  it('uses the same structural and audience policy for authorization and listing', async () => {
    const executor = new FakeExecutor()
    executor.authorizeRows = [row()]
    const access = reader(executor)
    await expect(access.authorize(9, '12', '7')).resolves.toMatchObject({
      userId: 9, channelId: '12', sourceId: '13', accountId: '7', ownershipRevision: '4', operatorUserId: 42,
      expiresAtUtc: '2026-09-05T08:00:30.000Z',
    })

    executor.listPages = [[row({ channel_id: '1', audience: 'assigned' }), row({ channel_id: '2' })]]
    await expect(access.list(9)).resolves.toEqual([{ id: '2', displayName: '黄金观摩', sourceAccountId: '7', active: true }])
    expect(executor.calls.some(call => call.sql.includes('LIMIT 100') && call.sql.includes('c.id>?'))).toBe(true)
  })

  it.each([
    { name: 'plus exact plan', overrides: { audience: 'plus', viewer_plan: 'plus', viewer_plan_expires_at: new Date('2026-09-05T08:00:10.000Z') }, allowed: true },
    { name: 'pro does not inherit plus', overrides: { audience: 'plus', viewer_plan: 'pro', viewer_plan_expires_at: new Date('2026-09-05T08:00:10.000Z') }, allowed: false },
    { name: 'expired membership', overrides: { audience: 'pro', viewer_plan: 'pro', viewer_plan_expires_at: new Date('2026-09-05T07:59:59.000Z') }, allowed: false },
    { name: 'active explicit grant ignores expired membership', overrides: { audience: 'pro', viewer_plan: 'pro', viewer_plan_expires_at: new Date('2026-09-05T07:59:59.000Z'), access_granted_at_utc: new Date('2026-09-05T07:00:00.000Z'), access_revision: 8 }, allowed: true },
    { name: 'invalid non-null membership date', overrides: { audience: 'plus', viewer_plan: 'plus', viewer_plan_expires_at: 'not-a-date' }, allowed: false },
  ])('applies audience and expiry rule: $name', async ({ overrides, allowed }) => {
    const executor = new FakeExecutor()
    executor.authorizeRows = [row(overrides)]
    const result = await reader(executor).authorize(9, '12', '7')
    expect(Boolean(result)).toBe(allowed)
  })

  it.each([
    { name: 'valid grant', overrides: { audience: 'assigned', access_granted_at_utc: new Date('2026-09-05T07:00:00.000Z'), access_revision: 8 }, allowed: true },
    { name: 'future grant', overrides: { audience: 'assigned', access_granted_at_utc: new Date('2026-09-05T09:00:00.000Z'), access_revision: 8 }, allowed: false },
    { name: 'revoked grant', overrides: { audience: 'assigned', access_granted_at_utc: new Date('2026-09-05T07:00:00.000Z'), access_revoked_at_utc: new Date('2026-09-05T07:30:00.000Z'), access_revision: 8 }, allowed: false },
    { name: 'malformed revocation', overrides: { audience: 'assigned', access_granted_at_utc: new Date('2026-09-05T07:00:00.000Z'), access_revoked_at_utc: 'not-a-date', access_revision: 8 }, allowed: false },
  ])('handles explicit grant state: $name', async ({ overrides, allowed }) => {
    const executor = new FakeExecutor()
    executor.authorizeRows = [row(overrides)]
    const result = await reader(executor).authorize(9, '12', '7')
    expect(Boolean(result)).toBe(allowed)
  })

  it('propagates SQL failures instead of authorizing from a fallback', async () => {
    const executor = new FakeExecutor()
    executor.failure = new Error('sql_unavailable')
    await expect(reader(executor).authorize(9, '12', '7')).rejects.toThrow('sql_unavailable')
  })

  it('rejects an authorization whose SQL read crossed its 30-second TTL', async () => {
    const executor = new FakeExecutor()
    executor.authorizeRows = [row()]
    const started = now
    const result = await readerWithClock(executor, [started, new Date(started.getTime() + 30_001)]).authorize(9, '12', '7')
    expect(result).toBeNull()
  })

  it('continues bounded keyset pages past rows denied by the audience policy', async () => {
    const executor = new FakeExecutor()
    executor.listPages = [
      Array.from({ length: 100 }, (_, index) => row({ channel_id: String(index + 1), audience: 'assigned' })),
      [row({ channel_id: '101' })],
    ]
    await expect(reader(executor).list(9)).resolves.toEqual([{ id: '101', displayName: '黄金观摩', sourceAccountId: '7', active: true }])
    expect(executor.calls.map(call => call.params[2])).toEqual(['0', '100'])
  })

  it('returns every authorized channel across 100-plus rows', async () => {
    const executor = new FakeExecutor()
    executor.listPages = [
      Array.from({ length: 100 }, (_, index) => row({ channel_id: String(index + 1) })),
      [row({ channel_id: '101' })],
    ]
    await expect(reader(executor).list(9)).resolves.toHaveLength(101)
    expect(executor.calls.map(call => call.params[2])).toEqual(['0', '100'])
  })

  it('filters a membership authorization that expires while list pagination is in flight', async () => {
    const executor = new FakeExecutor()
    executor.listPages = [[row({ audience: 'plus', viewer_plan: 'plus', viewer_plan_expires_at: new Date('2026-09-05T08:00:10.000Z') })]]
    const started = now
    const access = readerWithClock(executor, [
      started,
      new Date(started.getTime() + 11_000),
      new Date(started.getTime() + 11_001),
    ])
    await expect(access.list(9)).resolves.toEqual([])
  })

  it('rejects an incomplete source, disabled operator or mismatched source account', async () => {
    for (const overrides of [
      { channel_slug: null },
      { source_status: 'disabled' },
      { source_configuration_status: 'pending' },
      { operator_deletion_status: 'disabled' },
      { source_trading_account_id: '8' },
      { ownership_revision: null },
    ]) {
      const executor = new FakeExecutor()
      executor.authorizeRows = [row(overrides)]
      await expect(reader(executor).authorize(9, '12', '7')).resolves.toBeNull()
    }
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


it('continues after a full page whose operators are inactive and batches identity facts', async () => {
  const executor = new FakeExecutor()
  executor.listPages = [Array.from({ length: 100 }, (_, index) => row({ channel_id: String(index + 1), operator_user_id: 42 })),
    [row({ channel_id: '101', operator_user_id: 43 })]]
  const facts = new Map([9, 43].map(userId => [userId, { userId, plan: 'free', planExpiresAtUtc: null, tokenVersion: 1 }] as const))
  const readMany = vi.fn(async (_ids: readonly number[], _lock: 'none' | 'share') => facts)
  const access = new MysqlObserverAccessReader(executor as unknown as ObserverSqlExecutor, { readMany }, () => now)
  expect(await access.list(9)).toEqual([{ id: '101', displayName: '黄金观摩', sourceAccountId: '7', active: true }])
  expect(readMany.mock.calls).toEqual([[[9, 42], 'none'], [[9, 43], 'none']])
  expect(executor.calls.every(call => !/JOIN users|viewer\.|operator_user\./.test(call.sql))).toBe(true)
})

it('uses shared principal facts for transaction authorization and rejects another executor', async () => {
  const executor = new FakeExecutor(); executor.authorizeRows = [row()]
  const facts = new Map([9, 42].map(userId => [userId, { userId, plan: 'free', planExpiresAtUtc: null, tokenVersion: 8 }] as const))
  const readMany = vi.fn(async (_ids: readonly number[], _lock: 'none' | 'share') => facts)
  const access = new MysqlObserverAccessReader(executor as unknown as ObserverSqlExecutor, { readMany }, () => now)
  expect(await access.authorizeOn(executor as unknown as ObserverSqlExecutor, 9, '12')).toMatchObject({ userTokenVersion: 8 })
  expect(readMany).toHaveBeenCalledWith([9, 42], 'share')
  await expect(access.authorizeOn(new FakeExecutor() as unknown as ObserverSqlExecutor, 9, '12')).rejects.toThrow('observer_transaction_connection_mismatch')
  expect(readMany).toHaveBeenCalledOnce()
})

it('does not trust joined identity fields when the principal capability omits the viewer', async () => {
  const executor = new FakeExecutor(); executor.authorizeRows = [row({ viewer_plan: 'pro' })]
  const access = new MysqlObserverAccessReader(executor as unknown as ObserverSqlExecutor, { async readMany() { return new Map() } }, () => now)
  expect(await access.authorize(9, '12')).toBe(null)
})
