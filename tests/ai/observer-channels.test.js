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
  deleteObserverSource,
  getDefaultObserverSource, getDefaultObserverSourceClock, invalidateObserverChannelCache,
  listObserverChannelsForUser, replaceObserverChannelAssignments,
  resolveObserverSourceForUser, updateObserverSource, observerSourceSupportsSymbol,
} from '../../server/routes/ai/observer-channels.js'

describe('observer sources and channels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateObserverChannelCache()
    db.withTransaction.mockImplementation(async callback => callback(async (sql, params = []) => {
      if (/^\s*SELECT\b/i.test(sql)) {
        const row = await db.queryOne(sql, params)
        return [row ? [row] : [], []]
      }
      const result = await db.queryRun(sql, params)
      return [{ insertId:result?.insertId || 0, affectedRows:result?.changes ?? 1 }, []]
    }))
  })

  it('resolves the source through the explicit default channel', async () => {
    db.queryOne.mockResolvedValue({ source_id:2, bridge_user_id:7, channel_id:3, channel_slug:'steady' })
    await expect(getDefaultObserverSource()).resolves.toMatchObject({ bridge_user_id:7, channel_slug:'steady' })
    expect(db.queryOne.mock.calls[0][0]).toContain("channels.is_default = 1")
    expect(db.queryOne.mock.calls[0][0]).toContain("sources.status = 'active'")
    expect(db.queryOne.mock.calls[0][0]).toContain('strategies.symbols_json')
  })

  it('matches default-source symbols without leaking broker suffix differences', () => {
    const source = { symbols_json:'["XAUUSD","EURUSD.s"]' }
    expect(observerSourceSupportsSymbol(source, 'XAUUSD.s')).toBe(true)
    expect(observerSourceSupportsSymbol(source, 'EURUSD')).toBe(true)
    expect(observerSourceSupportsSymbol(source, 'GBPUSD')).toBe(false)
  })

  it('loads the latest persisted clock for the exact default-source account', async () => {
    db.queryOne.mockResolvedValue({
      source_id:2, bridge_user_id:7, trading_account_id:12,
      broker_server:'Broker-Demo', login_account:'12345678',
      timezone_offset_minutes:180, source_clock_status:'persisted_stale',
    })
    await expect(getDefaultObserverSourceClock()).resolves.toMatchObject({
      broker_server:'Broker-Demo', timezone_offset_minutes:180,
    })
    const sql = db.queryOne.mock.calls[0][0]
    expect(sql).toContain('channels.is_default = 1')
    expect(sql).toContain('mds.broker_server')
    expect(sql).toContain('mds.account_login')
    expect(sql).toContain('ORDER BY mds.last_calibrated_at DESC')
  })

  it('creates a source for an eligible bridge account and its own trading account', async () => {
    db.queryOne.mockImplementation(async sql => {
      if (sql.includes('FROM users')) return { id:7, role:'admin', bridge_eligible:1, email:'admin@example.com' }
      if (sql.includes('FROM trading_accounts')) return { id:12 }
      if (sql.includes('FROM auto_prompt_types')) return { id:3, title:'稳健策略' }
      if (sql.includes('strategy_id = ?')) return null
      if (sql.includes('WHERE id = ?')) return { id:5, name:'稳健账户', bridge_user_id:7, trading_account_id:12, strategy_id:3 }
      return null
    })
    db.queryRun.mockResolvedValue({ insertId:5 })
    const source = await createObserverSource(1, {
      name:'稳健账户', bridge_user_id:7, trading_account_id:12, strategy_id:3, notes:'主观摩源',
    })
    expect(source).toMatchObject({
      id:5, bridge_user_id:7, trading_account_id:12, strategy_id:3,
      runtime_transition:{ reason:'created', reconnect_required:true },
    })
    expect(db.withTransaction).toHaveBeenCalledTimes(1)
    expect(db.queryRun.mock.calls[0][1]).toEqual(expect.arrayContaining(['稳健账户', 7, 12, 3, 'active', '主观摩源', 1]))
    expect(db.queryRun.mock.calls.some(([sql]) => sql.includes('INSERT INTO strategy_subscriptions'))).toBe(true)
    expect(db.queryRun.mock.calls.some(([sql]) => sql.includes('INSERT INTO auto_scheduler'))).toBe(true)
  })

  it('accepts a dedicated Pro account without granting administrator role', async () => {
    db.queryOne.mockImplementation(async sql => {
      if (sql.includes('FROM users')) return { id:8, role:'user', plan:'pro', bridge_eligible:1 }
      if (sql.includes('FROM trading_accounts')) return { id:14 }
      if (sql.includes('FROM auto_prompt_types')) return { id:4, title:'趋势策略' }
      if (sql.includes('strategy_id = ?')) return null
      if (sql.includes('WHERE id = ?')) return { id:6, name:'二号观摩源', bridge_user_id:8, trading_account_id:null, strategy_id:4 }
      return null
    })
    db.queryRun.mockResolvedValue({ insertId:6 })
    await expect(createObserverSource(1, { name:'二号观摩源', bridge_user_id:8, strategy_id:4 }))
      .resolves.toMatchObject({ id:6, bridge_user_id:8 })
  })

  it('creates an observer source with both runtime switches disabled', async () => {
    db.queryOne.mockImplementation(async sql => {
      if (sql.includes('FROM users')) return { id:7, role:'admin', bridge_eligible:1 }
      if (sql.includes('FROM trading_accounts')) return { id:12 }
      if (sql.includes("scope = 'platform'")) return { id:3, title:'平台策略', symbols_json:'["XAUUSD"]' }
      if (sql.includes('FROM ai_observer_sources') && sql.includes('strategy_id = ?')) return null
      if (sql.includes('SELECT id FROM strategy_subscriptions')) return null
      if (sql.includes('SELECT * FROM ai_observer_sources')) return { id:5, bridge_user_id:7, trading_account_id:12, strategy_id:3 }
      return null
    })
    db.queryRun.mockResolvedValue({ insertId:5 })

    const source = await createObserverSource(1, {
      name:'暂停来源', bridge_user_id:7, trading_account_id:12, strategy_id:3,
      auto_inference_enabled:false, trade_send_enabled:false,
    })

    expect(source).toMatchObject({
      auto_inference_enabled:false, trade_send_enabled:false,
      runtime_transition:{ reason:'created', reconnect_required:true },
    })
    const subscriptionCall = db.queryRun.mock.calls.find(([sql]) => sql.includes('INSERT INTO strategy_subscriptions'))
    const schedulerCall = db.queryRun.mock.calls.find(([sql]) => sql.includes('INSERT INTO auto_scheduler'))
    const bridgeSettingsCall = db.queryRun.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_bridge_settings'))
    expect(subscriptionCall[0]).toContain('schedule_windows_json')
    expect(subscriptionCall[1]).toEqual([
      7, 12, 3, '["XAUUSD"]', 0,
      'terminal_server', '[1,2,3,4,5]', '[{"start":"00:00","end":"23:59"}]', 'pause_all',
    ])
    expect(schedulerCall[1]).toEqual([7, 0, 3, 0, '["XAUUSD"]'])
    expect(bridgeSettingsCall[1]).toEqual([7, 0, 0])
  })

  it('updates observer-source runtime switches without forcing them back on', async () => {
    db.queryOne.mockImplementation(async sql => {
      if (sql === 'SELECT * FROM ai_observer_sources WHERE id = ?') {
        return { id:5, name:'来源', bridge_user_id:7, trading_account_id:12, strategy_id:3, status:'active', notes:null }
      }
      if (sql.includes('FROM users')) return { id:7, role:'admin', bridge_eligible:1 }
      if (sql.includes('FROM trading_accounts')) return { id:12 }
      if (sql.includes('SELECT id, title FROM auto_prompt_types')) return { id:3, title:'平台策略' }
      if (sql.includes('FROM ai_observer_sources') && sql.includes('strategy_id = ?')) return null
      if (sql.includes('SELECT enabled, enable_auto_trade')) return { enabled:1, enable_auto_trade:1 }
      if (sql.includes('SELECT trade_send_enabled')) return { trade_send_enabled:1, auto_reasoning_enabled:1 }
      if (sql.includes('SELECT id, symbols_json FROM auto_prompt_types')) return { id:3, symbols_json:'["XAUUSD"]' }
      if (sql.includes('SELECT id FROM strategy_subscriptions')) return { id:31 }
      return null
    })
    db.queryRun.mockResolvedValue({ changes:1 })

    const source = await updateObserverSource(5, { auto_inference_enabled:false, trade_send_enabled:false })

    expect(source).toMatchObject({
      auto_inference_enabled:false, trade_send_enabled:false,
      runtime_transition:{ reason:'runtime_updated', reconnect_required:false,
        previous_bridge_user_id:7, previous_trading_account_id:12 },
    })
    expect(db.withTransaction).toHaveBeenCalledTimes(1)
    const subscriptionCall = db.queryRun.mock.calls.find(([sql]) => sql.includes('UPDATE strategy_subscriptions SET trading_account_id'))
    const schedulerCall = db.queryRun.mock.calls.find(([sql]) => sql.includes('INSERT INTO auto_scheduler'))
    const bridgeSettingsCall = db.queryRun.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_bridge_settings'))
    expect(subscriptionCall[1]).toEqual([12, '["XAUUSD"]', 0, 31])
    expect(schedulerCall[1]).toEqual([7, 0, 3, 0, '["XAUUSD"]'])
    expect(bridgeSettingsCall[1]).toEqual([7, 0, 0])
  })

  it('rejects a source account without active Pro access', async () => {
    db.queryOne.mockResolvedValue({ id:8, role:'user', plan:'plus', bridge_eligible:0 })
    await expect(createObserverSource(1, { name:'错误来源', bridge_user_id:8, strategy_id:4 }))
      .rejects.toThrow('bridge_user_requires_pro')
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('revalidates account ownership when changing source bridge user', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id:5, name:'来源', bridge_user_id:7, trading_account_id:12, status:'active' })
      .mockResolvedValueOnce({ id:9, role:'admin', bridge_eligible:1 })
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

  it('deletes a source only after disabling its persisted runtime atomically', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id:5, bridge_user_id:7, strategy_id:3 })
      .mockResolvedValueOnce({ count:0 })
    const run = vi.fn(async () => [{ affectedRows:1 }])
    db.withTransaction.mockImplementation(callback => callback(run))

    await expect(deleteObserverSource(5)).resolves.toMatchObject({
      id:5, bridge_user_id:7, strategy_id:3,
      runtime_transition:{ reason:'deleted', reconnect_required:true, previous_bridge_user_id:7 },
    })
    expect(run.mock.calls.some(([sql]) => sql.includes('UPDATE strategy_subscriptions'))).toBe(true)
    expect(run.mock.calls.some(([sql]) => sql.includes('UPDATE auto_scheduler'))).toBe(true)
    expect(run.mock.calls.some(([sql]) => sql.includes('UPDATE user_bridge_settings'))).toBe(true)
    expect(run.mock.calls.at(-1)[0]).toContain('DELETE FROM ai_observer_sources')
  })

  it('lists only channels visible to the viewer and caches the short-lived result', async () => {
    db.queryAll.mockResolvedValue([{ id:3, audience:'plus', bridge_user_id:7, strategy_id:9 }])
    await expect(listObserverChannelsForUser(22, 'plus')).resolves.toHaveLength(1)
    await expect(listObserverChannelsForUser(22, 'plus')).resolves.toHaveLength(1)
    expect(db.queryAll).toHaveBeenCalledTimes(1)
    expect(db.queryAll.mock.calls[0][1]).toEqual(['plus', 22])
    expect(db.queryAll.mock.calls[0][0]).toContain('sources.strategy_id')
  })

  it('returns no source instead of falling back when the viewer has no authorized channel', async () => {
    db.queryAll.mockResolvedValue([])
    await expect(resolveObserverSourceForUser(22, 'plus')).resolves.toBeNull()
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
