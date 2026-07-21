import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
  withTransaction: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-15 12:00:00'),
  logAudit: vi.fn(),
}))

vi.mock('../../server/routes/ai/config.js', () => ({
  parsePromptSymbols: vi.fn(value => {
    try { return JSON.parse(value || '[]') } catch { return [] }
  }),
}))

vi.mock('../../server/routes/ai/model-profiles.js', () => ({
  getModelProfileById: vi.fn(),
}))

import * as db from '../../server/db.js'
import * as models from '../../server/routes/ai/model-profiles.js'
import {
  adminListUserStrategies,
  adminListUserSubscriptions,
  createStrategy,
  createSubscription,
  createTradingAccount,
  deleteStrategy,
  deleteSubscription,
  getStrategyDeletionPreview,
  getStrategyById,
  getSubscriptionWithContext,
  listStrategies,
  updateStrategy,
  updateSubscription,
  updateTradingAccount,
} from '../../server/routes/ai/strategy-ownership.js'

const PRO = { role: 'user', plan: 'pro', plan_expires_at: null, has_pro_access: 1 }
const FREE = { role: 'user', plan: 'free', plan_expires_at: null, has_pro_access: 0 }
const PLATFORM = {
  id: 1, title: '平台策略', scope: 'platform', owner_user_id: 0, is_active: 1,
  visibility_status: 'active', symbols_json: '["XAUUSD","EURUSD"]', deleted_at: null,
  model_profile_id: null, inference_mode: 'platform_model', version: 1,
}
const PRIVATE = {
  id: 2, title: '私有策略', scope: 'private', owner_user_id: 2, is_active: 1,
  visibility_status: 'active', symbols_json: '["XAUUSD","EURUSD"]', deleted_at: null,
  model_profile_id: null, inference_mode: 'user_default', version: 1,
}
const ACCOUNT = {
  id: 10, user_id: 2, broker_server: 'Demo', login_account: '123', margin_mode: 'hedging',
  review_status: 'approved', observe_status: 'active', is_deleted: 0,
}
const SUB = {
  id: 20, user_id: 2, trading_account_id: 10, strategy_id: 2,
  symbols_json: null, execution_enabled: 0, memory_mode: 'isolated', is_deleted: 0,
}

let txRun

function latestStrategyInsert() {
  return [...txRun.mock.calls].reverse().find(([sql]) => sql.includes('INSERT INTO auto_prompt_types'))
}

function defaultQueryOne(sql) {
  if (sql.includes('FROM users')) return PRO
  if (sql.includes('FROM auto_prompt_types apt')) return PRIVATE
  if (sql.includes('SELECT * FROM auto_prompt_types')) return PRIVATE
  if (sql.includes('SELECT trading_account_id FROM strategy_subscriptions')) return { trading_account_id: 10 }
  if (sql.includes('FROM strategy_subscriptions')) return SUB
  if (sql.includes('FROM trading_accounts')) return ACCOUNT
  return null
}

function defaultTx(sql) {
  if (sql.includes('FROM users')) return [[PRO], []]
  if (sql.includes('FROM trading_accounts')) return [[ACCOUNT], []]
  if (sql.includes('FROM auto_prompt_types')) return [[PRIVATE], []]
  if (sql.includes('FROM strategy_subscriptions ss')) return [[], []]
  if (sql.includes('SELECT * FROM strategy_subscriptions')) return [[SUB], []]
  if (sql.startsWith('INSERT')) return [{ insertId: 20, affectedRows: 1 }, []]
  return [{ affectedRows: 1 }, []]
}

beforeEach(() => {
  vi.clearAllMocks()
  db.queryOne.mockImplementation(defaultQueryOne)
  db.queryAll.mockResolvedValue([])
  db.queryRun.mockResolvedValue({ insertId: 2, changes: 1 })
  models.getModelProfileById.mockResolvedValue({ id: 8, scope: 'user', owner_user_id: 2, status: 'active' })
  txRun = vi.fn(defaultTx)
  db.withTransaction.mockImplementation(fn => fn(txRun))
})

