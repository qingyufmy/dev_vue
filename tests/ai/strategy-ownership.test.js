import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies
vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(() => []),
  queryRun: vi.fn(() => ({ insertId: 1, changes: 1 })),
  withTransaction: vi.fn(async (fn) => fn((sql, params) => Promise.resolve([{ affectedRows: 1 }]))),
  beijingNow: vi.fn(() => '2026-07-15 12:00:00'),
}))

vi.mock('../../server/routes/ai/config.js', () => ({
  parsePromptSymbols: vi.fn((json) => {
    try { return JSON.parse(json || '[]') } catch { return [] }
  }),
}))

vi.mock('../../server/routes/ai/model-profiles.js', () => ({
  getModelProfileById: vi.fn(),
}))

import * as db from '../../server/db.js'
import * as modelProfiles from '../../server/routes/ai/model-profiles.js'
import {
  listStrategies, getStrategyById, createStrategy, updateStrategy, deleteStrategy,
  listTradingAccounts, getTradingAccountById, createTradingAccount, updateTradingAccount, deleteTradingAccount,
  listSubscriptions, createSubscription, updateSubscription, deleteSubscription,
  adminListUserStrategies, adminListUserSubscriptions, getSubscriptionWithContext,
} from '../../server/routes/ai/strategy-ownership.js'

beforeEach(() => {
  vi.clearAllMocks()
})

// === Helper data ===
const ADMIN_USER = { id: 1, role: 'admin', plan: 'pro' }
const PRO_USER = { id: 2, role: 'user', plan: 'pro', plan_expires_at: '2027-12-31' }
const FREE_USER = { id: 3, role: 'user', plan: 'free' }
const OTHER_USER = { id: 4, role: 'user', plan: 'pro', plan_expires_at: '2027-12-31' }

const PLATFORM_STRATEGY = {
  id: 1, title: '平台策略', scope: 'platform', owner_user_id: 0, is_active: 1,
  symbols_json: '["XAUUSD","EURUSD"]', system_prompt: 'test prompt',
  model_profile_id: null, inference_mode: 'platform_model', visibility_status: 'active',
  version: 1, deleted_at: null, owner_nickname: null,
}
const PRIVATE_STRATEGY = {
  id: 2, title: '私有策略', scope: 'private', owner_user_id: 2, is_active: 1,
  symbols_json: '["XAUUSD"]', system_prompt: 'private prompt',
  model_profile_id: 5, inference_mode: 'owner_model', visibility_status: 'active',
  version: 1, deleted_at: null, owner_nickname: 'Demo',
}
const TRADING_ACCOUNT = {
  id: 1, user_id: 2, broker_server: 'MetaQuotes-Demo', login_account: '12345',
  nickname: '测试账户', margin_mode: 'netting', review_status: 'approved',
  observe_status: 'active', is_deleted: 0,
}
const SUBSCRIPTION = {
  id: 1, user_id: 2, trading_account_id: 1, strategy_id: 2,
  risk_profile_id: null, symbols_json: null, execution_enabled: 0,
  memory_mode: 'shared', conflicting_strategy_id: null, is_deleted: 0,
}

// === Strategy List ===

describe('listStrategies', () => {
  it('admin sees both platform and own private strategies', async () => {
    db.queryAll.mockResolvedValue([PLATFORM_STRATEGY, PRIVATE_STRATEGY])
    const result = await listStrategies(1, 'admin')
    expect(result).toHaveLength(2)
  })

  it('pro user sees platform strategies and own private strategies', async () => {
    db.queryAll.mockResolvedValue([PLATFORM_STRATEGY])
    const result = await listStrategies(2, 'user')
    expect(result).toHaveLength(1)
  })

  it('filters by scope when specified', async () => {
    db.queryAll.mockResolvedValue([PLATFORM_STRATEGY])
    await listStrategies(2, 'user', { scope: 'platform' })
    const sql = db.queryAll.mock.calls[0][0]
    expect(sql).toContain("apt.scope = 'platform'")
  })
})

// === Strategy Get ===

