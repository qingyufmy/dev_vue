import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueryAll = vi.fn()
const mockQueryOne = vi.fn()
const mockQueryRun = vi.fn(async () => ({ changes: 1 }))
const mockExecuteOrderCore = vi.fn()
let transactionSourceStatus = null
const mockTxRun = vi.fn(async (sql, params = []) => {
  if (sql.includes('SELECT * FROM admin_strategy_trade_targets WHERE id')) {
    const isSubscriber = Number(params[0]) === 2
    return [[isSubscriber
      ? { id: 2, dispatch_id: 5, status: 'pending', target_role: 'subscriber', user_id: 2, trading_account_id: 10, subscription_id: 20, lease_token: null, attempt_count: 0, target_snapshot_json: JSON.stringify({ bridge_generation: 5, broker: { server: 'DEMO', login: '2' }, subscription: { symbols: ['EURUSD'] }, position_size_factor: 0.25 }) }
      : { id: 1, dispatch_id: 5, status: 'pending', target_role: 'source', user_id: 1, trading_account_id: 9, lease_token: null, attempt_count: 0, target_snapshot_json: JSON.stringify({ bridge_generation: 5, broker: { server: 'DEMO', login: '1' }, position_size_factor: 0.25 }) }], []]
  }
  if (sql.includes('SELECT status FROM admin_strategy_trade_targets')) return [[{ status: transactionSourceStatus }], []]
  return [{ affectedRows: 1 }, []]
})
const mockWithTransaction = vi.fn(async callback => callback(mockTxRun))
const mockClaimDispatch = vi.fn(async () => ({ token: 'dispatch-lease' }))
const mockFence = vi.fn(async () => ({}))
const mockBridge = vi.fn(async () => ({ status: 'success', account: { server: 'DEMO', login: '1' }, positions: [] }))

vi.mock('../server/db.js', () => ({
  beijingNow: () => '2026-08-14 12:00:00', beijingAfter: () => '2026-08-14 12:02:00', queryAll: (...args) => mockQueryAll(...args),
  queryOne: (...args) => mockQueryOne(...args), queryRun: (...args) => mockQueryRun(...args),
  withTransaction: (...args) => mockWithTransaction(...args),
}))
vi.mock('../server/routes/ai/config.js', () => ({ executeAdminDirectedOrderCore: (...args) => mockExecuteOrderCore(...args) }))
vi.mock('../server/routes/ai/market-data.js', () => ({ mt5Bridge: (...args) => mockBridge(...args) }))
vi.mock('../server/bridge-ws.js', () => ({
  getBridgeGeneration: () => 5, isBridgeAlive: () => true, isTradeEnabled: () => true,
}))
vi.mock('../server/services/account-symbol-inventory-lock.js', () => ({
  acquireAccountSymbolInventoryLock: vi.fn(async () => ({ key: 'delivery_inventory:1:EURUSD', token: 'inventory-lease' })),
  releaseAccountSymbolInventoryLock: vi.fn(async () => true),
}))
vi.mock('../server/services/admin-strategy-trades.js', () => ({
  ADMIN_STRATEGY_TRADE_MAGIC: 234000, ADMIN_STRATEGY_TRADE_SOURCE: 'admin_strategy_dispatch',
  assertAdminStrategyTargetSendFence: (...args) => mockFence(...args),
  claimAdminStrategyTradeDispatch: (...args) => mockClaimDispatch(...args),
  resolveEffectiveSymbolsForDispatch: (selected, strategy) => selected == null ? JSON.parse(strategy || '[]') : JSON.parse(selected || '[]').filter(item => JSON.parse(strategy || '[]').includes(item)),
}))

import { __adminStrategyTradeWorkerTest, processAdminStrategyTradeDispatch, reconcileAdminStrategyTradeTargetsOnce } from '../server/workers/admin-strategy-trade-worker.js'

const dispatch = {
  id: 5, signal_id: 77, actor_user_id: 1, symbol: 'EURUSD', direction: 'buy',
  position_size_tier: 'probe', stop_loss: 1.08, take_profit_1: 1.12,
  valid_until_utc_msc: Date.now() + 60_000, status: 'confirmed', entry_price: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  transactionSourceStatus = null
  mockQueryOne.mockImplementation(async sql => {
    if (sql.includes('admin_strategy_trade_dispatches')) return { ...dispatch }
    if (sql.includes("target_role = 'source'")) return { id: 1, dispatch_id: 5, target_role: 'source', status: 'pending', user_id: 1, trading_account_id: 9, lease_token: null, attempt_count: 0, target_snapshot_json: JSON.stringify({ bridge_generation: 5, broker: { server: 'DEMO', login: '1' }, position_size_factor: 0.25 }) }
    return null
  })
  mockQueryAll.mockImplementation(async sql => {
    if (sql.includes('FROM admin_strategy_trade_targets WHERE dispatch_id')) return [{ target_role: 'source', status: 'uncertain' }, { target_role: 'subscriber', status: 'pending' }]
    return []
  })
})