describe('strategy visibility and mutation permissions', () => {
  it('admin can list every owner without an owner filter', async () => {
    db.queryAll.mockResolvedValue([PLATFORM, PRIVATE, { ...PRIVATE, id: 3, owner_user_id: 9 }])
    const rows = await listStrategies(1, 'admin', { includeInactive: true })
    expect(rows).toHaveLength(3)
    expect(db.queryAll.mock.calls[0][0]).not.toContain('owner_user_id = ?')
  })

  it('regular list is parameterized and limited to active platform plus own private', async () => {
    await listStrategies(2, 'user')
    const [sql, params] = db.queryAll.mock.calls[0]
    expect(sql).toContain("apt.visibility_status = 'active'")
    expect(sql).toContain('apt.owner_user_id = ?')
    expect(params).toContain(2)
  })

  it('rejects an expired or free user before listing', async () => {
    db.queryOne.mockImplementation(sql => sql.includes('FROM users') ? FREE : null)
    await expect(listStrategies(3, 'user')).rejects.toThrow('pro_access_required')
  })

  it('hides platform drafts from a regular detail request', async () => {
    db.queryOne.mockImplementation(sql => sql.includes('FROM users') ? PRO : { ...PLATFORM, visibility_status: 'draft' })
    await expect(getStrategyById(1, 2, 'user')).resolves.toBeNull()
  })

  it('lets an owner view a private draft but not execute it', async () => {
    const draft = { ...PRIVATE, visibility_status: 'draft' }
    db.queryOne.mockImplementation(sql => sql.includes('FROM users') ? PRO : draft)
    await expect(getStrategyById(2, 2, 'user')).resolves.toMatchObject({ id: 2 })
    await expect(getStrategyById(2, 2, 'user', { forExecution: true })).resolves.toBeNull()
  })

  it('hides another user private strategy but lets admin inspect it', async () => {
    db.queryOne.mockImplementation(sql => sql.includes('FROM users') ? PRO : PRIVATE)
    await expect(getStrategyById(2, 4, 'user')).resolves.toBeNull()
    await expect(getStrategyById(2, 1, 'admin')).resolves.toMatchObject({ id: 2 })
  })

  it('creates private strategies with server-owned owner and user-default model semantics', async () => {
    await createStrategy(2, 'user', { scope: 'private', owner_user_id: 99, inference_mode: 'platform_model', title: 'P', symbols: ['XAUUSD.a'], include_portfolio_context: true })
    const params = latestStrategyInsert()[1]
    expect(params).toContain('private')
    expect(params).toContain(2)
    expect(params).toContain('user_default')
    expect(params).not.toContain(99)
    expect(params[7]).toBe(1)
  })

  it('forces platform strategies to exclude portfolio context', async () => {
    await createStrategy(1, 'admin', { scope: 'platform', symbols: ['XAUUSD'], include_portfolio_context: true })
    expect(latestStrategyInsert()[1][7]).toBe(0)
  })

  it('does not create administrator private strategies', async () => {
    await expect(createStrategy(1, 'admin', { scope: 'private', title: 'legacy admin private', symbols: ['XAUUSD'] }))
      .rejects.toThrow('admin_private_strategy_disabled')
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('limits a Pro user to one non-deleted private strategy', async () => {
    txRun.mockImplementation(sql => {
      if (sql.includes('COUNT(*) AS strategy_count')) return [[{ strategy_count:1 }], []]
      return defaultTx(sql)
    })
    await expect(createStrategy(2, 'user', { scope:'private', title:'第二条', symbols:['XAUUSD'] }))
      .rejects.toThrow('private_strategy_limit_reached')
    expect(latestStrategyInsert()).toBeUndefined()
  })

  it('derives the executable flag from the strategy visibility state', async () => {
    await createStrategy(1, 'admin', { scope: 'platform', visibility_status: 'draft', is_active: true, symbols: ['XAUUSD'] })
    expect(latestStrategyInsert()[1][9]).toBe(0)

    db.queryRun.mockClear()
    db.queryOne.mockImplementation(sql => sql.includes('FROM users') ? PRO : { ...PLATFORM, is_active: 0, visibility_status: 'draft' })
    await updateStrategy(1, 1, 'admin', { visibility_status: 'active', is_active: false })
    expect(db.queryRun.mock.calls[0][1][9]).toBe(1)
  })

  it('imports legacy prompt controls into structured fields and stores a clean prompt', async () => {
    await createStrategy(2, 'user', {
      scope: 'private', title: 'Legacy', symbols: ['XAUUSD'],
      system_prompt: '分析黄金 {{ATF:H1:80}} {{ATF:H4:50}} {{USE_CHAN}}',
    })
    const params = latestStrategyInsert()[1]
    expect(params[2]).toBe('分析黄金')
    expect(JSON.parse(params[4])).toEqual({
      primary_timeframe: 'H1',
      timeframes: [{ timeframe: 'H1', kline_count: 80 }, { timeframe: 'H4', kline_count: 50 }],
    })
    expect(params[6]).toBe(1)
  })

  it('allows only an active model owned by the private strategy creator', async () => {
    models.getModelProfileById.mockResolvedValue({ id: 8, scope: 'user', owner_user_id: 9, status: 'active' })
    await expect(createStrategy(2, 'user', { scope: 'private', model_profile_id: 8, symbols: ['XAUUSD'] }))
      .rejects.toThrow('model_profile_access_denied')
  })

  it('allows an active platform model binding and rejects user models on platform strategies', async () => {
    models.getModelProfileById.mockResolvedValueOnce({ id: 8, scope: 'platform', owner_user_id: 0, status: 'active' })
    await expect(createStrategy(1, 'admin', { scope: 'platform', model_profile_id: 8, symbols: ['XAUUSD'] })).resolves.toBeTruthy()
    expect(latestStrategyInsert()[1]).toContain('platform_bound_model')

    models.getModelProfileById.mockResolvedValueOnce({ id: 9, scope: 'user', owner_user_id: 1, status: 'active' })
    await expect(createStrategy(1, 'admin', { scope: 'platform', model_profile_id: 9, symbols: ['XAUUSD'] }))
      .rejects.toThrow('model_profile_access_denied')
    await expect(createStrategy(2, 'user', { scope: 'platform', symbols: ['XAUUSD'] }))
      .rejects.toThrow('platform_requires_admin')
  })

  it('administrator cannot modify or delete somebody else private strategy', async () => {
    db.queryOne.mockResolvedValue(PRIVATE)
    await expect(updateStrategy(2, 1, 'admin', { title: '越权' })).rejects.toThrow('access_denied')
    await expect(deleteStrategy(2, 1, 'admin')).rejects.toThrow('access_denied')
  })

  it('previews the authoritative subscription impact before deletion', async () => {
    db.queryOne.mockImplementation(sql => {
      if (sql.includes('COUNT(*) AS subscription_count')) return { subscription_count: 4, active_subscription_count: 2, affected_user_count: 2 }
      return defaultQueryOne(sql)
    })
    await expect(getStrategyDeletionPreview(2, 2, 'user')).resolves.toMatchObject({
      id: 2, title: PRIVATE.title, version: 1,
      subscription_count: 4, active_subscription_count: 2, affected_user_count: 2,
    })
  })

  it('requires the exact title and current impact before deleting a strategy', async () => {
    await expect(deleteStrategy(2, 2, 'user', {
      confirm_title: 'wrong title', confirm_version: 1,
      expected_active_subscriptions: 0, confirm_stop_subscriptions: true,
    })).rejects.toThrow('strategy_delete_confirmation_mismatch')
    expect(txRun.mock.calls.some(([sql]) => sql.startsWith('UPDATE auto_prompt_types'))).toBe(false)

    txRun = vi.fn(sql => {
      if (sql.includes('FROM auto_prompt_types')) return [[PRIVATE], []]
      if (sql.includes('FROM strategy_subscriptions') && sql.includes('FOR UPDATE')) return [[{ id:20, user_id:2, execution_enabled:1 }], []]
      if (sql.includes('FROM users')) return [[PRO], []]
      return [{ affectedRows: 1 }, []]
    })
    db.withTransaction.mockImplementation(fn => fn(txRun))
    await expect(deleteStrategy(2, 2, 'user', {
      confirm_title: PRIVATE.title, confirm_version: 1,
      expected_active_subscriptions: 0, confirm_stop_subscriptions: true,
    })).rejects.toThrow('strategy_delete_impact_changed')
  })

  it('soft deletes only after typed confirmation and records an audit event', async () => {
    txRun = vi.fn(sql => {
      if (sql.includes('FROM auto_prompt_types')) return [[PRIVATE], []]
      if (sql.includes('FROM strategy_subscriptions') && sql.includes('FOR UPDATE')) return [[{ id:20, user_id:2, execution_enabled:1 }], []]
      if (sql.includes('FROM users')) return [[PRO], []]
      return [{ affectedRows: 1 }, []]
    })
    db.withTransaction.mockImplementation(fn => fn(txRun))
    await expect(deleteStrategy(2, 2, 'user', {
      confirm_title: PRIVATE.title, confirm_version: 1,
      expected_active_subscriptions: 1, confirm_stop_subscriptions: true,
    })).resolves.toMatchObject({ active_subscription_count: 1 })
    expect(txRun.mock.calls.some(([sql]) => sql.includes("visibility_status = 'archived'"))).toBe(true)
    expect(db.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action:'strategy_deleted', targetId:2 }))
  })

  it('owner can update private strategy and content changes bump the version', async () => {
    await updateStrategy(2, 2, 'user', { title: '新标题' })
    const params = db.queryRun.mock.calls[0][1]
    expect(params).toContain(2)
  })
})