describe('getStrategyById', () => {
  it('returns platform strategy to any pro user', async () => {
    db.queryOne.mockResolvedValue(PLATFORM_STRATEGY)
    const result = await getStrategyById(1, 2, 'user')
    expect(result).toEqual(PLATFORM_STRATEGY)
  })

  it('returns private strategy to owner', async () => {
    db.queryOne.mockResolvedValue(PRIVATE_STRATEGY)
    const result = await getStrategyById(2, 2, 'user')
    expect(result).toEqual(PRIVATE_STRATEGY)
  })

  it('returns private strategy to admin', async () => {
    db.queryOne.mockResolvedValue(PRIVATE_STRATEGY)
    const result = await getStrategyById(2, 1, 'admin')
    expect(result).toEqual(PRIVATE_STRATEGY)
  })

  it('hides private strategy from non-owner non-admin', async () => {
    db.queryOne.mockResolvedValue(PRIVATE_STRATEGY)
    const result = await getStrategyById(2, 4, 'user')
    expect(result).toBeNull()
  })

  it('returns null for non-existent strategy', async () => {
    db.queryOne.mockResolvedValue(null)
    const result = await getStrategyById(999, 2, 'user')
    expect(result).toBeNull()
  })
})

// === Strategy Create ===

describe('createStrategy', () => {
  beforeEach(() => {
    db.queryRun.mockResolvedValue({ insertId: 10, changes: 1 })
    modelProfiles.getModelProfileById.mockResolvedValue(null)
  })

  it('pro user creates private strategy', async () => {
    db.queryOne
      .mockResolvedValueOnce(PRO_USER) // user lookup
      .mockResolvedValue({ id: 10, ...PRIVATE_STRATEGY, owner_user_id: 2 })
    const result = await createStrategy(2, 'user', {
      title: '新策略', symbols: ['XAUUSD'], scope: 'private',
    })
    expect(result).toBeTruthy()
    const sql = db.queryRun.mock.calls[0][0]
    expect(sql).toContain('INSERT INTO auto_prompt_types')
  })

  it('admin creates platform strategy', async () => {
    db.queryOne.mockResolvedValue({ id: 10, ...PLATFORM_STRATEGY })
    const result = await createStrategy(1, 'admin', {
      title: '平台策略', symbols: ['XAUUSD'], scope: 'platform',
    })
    expect(result).toBeTruthy()
  })

  it('non-admin cannot create platform strategy', async () => {
    await expect(createStrategy(2, 'user', {
      title: '平台策略', symbols: ['XAUUSD'], scope: 'platform',
    })).rejects.toThrow('platform_requires_admin')
  })

  it('free user cannot create private strategy', async () => {
    db.queryOne.mockResolvedValueOnce(FREE_USER)
    await expect(createStrategy(3, 'user', {
      title: '策略', symbols: ['XAUUSD'], scope: 'private',
    })).rejects.toThrow('private_requires_pro')
  })

  it('throws on empty symbols', async () => {
    db.queryOne.mockResolvedValueOnce(PRO_USER)
    await expect(createStrategy(2, 'user', {
      title: '策略', symbols: [], scope: 'private',
    })).rejects.toThrow('symbols_required')
  })

  it('validates model_profile_id ownership', async () => {
    db.queryOne.mockResolvedValueOnce(PRO_USER)
    modelProfiles.getModelProfileById.mockResolvedValue({
      id: 5, owner_user_id: 4, scope: 'user',
    })
    await expect(createStrategy(2, 'user', {
      title: '策略', symbols: ['XAUUSD'], scope: 'private', model_profile_id: 5,
    })).rejects.toThrow('model_profile_access_denied')
  })

  it('allows model_profile_id if belongs to creator', async () => {
    db.queryOne
      .mockResolvedValueOnce(PRO_USER)
      .mockResolvedValue({ id: 10, ...PRIVATE_STRATEGY, model_profile_id: 5 })
    modelProfiles.getModelProfileById.mockResolvedValue({
      id: 5, owner_user_id: 2, scope: 'user',
    })
    const result = await createStrategy(2, 'user', {
      title: '策略', symbols: ['XAUUSD'], scope: 'private', model_profile_id: 5,
    })
    expect(result).toBeTruthy()
  })
})

// === Strategy Update ===

