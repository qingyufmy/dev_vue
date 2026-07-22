import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
  queryRun: vi.fn(),
  withTransaction: vi.fn(),
}))

vi.mock('../../server/db.js', () => db)

import {
  createObserverChannel, createObserverSource, deleteObserverChannel,
  getDefaultObserverSource, invalidateObserverChannelCache,
  listObserverChannelsForUser, replaceObserverChannelAssignments,
  resolveObserverSourceForUser, updateObserverSource,
} from '../../server/routes/ai/observer-channels.js'

describe('observer sources and channels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateObserverChannelCache()
  })

  it('resolves the source through the explicit default channel', async () => {
    db.queryOne.mockResolvedValue({ source_id:2, bridge_user_id:7, channel_id:3, channel_slug:'steady' })
    await expect(getDefaultObserverSource()).resolves.toMatchObject({ bridge_user_id:7, channel_slug:'steady' })
    expect(db.queryOne.mock.calls[0][0]).toContain("channels.is_default = 1")
    expect(db.queryOne.mock.calls[0][0]).toContain("sources.status = 'active'")
  })

  it('creates a source only for an active admin and its own trading account', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id:7, role:'admin', email:'admin@example.com' })
      .mockResolvedValueOnce({ id:12 })
      .mockResolvedValueOnce({ id:5, name:'稳健账户', bridge_user_id:7, trading_account_id:12 })
    db.queryRun.mockResolvedValue({ insertId:5 })
    const source = await createObserverSource(1, {
      name:'稳健账户', bridge_user_id:7, trading_account_id:12, notes:'主观摩源',
    })
    expect(source).toMatchObject({ id:5, bridge_user_id:7, trading_account_id:12 })
    expect(db.queryRun.mock.calls[0][1]).toEqual(expect.arrayContaining(['稳健账户', 7, 12, 'active', '主观摩源', 1]))
  })

  it('rejects a regular user as a phase-one bridge source', async () => {
    db.queryOne.mockResolvedValue({ id:8, role:'user' })
    await expect(createObserverSource(1, { name:'错误来源', bridge_user_id:8 }))
      .rejects.toThrow('bridge_user_must_be_admin')
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('revalidates account ownership when changing source bridge user', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id:5, name:'来源', bridge_user_id:7, trading_account_id:12, status:'active' })
      .mockResolvedValueOnce({ id:9, role:'admin' })
      .mockResolvedValueOnce(null)
    await expect(updateObserverSource(5, { bridge_user_id:9 }))
      .rejects.toThrow('trading_account_not_owned_by_source')
  })

  it('makes the first channel the only default inside one transaction', async () => {
    db.queryOne.mockResolvedValue({ id:5 })
    const run = vi.fn(async sql => {
      if (sql.includes('INSERT INTO ai_observer_channels')) return [{ insertId:11 }]
      if (sql.includes('COUNT(*)')) return [[{ count:0 }]]
      if (sql.includes('SELECT * FROM ai_observer_channels')) return [[{ id:11, is_default:1 }]]
      return [{ affectedRows:1 }]
    })
    db.withTransaction.mockImplementation(callback => callback(run))
    const channel = await createObserverChannel({ name:'稳健频道', slug:'steady', source_id:5 })
    expect(channel).toMatchObject({ id:11, is_default:1 })
    expect(run.mock.calls.some(([sql]) => sql.includes('SET is_default = 0'))).toBe(true)
    expect(run.mock.calls.some(([sql]) => sql.includes('SET is_default = 1'))).toBe(true)
  })

  it('prevents deleting the default channel', async () => {
    db.queryOne.mockResolvedValue({ id:11, is_default:1 })
    await expect(deleteObserverChannel(11)).rejects.toThrow('default_observer_channel_cannot_be_deleted')
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('lists only channels visible to the viewer and caches the short-lived result', async () => {
    db.queryAll.mockResolvedValue([{ id:3, audience:'plus', bridge_user_id:7 }])
    await expect(listObserverChannelsForUser(22, 'plus')).resolves.toHaveLength(1)
    await expect(listObserverChannelsForUser(22, 'plus')).resolves.toHaveLength(1)
    expect(db.queryAll).toHaveBeenCalledTimes(1)
    expect(db.queryAll.mock.calls[0][1]).toEqual(['plus', 22])
  })

  it('rejects a requested channel outside the viewer visibility set', async () => {
    db.queryAll.mockResolvedValue([{ id:3, bridge_user_id:7 }])
    await expect(resolveObserverSourceForUser(22, 'plus', 4))
      .rejects.toThrow('observer_channel_access_denied')
  })

  it('replaces explicit channel assignments atomically', async () => {
    db.queryOne.mockResolvedValue({ id:3 })
    db.queryAll
      .mockResolvedValueOnce([{ id:22 }, { id:23 }])
      .mockResolvedValueOnce([{ user_id:22 }, { user_id:23 }])
    const run = vi.fn(async () => [{ affectedRows:1 }])
    db.withTransaction.mockImplementation(callback => callback(run))
    const assignments = await replaceObserverChannelAssignments(3, 1, [22, 23, 22])
    expect(assignments).toHaveLength(2)
    expect(run.mock.calls.filter(([sql]) => sql.includes('INSERT INTO ai_observer_channel_assignments'))).toHaveLength(2)
  })
})