describe('trading account control fields', () => {
  it('ignores user-supplied approval state on create', async () => {
    await createTradingAccount(2, {
      broker_server: 'Demo', login_account: '123', margin_mode: 'hedge',
      review_status: 'approved', observe_status: 'paused',
    })
    const [sql, params] = db.queryRun.mock.calls[0]
    expect(sql).toContain("'approved', 'unverified'")
    expect(sql).toContain("'awaiting_bridge_verification'")
    expect(params).not.toContain('approved')
    expect(params).not.toContain('paused')
    expect(params).toContain('hedging')
  })

  it('rejects owner attempts to edit review or observation state', async () => {
    await expect(updateTradingAccount(10, 2, { review_status: 'approved' }))
      .rejects.toThrow('account_control_fields_read_only')
  })

  it('rejects unknown margin modes', async () => {
    await expect(createTradingAccount(2, { broker_server: 'Demo', login_account: '123', margin_mode: 'magic' }))
      .rejects.toThrow('invalid_margin_mode')
  })

})

describe('subscription transaction and V1 execution constraint', () => {
  it('requires account and strategy ids', async () => {
    await expect(createSubscription(2, 'user', { strategy_id: 2 })).rejects.toThrow('trading_account_id_required')
    await expect(createSubscription(2, 'user', { trading_account_id: 10 })).rejects.toThrow('strategy_id_required')
  })

  it('locks the account and checks active subscriptions on the same runner before insert', async () => {
    await createSubscription(2, 'user', { trading_account_id: 10, strategy_id: 2, execution_enabled: true })
    const sql = txRun.mock.calls.map(call => call[0])
    expect(sql.some(value => value.includes('FROM trading_accounts') && value.includes('FOR UPDATE'))).toBe(true)
    expect(sql.some(value => value.includes('FROM strategy_subscriptions ss') && value.includes('FOR UPDATE'))).toBe(true)
    expect(sql.findIndex(value => value.startsWith('INSERT'))).toBeGreaterThan(sql.findIndex(value => value.includes('FROM strategy_subscriptions ss')))
    expect(sql.some(value => value.includes('INSERT INTO auto_scheduler'))).toBe(true)
    expect(sql.some(value => value.includes('INSERT INTO user_bridge_settings'))).toBe(true)
  })

  it('does not enable execution for a transferred MT5 account', async () => {
    txRun.mockImplementation(sql => {
      if (sql.includes('FROM trading_accounts')) return [[{ ...ACCOUNT, observe_status:'transferred' }], []]
      return defaultTx(sql)
    })
    await expect(createSubscription(2, 'user', {
      trading_account_id:10, strategy_id:2, execution_enabled:true,
    })).rejects.toThrow('trading_account_not_active')
  })

  it('requires an explicit switch before replacing another active auto-inference subscription', async () => {
    txRun.mockImplementation(sql => {
      if (sql.includes('SELECT id FROM strategy_subscriptions')) return [[{ id: 19 }], []]
      return defaultTx(sql)
    })
    await expect(createSubscription(2, 'user', {
      trading_account_id:10, strategy_id:2, execution_enabled:true,
    })).rejects.toThrow('active_subscription_conflict:19')

    await expect(createSubscription(2, 'user', {
      trading_account_id:10, strategy_id:2, execution_enabled:true, replace_active:true,
    })).resolves.toMatchObject({ id:20 })
    expect(txRun.mock.calls.some(([sql]) => sql.includes('UPDATE strategy_subscriptions SET execution_enabled = 0'))).toBe(true)
  })

  it('persists the normalized subscription schedule', async () => {
    await createSubscription(2, 'user', {
      trading_account_id:10, strategy_id:2, schedule_enabled:true,
      schedule_timezone:'UTC', schedule_weekdays:[1,3,5],
      schedule_windows:[{ start:'09:00', end:'12:00' }], outside_window_behavior:'signals_only',
    })
    const insert = txRun.mock.calls.find(([sql]) => sql.includes('INSERT INTO strategy_subscriptions'))
    expect(insert[1]).toContain('UTC')
    expect(insert[1]).toContain('[1,3,5]')
    expect(insert[1]).toContain('[{"start":"09:00","end":"12:00"}]')
    expect(insert[1]).toContain('signals_only')
  })

  it('persists a validated subscription take-profit mode', async () => {
    await createSubscription(2, 'user', {
      trading_account_id:10, strategy_id:2, take_profit_mode:'trend',
    })
    const insert = txRun.mock.calls.find(([sql]) => sql.includes('INSERT INTO strategy_subscriptions'))
    expect(insert[1]).toContain('trend')
    await expect(createSubscription(2, 'user', {
      trading_account_id:10, strategy_id:2, take_profit_mode:'unknown',
    })).rejects.toThrow('invalid_take_profit_mode')
  })

  it('treats broker suffix variants as the same standard symbol', async () => {
    txRun.mockImplementation(sql => {
      if (sql.includes('FROM strategy_subscriptions ss')) {
        return [[{ id: 99, symbols_json: '["XAUUSD.a"]', strategy_symbols_json: '["XAUUSD"]' }], []]
      }
      return defaultTx(sql)
    })
    await expect(createSubscription(2, 'user', {
      trading_account_id: 10, strategy_id: 2, symbols: ['XAUUSD'], execution_enabled: true,
    })).rejects.toThrow('execution_conflict')
  })

  it('uses the selected subscription subset instead of the whole strategy symbol set', async () => {
    txRun.mockImplementation(sql => {
      if (sql.includes('FROM strategy_subscriptions ss')) {
        return [[{ id: 99, symbols_json: '["EURUSD"]', strategy_symbols_json: '["XAUUSD","EURUSD"]' }], []]
      }
      return defaultTx(sql)
    })
    await expect(createSubscription(2, 'user', {
      trading_account_id: 10, strategy_id: 2, symbols: ['XAUUSD'], execution_enabled: true,
    })).resolves.toMatchObject({ id: 20 })
  })

  it('rechecks conflicts when an already-enabled subscription changes its symbol set', async () => {
    db.queryOne.mockImplementation(sql => {
      if (sql.includes('SELECT trading_account_id')) return { trading_account_id: 10 }
      if (sql.includes('FROM strategy_subscriptions')) return { ...SUB, execution_enabled: 1, symbols_json: '["EURUSD"]' }
      return defaultQueryOne(sql)
    })
    txRun.mockImplementation(sql => {
      if (sql.includes('SELECT * FROM strategy_subscriptions')) return [[{ ...SUB, execution_enabled: 1, symbols_json: '["EURUSD"]' }], []]
      if (sql.includes('FROM strategy_subscriptions ss')) {
        return [[{ id: 99, symbols_json: '["XAUUSD"]', strategy_symbols_json: '["XAUUSD"]' }], []]
      }
      return defaultTx(sql)
    })
    await expect(updateSubscription(20, 2, 'user', { symbols: ['XAUUSD'] })).rejects.toThrow('execution_conflict')
  })

  it('rejects a private strategy that does not belong to the subscribing user', async () => {
    txRun.mockImplementation(sql => {
      if (sql.includes('FROM auto_prompt_types')) return [[{ ...PRIVATE, owner_user_id: 9 }], []]
      return defaultTx(sql)
    })
    await expect(createSubscription(2, 'user', { trading_account_id: 10, strategy_id: 2 }))
      .rejects.toThrow('strategy_not_selectable')
  })

  it('keeps platform strategy memory admin-managed and never creates a private copy', async () => {
    txRun.mockImplementation(sql => {
      if (sql.includes('FROM auto_prompt_types')) return [[PLATFORM], []]
      return defaultTx(sql)
    })
    await expect(createSubscription(2, 'user', { trading_account_id: 10, strategy_id: 1, memory_mode: 'personal' }))
      .rejects.toThrow('platform_strategy_memory_managed_by_admin')
    await createSubscription(2, 'user', { trading_account_id: 10, strategy_id: 1, memory_mode: 'platform_only', execution_enabled: true })
    const calls = txRun.mock.calls
    expect(calls.some(([sql]) => sql.startsWith('INSERT INTO auto_prompt_types'))).toBe(false)
    const subscriptionInsert = calls.find(([sql]) => sql.includes('INSERT INTO strategy_subscriptions'))
    expect(subscriptionInsert[1]).toContain('platform_only')
    const schedulerWrite = calls.find(([sql]) => sql.includes('INSERT INTO auto_scheduler'))
    expect(schedulerWrite[1]).toContain(1)
  })

  it('soft-deletes only the owner subscription and detects missing rows', async () => {
    await expect(deleteSubscription(20, 2)).resolves.toBeUndefined()
    expect(txRun.mock.calls.some(([sql]) => sql.includes('UPDATE auto_scheduler SET enabled = 0'))).toBe(true)
    txRun.mockImplementation(sql => {
      if (sql.includes('SELECT * FROM strategy_subscriptions WHERE id = ?')) return [[], []]
      return defaultTx(sql)
    })
    await expect(deleteSubscription(20, 2)).rejects.toThrow('subscription_not_found')
  })
})

describe('admin read-only views', () => {
  it('requires an explicit admin actor', async () => {
    await expect(adminListUserStrategies(2, 'user', 9)).rejects.toThrow('admin_required')
    await expect(adminListUserSubscriptions(2, 'user', 9)).rejects.toThrow('admin_required')
  })

  it('admin can inspect a target user strategies and subscriptions', async () => {
    db.queryAll.mockResolvedValue([PRIVATE])
    await expect(adminListUserStrategies(1, 'admin', 2)).resolves.toHaveLength(1)
    db.queryAll.mockResolvedValue([SUB])
    await expect(adminListUserSubscriptions(1, 'admin', 2)).resolves.toHaveLength(1)
  })

  it('subscription context exposes model id but never credential material', async () => {
    db.queryOne.mockResolvedValue({ ...SUB, strategy_model_profile_id: 8 })
    const row = await getSubscriptionWithContext(20, 2, 'user')
    expect(row.strategy_model_profile_id).toBe(8)
    expect(row.api_key).toBeUndefined()
    expect(row.api_key_encrypted).toBeUndefined()
  })
})