describe('updateStrategy', () => {
  beforeEach(() => {
    db.queryOne.mockResolvedValue(PRIVATE_STRATEGY)
    db.queryRun.mockResolvedValue({ changes: 1 })
  })

  it('owner can update their strategy', async () => {
    db.queryOne
      .mockResolvedValueOnce(PRIVATE_STRATEGY)
      .mockResolvedValueOnce({ ...PRIVATE_STRATEGY, title: '更新后' })
    const result = await updateStrategy(2, 2, 'user', { title: '更新后' })
    expect(result).toBeTruthy()
  })

  it('admin can update any strategy', async () => {
    db.queryOne
      .mockResolvedValueOnce(PRIVATE_STRATEGY)
      .mockResolvedValueOnce({ ...PRIVATE_STRATEGY })
    const result = await updateStrategy(2, 1, 'admin', { title: '管理员更新' })
    expect(result).toBeTruthy()
  })

  it('non-owner non-admin cannot update', async () => {
    await expect(updateStrategy(2, 4, 'user', { title: '未授权' }))
      .rejects.toThrow('access_denied')
  })

  it('bumps version on content change', async () => {
    db.queryOne
      .mockResolvedValueOnce(PRIVATE_STRATEGY)
      .mockResolvedValueOnce({ ...PRIVATE_STRATEGY, version: 2 })
    await updateStrategy(2, 2, 'user', { system_prompt: 'new prompt' })
    const params = db.queryRun.mock.calls[0][1]
    expect(params).toContain(2) // version bumped
  })

  it('does not bump version on metadata-only change', async () => {
    db.queryOne
      .mockResolvedValueOnce(PRIVATE_STRATEGY)
      .mockResolvedValueOnce({ ...PRIVATE_STRATEGY })
    await updateStrategy(2, 2, 'user', { sort_order: 5 })
    const params = db.queryRun.mock.calls[0][1]
    expect(params).toContain(1) // version unchanged
  })
})

// === Strategy Delete ===

describe('deleteStrategy', () => {
  it('owner can soft-delete their strategy', async () => {
    db.queryOne.mockResolvedValue(PRIVATE_STRATEGY)
    db.queryRun.mockResolvedValue({ changes: 1 })
    await deleteStrategy(2, 2, 'user')
    expect(db.queryRun).toHaveBeenCalled()
  })

  it('non-owner non-admin cannot delete', async () => {
    db.queryOne.mockResolvedValue(PRIVATE_STRATEGY)
    await expect(deleteStrategy(2, 4, 'user')).rejects.toThrow('access_denied')
  })
})

// === Trading Accounts ===

describe('listTradingAccounts', () => {
  it('lists user accounts', async () => {
    db.queryAll.mockResolvedValue([TRADING_ACCOUNT])
    const result = await listTradingAccounts(2)
    expect(result).toHaveLength(1)
  })
})

describe('createTradingAccount', () => {
  beforeEach(() => {
    db.queryRun.mockResolvedValue({ insertId: 1, changes: 1 })
    db.queryOne.mockResolvedValue(TRADING_ACCOUNT)
  })

  it('creates account with required fields', async () => {
    const result = await createTradingAccount(2, {
      broker_server: 'MetaQuotes-Demo', login_account: '12345',
    })
    expect(result).toBeTruthy()
  })

  it('throws on missing broker_server', async () => {
    await expect(createTradingAccount(2, { login_account: '12345' }))
      .rejects.toThrow('broker_server_required')
  })

  it('throws on missing login_account', async () => {
    await expect(createTradingAccount(2, { broker_server: 'MetaQuotes-Demo' }))
      .rejects.toThrow('login_account_required')
  })
})

describe('deleteTradingAccount', () => {
  it('soft-deletes account and subscriptions', async () => {
    db.queryOne.mockResolvedValue(TRADING_ACCOUNT)
    db.queryRun.mockResolvedValue({ changes: 1 })
    await deleteTradingAccount(1, 2)
    expect(db.withTransaction).toHaveBeenCalled()
  })

  it('throws for non-existent account', async () => {
    db.queryOne.mockResolvedValue(null)
    await expect(deleteTradingAccount(999, 2)).rejects.toThrow('account_not_found')
  })
})

// === Subscriptions ===