describe('admin strategy trade worker fences', () => {
  it('sends a new dispatch fixed volume without legacy tier sizing fields', () => {
    const request = __adminStrategyTradeWorkerTest.targetRequest(
      { ...dispatch, requested_volume: '0.37', position_size_tier: 'probe' },
      { id: 1, trading_account_id: 9 },
      { position_size_factor: 0.25 },
    )
    expect(request.volume).toBe(0.37)
    expect(request.client_request_id).toBe('admin-strategy-dispatch:5:target:1')
    expect(request).not.toHaveProperty('position_size_tier')
    expect(request).not.toHaveProperty('position_size_factor')
  })

  it('passes optional protection as null without synthesizing tier or candidate prices', () => {
    const request = __adminStrategyTradeWorkerTest.targetRequest(
      {
        ...dispatch, requested_volume: '0.37', position_size_tier: null,
        stop_loss: null, take_profit_1: null, take_profit_2: null, take_profit_3: null,
      },
      { id: 1, trading_account_id: 9 },
      { position_size_factor: 0.25 },
    )
    expect(request).toMatchObject({
      volume: 0.37, sl: null, tp: null, stop_loss_price: null,
      take_profit_1_price: null, take_profit_2_price: null, take_profit_3_price: null,
      take_profit_candidates: [], magic: 234000, trading_account_id: 9,
    })
    expect(request).not.toHaveProperty('position_size_tier')
    expect(request).not.toHaveProperty('position_size_factor')
  })

  it('keeps tier fallback only for legacy rows without requested_volume', () => {
    const request = __adminStrategyTradeWorkerTest.targetRequest(
      { ...dispatch, requested_volume: null },
      { id: 1, trading_account_id: 9 },
      { position_size_factor: 0.25 },
    )
    expect(request.volume).toBe(0)
    expect(request.position_size_tier).toBe('probe')
    expect(request.position_size_factor).toBe(0.25)
  })

  it('does not open subscriber targets when the source execution is uncertain', async () => {
    mockExecuteOrderCore.mockResolvedValue({ status: 'uncertain', order_intent_id: 11 })
    const result = await processAdminStrategyTradeDispatch(5)
    expect(result.source).toBe('uncertain')
    expect(mockExecuteOrderCore).toHaveBeenCalledTimes(1)
    expect(mockExecuteOrderCore.mock.calls[0][3]).toBe('admin_strategy_source')
    expect(mockTxRun.mock.calls.some(([sql]) => String(sql).includes("error_code = 'source_execution_failed'"))).toBe(false)
  })

  it('atomically skips only unsent subscribers when source execution is definitely failed', async () => {
    transactionSourceStatus = 'failed'
    const source = { id: 1, dispatch_id: 5, target_role: 'source', status: 'pending', user_id: 1, trading_account_id: 9, lease_token: null, attempt_count: 0, target_snapshot_json: JSON.stringify({ bridge_generation: 5, broker: { server: 'DEMO', login: '1' } }) }
    const subscriber = { id: 2, dispatch_id: 5, target_role: 'subscriber', status: 'pending', user_id: 2, trading_account_id: 10, subscription_id: 20, order_intent_id: null, trade_ticket: null, target_snapshot_json: JSON.stringify({ bridge_generation: 5, broker: { server: 'DEMO', login: '2' } }) }
    mockQueryOne.mockImplementation(async sql => {
      if (sql.includes('admin_strategy_trade_dispatches')) return { ...dispatch, status:'confirmed' }
      if (sql.includes("target_role = 'source'")) return source
      return null
    })
    mockQueryAll.mockImplementation(async sql => {
      if (sql.includes("target_role = 'subscriber'")) return [subscriber]
      return [{ target_role:'source', status:'failed' }, { target_role:'subscriber', status:'pending' }]
    })
    mockExecuteOrderCore.mockResolvedValue({ status:'failed', reason:'worker_command_params_invalid', order_intent_id:11 })

    const result = await processAdminStrategyTradeDispatch(5)

    expect(result.source).toBe('failed')
    expect(mockExecuteOrderCore).toHaveBeenCalledTimes(1)
    expect(mockTxRun).toHaveBeenCalledWith(expect.stringContaining("error_code = 'source_execution_failed'"), expect.arrayContaining([5]))
    expect(mockTxRun).toHaveBeenCalledWith(expect.stringContaining('order_intent_id IS NULL AND trade_ticket IS NULL'), expect.any(Array))
  })

  it('keeps a subscriber runtime change before the Bridge fence from invoking directed execution', async () => {
    const source = { id: 1, dispatch_id: 5, target_role: 'source', status: 'succeeded', user_id: 1, trading_account_id: 9, lease_token: null, target_snapshot_json: JSON.stringify({ bridge_generation: 5, broker: { server: 'DEMO', login: '1' }, position_size_factor: 0.25 }) }
    const subscriber = { id: 2, dispatch_id: 5, target_role: 'subscriber', status: 'pending', user_id: 2, trading_account_id: 10, subscription_id: 20, lease_token: null, target_snapshot_json: JSON.stringify({ bridge_generation: 5, broker: { server: 'DEMO', login: '2' }, subscription: { symbols: ['EURUSD'] }, position_size_factor: 0.25 }) }
    mockQueryOne.mockImplementation(async sql => {
      if (sql.includes('admin_strategy_trade_dispatches')) return { ...dispatch, status: 'confirmed' }
      if (sql.includes("target_role = 'source'")) return source
      if (sql.includes('FROM strategy_subscriptions')) return { id: 20, user_id: 2, trading_account_id: 10, symbols_json: '[]', strategy_symbols_json: '["EURUSD"]', execution_enabled: 1, is_deleted: 0, observe_status: 'active', ownership_user_id: 2, ownership_trading_account_id: 10, scheduler_enabled: 1, scheduler_enable_auto_trade: 1, user_role: 'user', plan: 'plus', plan_expires_at: null, halt_status: null, user_kill_switch: 0, schedule_enabled: 0 }
      return null
    })
    mockQueryAll.mockImplementation(async sql => sql.includes("target_role = 'subscriber'") ? [subscriber] : [{ target_role: 'source', status: 'succeeded' }, { target_role: 'subscriber', status: 'skipped' }])
    const result = await processAdminStrategyTradeDispatch(5)
    expect(mockExecuteOrderCore).not.toHaveBeenCalled()
  })

  it('opens subscribers only after a succeeded source intent, unique outcome and system inventory confirmation', async () => {
    let sourceStatus = 'pending'
    let subscriberStatus = 'pending'
    const source = { id: 1, dispatch_id: 5, target_role: 'source', status: 'pending', user_id: 1, trading_account_id: 9, lease_token: null, target_snapshot_json: JSON.stringify({ bridge_generation: 5, broker: { server: 'DEMO', login: '1' }, position_size_factor: 0.25 }) }
    const subscriber = { id: 2, dispatch_id: 5, target_role: 'subscriber', status: 'pending', user_id: 2, trading_account_id: 10, subscription_id: 20, lease_token: null, target_snapshot_json: JSON.stringify({ bridge_generation: 5, broker: { server: 'DEMO', login: '2' }, subscription: { symbols: ['EURUSD'] }, position_size_factor: 0.25 }) }
    mockQueryOne.mockImplementation(async sql => {
      if (sql.includes('admin_strategy_trade_dispatches')) return { ...dispatch, status: 'confirmed' }
      if (sql.includes("target_role = 'source'")) return { ...source, status: sourceStatus }
      if (sql.includes('FROM order_intents')) return { id: 11, status: 'succeeded', trade_ticket: '900', result_json: '{}' }
      if (sql.includes('FROM strategy_subscriptions')) return { id: 20, user_id: 2, trading_account_id: 10, symbols_json: '["EURUSD"]', strategy_symbols_json: '["EURUSD"]', execution_enabled: 1, is_deleted: 0, observe_status: 'active', ownership_user_id: 2, ownership_trading_account_id: 10, broker_server: 'DEMO', login_account: '2', scheduler_enabled: 1, scheduler_enable_auto_trade: 1, trade_send_enabled: 1, user_role: 'user', plan: 'plus', plan_expires_at: null, halt_status: null, user_kill_switch: 0, schedule_enabled: 0 }
      return null
    })
    mockQueryAll.mockImplementation(async sql => {
      if (sql.includes('signal_outcomes')) return [{ signal_id: 77, trading_account_id: 9, symbol: 'EURUSD', system_magic: 234000, position_id: '900', intent_status: 'succeeded' }]
      if (sql.includes("target_role = 'subscriber'")) return [subscriber]
      return [{ target_role: 'source', status: sourceStatus }, { target_role: 'subscriber', status: subscriberStatus }]
    })
    mockExecuteOrderCore.mockImplementation(async (_userId, _config, _request, action, options) => {
      if (action === 'admin_strategy_source') {
        sourceStatus = 'succeeded'
        return { status: 'success', order_intent_id: 11, ticket: '900' }
      }
      subscriberStatus = 'succeeded'
      return { status: 'success', order_intent_id: 12, ticket: '901', source_type: options.sourceType }
    })
    mockBridge.mockResolvedValue({ status: 'success', account: { server: 'DEMO', login: '1' }, positions: [{ ticket: '900', symbol: 'EURUSD', type: 'buy', magic: 234000 }] })
    const result = await processAdminStrategyTradeDispatch(5)
    expect(result.status).toBe('succeeded')
    expect(mockExecuteOrderCore).toHaveBeenCalledTimes(2)
    expect(mockExecuteOrderCore.mock.calls[0][3]).toBe('admin_strategy_source')
    expect(mockExecuteOrderCore.mock.calls[1][3]).toBe('admin_strategy_delivery')
    expect(mockExecuteOrderCore.mock.calls[0][0]).toBe(1)
    expect(mockExecuteOrderCore.mock.calls[0][2]).toMatchObject({
      trading_account_id: 9, magic: 234000,
      client_request_id: 'admin-strategy-dispatch:5:target:1',
    })
    expect(mockExecuteOrderCore.mock.calls[0][4]).toMatchObject({
      tradingAccountId: 9, sourceType: 'admin_strategy_source',
      sourceId: '77:dispatch:5:target:1', magic: 234000,
      clientRequestId: 'admin-strategy-dispatch:5:target:1',
      beforeBridgeSend: expect.any(Function), beforeBridgeSendTx: expect.any(Function),
    })
    expect(mockExecuteOrderCore.mock.calls[1][2]).toMatchObject({
      trading_account_id: 10, magic: 234000,
      client_request_id: 'admin-strategy-dispatch:5:target:2',
    })
    expect(mockExecuteOrderCore.mock.calls[1][4]).toMatchObject({
      tradingAccountId: 10, sourceType: 'admin_strategy_delivery',
      sourceId: '77:dispatch:5:target:2', magic: 234000,
      clientRequestId: 'admin-strategy-dispatch:5:target:2',
      beforeBridgeSend: expect.any(Function), beforeBridgeSendTx: expect.any(Function),
    })
    expect(mockFence).toHaveBeenCalledWith(expect.objectContaining({
      dispatchId: 5, targetId: 1, targetRole: 'source', sourceRequired: false,
    }))
    expect(mockFence).toHaveBeenCalledWith(expect.objectContaining({
      dispatchId: 5, targetId: 2, targetRole: 'subscriber', sourceRequired: true,
    }))
  })

  it('absorbs an uncertain target after the intent reconciles and never re-executes it', async () => {
    const target = { id: 3, dispatch_id: 5, target_role: 'subscriber', user_id: 2, trading_account_id: 10, order_intent_id: 12, status: 'uncertain', target_snapshot_json: JSON.stringify({ broker: { server: 'DEMO', login: '1' } }) }
    mockQueryAll.mockImplementation(async sql => {
      if (sql.includes("status IN ('uncertain','reconciling')")) return [target]
      if (sql.includes('signal_outcomes')) return [{ signal_id: 77, trading_account_id: 10, symbol: 'EURUSD', system_magic: 234000, position_id: '901' }]
      return []
    })
    mockQueryOne.mockImplementation(async sql => {
      if (sql.includes('admin_strategy_trade_dispatches')) return { ...dispatch }
      if (sql.includes('order_intents')) return { id: 12, status: 'succeeded', trade_ticket: '901', result_json: '{}' }
      return null
    })
    mockBridge.mockResolvedValue({ status: 'success', account: { server: 'DEMO', login: '1' }, positions: [{ ticket: '901', symbol: 'EURUSD', type: 'buy', magic: 234000 }] })
    const result = await reconcileAdminStrategyTradeTargetsOnce()
    expect(result.processed).toBe(1)
    expect(result.results[0].status).toBe('succeeded')
    expect(mockExecuteOrderCore).not.toHaveBeenCalled()
    expect(mockQueryRun).toHaveBeenCalledWith(expect.stringContaining("SET status = ?"), expect.arrayContaining(['succeeded']))
  })
})