describe('listSubscriptions', () => {
  it('lists user subscriptions with strategy and account info', async () => {
    db.queryAll.mockResolvedValue([{
      ...SUBSCRIPTION, strategy_title: '私有策略', strategy_scope: 'private',
      broker_server: 'MetaQuotes-Demo', login_account: '12345', account_nickname: '测试账户',
    }])
    const result = await listSubscriptions(2, 'user')
    expect(result).toHaveLength(1)
  })

  it('admin can list other user subscriptions', async () => {
    db.queryAll.mockResolvedValue([])
    const result = await listSubscriptions(1, 'admin', { targetUserId: 2 })
    expect(result).toHaveLength(0)
  })

  it('non-admin cannot list other user subscriptions', async () => {
    await expect(listSubscriptions(4, 'user', { targetUserId: 2 }))
      .rejects.toThrow('access_denied')
  })
})

describe('createSubscription', () => {
  beforeEach(() => {
    db.queryRun.mockResolvedValue({ insertId: 1, changes: 1 })
  })

  it('creates subscription with valid account and strategy', async () => {
    db.queryOne
      .mockResolvedValueOnce(TRADING_ACCOUNT)
      .mockResolvedValueOnce(PRIVATE_STRATEGY)
    db.queryAll.mockResolvedValue([])
    db.queryOne.mockResolvedValue(SUBSCRIPTION)
    const result = await createSubscription(2, 'user', {
      trading_account_id: 1, strategy_id: 2,
    })
    expect(result).toBeTruthy()
  })

  it('throws on missing trading_account_id', async () => {
    await expect(createSubscription(2, 'user', { strategy_id: 2 }))
      .rejects.toThrow('trading_account_id_required')
  })

  it('throws on missing strategy_id', async () => {
    await expect(createSubscription(2, 'user', { trading_account_id: 1 }))
      .rejects.toThrow('strategy_id_required')
  })

  it('throws when account not found', async () => {
    db.queryOne.mockResolvedValueOnce(null)
    await expect(createSubscription(2, 'user', {
      trading_account_id: 999, strategy_id: 2,
    })).rejects.toThrow('account_not_found')
  })

  it('validates symbols against strategy', async () => {
    db.queryOne
      .mockResolvedValueOnce(TRADING_ACCOUNT)
      .mockResolvedValueOnce(PRIVATE_STRATEGY)
    await expect(createSubscription(2, 'user', {
      trading_account_id: 1, strategy_id: 2, symbols: ['BTCUSD'],
    })).rejects.toThrow('symbols_not_in_strategy')
  })
})

describe('V1 execution constraint', () => {
  it('allows enabling execution when no conflict', async () => {
    db.queryOne
      .mockResolvedValueOnce(TRADING_ACCOUNT)
      .mockResolvedValueOnce(PRIVATE_STRATEGY)
      .mockResolvedValueOnce({ symbols_json: '["XAUUSD"]' })
    db.queryAll.mockResolvedValue([])
    db.queryRun.mockResolvedValue({ insertId: 1, changes: 1 })
    db.queryOne.mockResolvedValue({ ...SUBSCRIPTION, execution_enabled: 1 })

    const result = await createSubscription(2, 'user', {
      trading_account_id: 1, strategy_id: 2, execution_enabled: true,
    })
    expect(result).toBeTruthy()
  })

  it('rejects enabling execution when overlapping symbols exist', async () => {
    db.queryOne
      .mockResolvedValueOnce(TRADING_ACCOUNT)
      .mockResolvedValueOnce(PRIVATE_STRATEGY)
      .mockResolvedValueOnce({ symbols_json: '["XAUUSD"]' })
    db.queryAll.mockResolvedValue([{
      id: 99, trading_account_id: 1, strategy_id: 3,
      execution_enabled: 1, existing_symbols_json: '["XAUUSD"]',
    }])

    await expect(createSubscription(2, 'user', {
      trading_account_id: 1, strategy_id: 2, execution_enabled: true,
    })).rejects.toThrow('execution_conflict')
  })
})

describe('updateSubscription', () => {
  it('owner can update their subscription', async () => {
    db.queryOne.mockResolvedValueOnce(SUBSCRIPTION)
    db.queryAll.mockResolvedValue([])
    db.queryRun.mockResolvedValue({ changes: 1 })
    db.queryOne.mockResolvedValue({ ...SUBSCRIPTION, memory_mode: 'isolated' })
    const result = await updateSubscription(1, 2, 'user', { memory_mode: 'isolated' })
    expect(result).toBeTruthy()
  })

  it('validates execution conflict on enable', async () => {
    db.queryOne.mockResolvedValueOnce({ ...SUBSCRIPTION, execution_enabled: 0 })
    db.queryOne.mockResolvedValueOnce({ symbols_json: '["XAUUSD"]' })
    db.queryAll.mockResolvedValue([{
      id: 99, trading_account_id: 1, strategy_id: 3,
      execution_enabled: 1, existing_symbols_json: '["XAUUSD"]',
    }])
    await expect(updateSubscription(1, 2, 'user', { execution_enabled: true }))
      .rejects.toThrow('execution_conflict')
  })
})

describe('deleteSubscription', () => {
  it('owner can soft-delete their subscription', async () => {
    db.queryOne.mockResolvedValue(SUBSCRIPTION)
    db.queryRun.mockResolvedValue({ changes: 1 })
    await deleteSubscription(1, 2)
    const sql = db.queryRun.mock.calls[0][0]
    expect(sql).toContain('is_deleted = 1')
  })

  it('throws for non-existent subscription', async () => {
    db.queryOne.mockResolvedValue(null)
    await expect(deleteSubscription(999, 2)).rejects.toThrow('subscription_not_found')
  })
})

// === Admin Read-Only ===

describe('adminListUserStrategies', () => {
  it('returns strategies for a user', async () => {
    db.queryAll.mockResolvedValue([PRIVATE_STRATEGY])
    const result = await adminListUserStrategies(2)
    expect(result).toHaveLength(1)
  })
})

describe('adminListUserSubscriptions', () => {
  it('returns subscriptions for a user', async () => {
    db.queryAll.mockResolvedValue([SUBSCRIPTION])
    const result = await adminListUserSubscriptions(2)
    expect(result).toHaveLength(1)
  })
})

describe('getSubscriptionWithContext', () => {
  it('returns subscription with full context to owner', async () => {
    db.queryOne.mockResolvedValue({
      ...SUBSCRIPTION, strategy_title: '私有策略', strategy_scope: 'private',
      system_prompt: 'test', strategy_symbols_json: '["XAUUSD"]',
      broker_server: 'MetaQuotes-Demo', login_account: '12345',
    })
    const result = await getSubscriptionWithContext(1, 2, 'user')
    expect(result).toBeTruthy()
  })

  it('returns subscription with full context to admin', async () => {
    db.queryOne.mockResolvedValue({
      ...SUBSCRIPTION, user_id: 2, strategy_title: '私有策略',
    })
    const result = await getSubscriptionWithContext(1, 1, 'admin')
    expect(result).toBeTruthy()
  })

  it('hides subscription from non-owner non-admin', async () => {
    db.queryOne.mockResolvedValue({
      ...SUBSCRIPTION, user_id: 2,
    })
    const result = await getSubscriptionWithContext(1, 4, 'user')
    expect(result).toBeNull()
  })
})

// === Permission Edge Cases ===

describe('permission edge cases', () => {
  it('admin model_profile_id bypasses owner check', async () => {
    db.queryRun.mockResolvedValue({ insertId: 10, changes: 1 })
    db.queryOne.mockResolvedValue({ id: 10, ...PLATFORM_STRATEGY })
    modelProfiles.getModelProfileById.mockResolvedValue({
      id: 5, owner_user_id: 4, scope: 'user',
    })
    const result = await createStrategy(1, 'admin', {
      title: '平台策略', symbols: ['XAUUSD'], scope: 'platform', model_profile_id: 5,
    })
    expect(result).toBeTruthy()
  })

  it('private strategy with inference_mode user_default works', async () => {
    db.queryOne
      .mockResolvedValueOnce(PRO_USER)
      .mockResolvedValue({ id: 10, ...PRIVATE_STRATEGY, inference_mode: 'user_default' })
    db.queryRun.mockResolvedValue({ insertId: 10, changes: 1 })
    const result = await createStrategy(2, 'user', {
      title: '用户默认策略', symbols: ['XAUUSD'], scope: 'private', inference_mode: 'user_default',
    })
    expect(result).toBeTruthy()
  })
})
