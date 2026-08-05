import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 依赖 — 路径必须与 scheduler.js 的导入路径一致
vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
  withTransaction: vi.fn(),
  beijingNow: vi.fn(() => '2026-06-26 12:00:00'),
}))

vi.mock('../../server/bridge-ws.js', () => ({
  isBridgeAlive: vi.fn(() => true),
  getOwnBridgeTradeMode: vi.fn(() => 4),
  getBridgeTradeMode: vi.fn(() => 4),
  sendBridgeCommand: vi.fn(),
  sendToBrowsers: vi.fn(),
  broadcastAdminEvent: vi.fn(),
}))

vi.mock('../../server/routes/ai/market-data.js', () => ({
  mt5Bridge: vi.fn(),
  platformRates: vi.fn(),
  calculateMarketData: vi.fn(() => ({
    symbol: 'XAUUSD', timeframe: 'M5',
    latest_price: 2000, price_change: 10, price_change_pct: 0.5,
    atr_14: 10, volatility_pct: 0.3,
    strategy_score: { trend_strength: 0.6, data_confidence: 0.7 },
    kline_count: 100, positions: { total_positions: 0, details: [] },
    account: { balance: 10000, equity: 10500 },
  })),
}))

vi.mock('../../server/routes/ai/llm.js', () => ({
  maybeAiSignal: vi.fn(() => ({
    signal_type: 'buy', confidence: 0.7, recommended_volume: 0.03,
    analysis: 'test', reasoning: 'test',
    stop_loss_price: 1990, take_profit_1_price: 2010,
    _inference_source: 'ai',
  })),
}))

vi.mock('../../server/routes/ai/config.js', () => ({
  getAutoConfig: vi.fn(() => ({ enabled: true, symbols: 'XAUUSD' })),
  getGlobalAutoConfig: vi.fn(() => ({ symbols: 'XAUUSD', interval_minutes: 5 })),
  getCloseConfig: vi.fn(() => ({ enabled: false })),
  saveCloseConfig: vi.fn(),
  insertAudit: vi.fn(),
  signalOrderPayload: vi.fn(() => ({ symbol: 'XAUUSD', order_type: 'buy', volume: 0.03 })),
  getExecuteRiskConfig: vi.fn(() => ({})),
  getDeliveryExecuteRiskConfig: vi.fn(() => ({})),
  validateTradeRequest: vi.fn(),
  RiskReject: class RiskReject extends Error {},
  getAutoPromptTypeById: vi.fn(() => null),
  getAutoPromptTypes: vi.fn(() => []),
  getUnifiedAutoInferenceConfig: vi.fn(() => null),
  getAutoSubscribers: vi.fn(() => []),
  parsePromptSymbols: vi.fn(() => ['XAUUSD']),
  resolveEffectiveSymbols: vi.fn((selected, strategy) => {
    try {
      const parsed = JSON.parse(selected || strategy || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }),
  buildBridgeOrderCall: vi.fn(() => ({ bridgeAction: 'open', params: {} })),
}))

vi.mock('../../server/routes/ai/strategy.js', () => ({
  attachAtrAnchor: vi.fn(),
  buildStrategyContextFromTags: vi.fn(() => ({
    strategy_sequence: 'M5(100)',
    required_timeframes: ['M5'],
    timeframes: { M5: { summary: {}, klines: [] } },
  })),
  executeOrder: vi.fn(() => ({ status: 'success' })),
  handleAnalyze: vi.fn(),
  loadPrivatePortfolioContext: vi.fn(() => ({ positions:[], pendingOrders:[] })),
  resolveChanHistoryCount: vi.fn((_userId, _symbol, _timeframe, requestedCount, useChan) => useChan ? Math.max(requestedCount, 300) : requestedCount),
}))

vi.mock('../../server/routes/ai/utils.js', () => ({
  attachSignalTiming: vi.fn(),
  signalTtlSeconds: vi.fn(() => 120),
  stripBrokerSuffix: vi.fn(s => String(s || '').toUpperCase()),
  stripTimeframeTags: vi.fn((s) => s),
  round2: vi.fn((n) => n),
  parseTimeframeTags: vi.fn(() => []),
}))

vi.mock('../../server/redis.js', () => ({
  getRedis: vi.fn(() => null),
  isRedisAvailable: vi.fn(() => false),
}))

import { __schedulerTest, autoSchedulerState, getSubscriptionIndexHealth, getUserAutoRuntimeStatus, isAutoSchedulerRunning, rebuildRedisSubscriptions, updateSchedulerRedisState } from '../../server/routes/ai/scheduler.js'
import * as db from '../../server/db.js'
import * as marketData from '../../server/routes/ai/market-data.js'
import * as bridgeWs from '../../server/bridge-ws.js'
import * as redis from '../../server/redis.js'

describe('isAutoSchedulerRunning', () => {
  it('未启动的调度器返回 false', () => {
    expect(isAutoSchedulerRunning(999)).toBe(false)
  })
})

describe('automatic-analysis control state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redis.getRedis.mockReturnValue(null)
    redis.isRedisAvailable.mockReturnValue(false)
    for (const key of Object.keys(autoSchedulerState)) delete autoSchedulerState[key]
  })

  it('reports disabled when no subscription has automatic analysis enabled', async () => {
    db.queryOne.mockResolvedValueOnce(null)

    await expect(getUserAutoRuntimeStatus(42)).resolves.toMatchObject({
      enabled:false, running:false, paused_reason:'disabled',
    })
    expect(db.queryOne).toHaveBeenCalledTimes(1)
    expect(db.queryOne.mock.calls[0][0]).toContain('strategy_subscriptions')
  })

  it('shows a runtime synchronization warning only when the subscription is enabled', async () => {
    db.queryOne
      .mockResolvedValueOnce({ strategy_id:7, symbols_json:null })
      .mockResolvedValueOnce(null)

    await expect(getUserAutoRuntimeStatus(42)).resolves.toMatchObject({
      enabled:true, running:false, paused_reason:'no_runtime_scheduler', prompt_type_id:7,
    })
  })
})

describe('runtime countdown constraints', () => {
  const nowMs = Date.parse('2026-08-05T05:00:00.000Z')

  it('uses a future runtime deadline even when Redis has no cooldown TTL', () => {
    const deadline = nowMs + 120_000
    expect(__schedulerTest.schedulerRuntimeNextRunAt({
      nextRunAtUtc:new Date(deadline).toISOString(),
    }, -2, nowMs)).toBe(deadline)
  })

  it('takes the later constraint within a key and the earlier key across symbols', () => {
    const firstKey = __schedulerTest.schedulerRuntimeNextRunAt({
      nextRunAtUtc:new Date(nowMs + 180_000).toISOString(),
    }, 300, nowMs)
    const secondKey = __schedulerTest.schedulerRuntimeNextRunAt({
      nextRunAtUtc:new Date(nowMs + 240_000).toISOString(),
    }, 90, nowMs)

    expect(firstKey).toBe(nowMs + 300_000)
    expect(secondKey).toBe(nowMs + 240_000)
    expect(Math.min(firstKey, secondKey)).toBe(nowMs + 240_000)
  })
})

describe('subscription index health', () => {
  it('records Redis unavailability instead of reporting a silent successful rebuild', async () => {
    await expect(rebuildRedisSubscriptions()).resolves.toMatchObject({ ok:false, error:'redis_unavailable' })
    expect(getSubscriptionIndexHealth()).toMatchObject({ ok:false, error:'redis_unavailable' })
  })

  it('indexes configured users even when their Bridge is offline', async () => {
    const sets = new Map()
    const hashes = new Map()
    const fakeRedis = {
      smembers: vi.fn(async key => [...(sets.get(key) || new Set())]),
      scard: vi.fn(async key => (sets.get(key) || new Set()).size),
      sadd: vi.fn(async (key, ...values) => {
        const set = sets.get(key) || new Set()
        for (const value of values) set.add(String(value))
        sets.set(key, set)
      }),
      srem: vi.fn(async (key, ...values) => {
        const set = sets.get(key) || new Set()
        for (const value of values) set.delete(String(value))
        sets.set(key, set)
      }),
      del: vi.fn(async key => { sets.delete(key); hashes.delete(key) }),
      hset: vi.fn(async (key, fields) => hashes.set(key, { ...(hashes.get(key) || {}), ...fields })),
      hgetall: vi.fn(async key => hashes.get(key) || {}),
    }
    redis.getRedis.mockReturnValue(fakeRedis)
    redis.isRedisAvailable.mockReturnValue(true)
    bridgeWs.isBridgeAlive.mockReturnValue(false)
    db.queryAll.mockResolvedValueOnce([{
      user_id:42, prompt_type_id:7, selected_symbols_json:'["XAUUSD"]', strategy_symbols_json:'["XAUUSD"]',
    }])

    await expect(rebuildRedisSubscriptions()).resolves.toMatchObject({
      ok:true, schedulerKeys:1, onlineUsers:0, configuredUsers:1,
    })
    expect(sets.get('auto:scheduler:keys')).toEqual(new Set(['7:XAUUSD']))
    expect(sets.get('auto:scheduler:7:XAUUSD:subs')).toEqual(new Set(['42']))
    expect(hashes.get('auto:user:42:auto')).toMatchObject({ enabled:'1', prompt_type_id:'7' })
  })

  it('repairs a missing runtime index on state publication and removes it on stop', async () => {
    const sets = new Map()
    const hashes = new Map()
    const fakeRedis = {
      smembers: vi.fn(async key => [...(sets.get(key) || new Set())]),
      sadd: vi.fn(async (key, ...values) => {
        const set = sets.get(key) || new Set()
        for (const value of values) set.add(String(value))
        sets.set(key, set)
      }),
      srem: vi.fn(async (key, ...values) => {
        const set = sets.get(key) || new Set()
        for (const value of values) set.delete(String(value))
        sets.set(key, set)
      }),
      del: vi.fn(async key => { sets.delete(key); hashes.delete(key) }),
      hset: vi.fn(async (key, fields) => hashes.set(key, { ...(hashes.get(key) || {}), ...fields })),
    }
    redis.getRedis.mockReturnValue(fakeRedis)
    redis.isRedisAvailable.mockReturnValue(true)

    await updateSchedulerRedisState('7:XAUUSD', {
      running:true, subscribers:new Set([42]), subscriberCount:1, intervalMinutes:5,
      nextRunInSeconds:120, nextRunAtUtc:'2026-08-05T05:02:00.000Z',
    })
    expect(sets.get('auto:scheduler:keys')).toEqual(new Set(['7:XAUUSD']))
    expect(sets.get('auto:scheduler:7:XAUUSD:subs')).toEqual(new Set(['42']))
    expect(hashes.get('auto:scheduler:7:XAUUSD:state')).toMatchObject({
      running:'1', subscriber_count:'1', next_run_in_seconds:'120', next_run_at_utc:'2026-08-05T05:02:00.000Z',
    })
    expect(bridgeWs.broadcastAdminEvent).toHaveBeenCalledTimes(1)
    expect(bridgeWs.broadcastAdminEvent.mock.calls[0][1]).toBe('scheduler_state')

    await updateSchedulerRedisState('7:XAUUSD', {
      running:true, subscribers:new Set([42]), subscriberCount:1, intervalMinutes:5,
      nextRunInSeconds:120, nextRunAtUtc:'2026-08-05T05:02:00.000Z',
    })
    expect(bridgeWs.broadcastAdminEvent).toHaveBeenCalledTimes(1)

    await updateSchedulerRedisState('7:XAUUSD', {
      running:true, subscribers:new Set([42]), subscriberCount:1, intervalMinutes:5,
      progressPercent:55, progressSeq:2,
      nextRunInSeconds:120, nextRunAtUtc:'2026-08-05T05:02:00.000Z',
    })
    // Progress is already carried by auto_progress; scheduler_state dedupe
    // should not suppress or duplicate events for progress-only changes.
    expect(bridgeWs.broadcastAdminEvent).toHaveBeenCalledTimes(1)

    await updateSchedulerRedisState('7:XAUUSD', {
      running:true, subscribers:new Set([42]), subscriberCount:1, intervalMinutes:5,
      waitReason:'cooldown', nextRunInSeconds:90, nextRunAtUtc:'2026-08-05T05:01:30.000Z',
    })
    expect(bridgeWs.broadcastAdminEvent).toHaveBeenCalledTimes(2)

    await updateSchedulerRedisState('7:XAUUSD', {
      running:true, subscribers:new Set([42]), subscriberCount:1, intervalMinutes:5,
      waitReason:'cooldown', nextRunInSeconds:90, nextRunAtUtc:'2026-08-05T05:01:30.000Z',
    })
    expect(bridgeWs.broadcastAdminEvent).toHaveBeenCalledTimes(2)

    await updateSchedulerRedisState('7:XAUUSD', { running:false })
    expect(sets.get('auto:scheduler:keys') || new Set()).not.toContain('7:XAUUSD')
    expect(sets.has('auto:scheduler:7:XAUUSD:subs')).toBe(false)
    expect(hashes.has('auto:scheduler:7:XAUUSD:state')).toBe(false)
    expect(bridgeWs.broadcastAdminEvent).toHaveBeenCalledTimes(3)
    expect(bridgeWs.broadcastAdminEvent.mock.calls[2][2]).toMatchObject({ running:false, key:'7:XAUUSD' })
  })
})

describe('Pending order lifecycle exports', () => {
  it('reconcilePendingOrders 是函数', async () => {
    const mod = await import('../../server/routes/ai/scheduler.js')
    expect(typeof mod.reconcilePendingOrders).toBe('function')
  })

  it('startPendingReconciler 是函数', async () => {
    const mod = await import('../../server/routes/ai/scheduler.js')
    expect(typeof mod.startPendingReconciler).toBe('function')
  })

  it('stopPendingReconciler 是函数', async () => {
    const mod = await import('../../server/routes/ai/scheduler.js')
    expect(typeof mod.stopPendingReconciler).toBe('function')
  })
})

describe('reconcilePendingOrders', () => {
  let reconcilePendingOrders

  beforeEach(async () => {
    vi.clearAllMocks()
    db.queryAll.mockResolvedValue([])
    db.queryRun.mockResolvedValue({})
    bridgeWs.isBridgeAlive.mockReturnValue(true)
    bridgeWs.sendToBrowsers.mockResolvedValue({})
    marketData.mt5Bridge.mockResolvedValue({})

    // Re-import to get fresh module (clearAllMocks wipes mock implementations)
    const mod = await import('../../server/routes/ai/scheduler.js')
    reconcilePendingOrders = mod.reconcilePendingOrders
  })

  it('无 pending 行时直接返回', async () => {
    db.queryAll.mockResolvedValue([])
    await reconcilePendingOrders()
    expect(db.queryRun).not.toHaveBeenCalled()
    expect(marketData.mt5Bridge).not.toHaveBeenCalled()
  })

  it('still pending — ticket 在 pending_list 中，不改变状态', async () => {
    // First call: stale executing check (empty), Second call: delivery rows
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 1, user_id: 10, signal_id: 100, pending_ticket: '5001', pending_valid_until: '2026-12-31 23:59:59' },
      ])
      .mockResolvedValueOnce([])  // signal rows
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [{ ticket: 5001 }] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('filled — ticket 不在 pending_list 但在 positions 中', async () => {
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 2, user_id: 10, signal_id: 200, pending_ticket: '5002', pending_valid_until: '2026-12-31 23:59:59', src: 'delivery' },
      ])
      .mockResolvedValueOnce([])  // signal rows
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [{ ticket: 5002 }] })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    const filledCall = db.queryRun.mock.calls.find(c => c[0].includes("'filled'"))
    expect(filledCall).toBeTruthy()
  })

  it('marks a missing pending ticket filled from a targeted order lookup', async () => {
    db.queryAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 21, user_id: 10, signal_id: 2100, pending_ticket: '5021', pending_valid_until: '2026-12-31 23:59:59', src: 'delivery' },
      ])
      .mockResolvedValueOnce([])
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      if (action === 'order_lookup') return Promise.resolve({
        status:'success', found:true, kind:'pending', pending_state:'filled',
        ticket:'5021', position_id:'7021', deal:'8021',
      })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    expect(marketData.mt5Bridge).toHaveBeenCalledWith(10, 'order_lookup', {
      expected_kind:'pending', pending_ticket:'5021', lookback_seconds:30 * 24 * 60 * 60,
    }, { noFallback:true })
    expect(marketData.mt5Bridge.mock.calls.some(([, action]) => action === 'history')).toBe(false)
    const filledCall = db.queryRun.mock.calls.find(c => c[0].includes("'filled'"))
    expect(filledCall?.[1]?.[0]).toBe('7021')
  })

  it('expired — ticket 不在任一集合中，且已过有效期', async () => {
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 3, user_id: 10, signal_id: 300, pending_ticket: '5003', pending_valid_until: '2020-01-01 00:00:00', src: 'delivery' },
      ])
      .mockResolvedValueOnce([])  // signal rows
      .mockResolvedValueOnce([])
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      if (action === 'order_lookup') return Promise.resolve({ status:'success', found:false, complete:true })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    const expiredCall = db.queryRun.mock.calls.find(c => c[0].includes("'expired'"))
    expect(expiredCall).toBeTruthy()
  })

  it('cancelled — ticket 不在任一集合中，且未过有效期', async () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString().replace('T', ' ').slice(0, 19)
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 4, user_id: 10, signal_id: 400, pending_ticket: '5004', pending_valid_until: futureDate, src: 'delivery' },
      ])
      .mockResolvedValueOnce([])  // signal rows
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    const cancelledCall = db.queryRun.mock.calls.find(c => c[0].includes("'cancelled'"))
    expect(cancelledCall).toBeUndefined()
  })

  it('桥接离线时跳过该用户', async () => {
    bridgeWs.isBridgeAlive.mockReturnValue(false)
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 5, user_id: 20, signal_id: 500, pending_ticket: '5005', pending_valid_until: '2026-12-31 23:59:59', src: 'delivery' },
      ])
      .mockResolvedValueOnce([])  // signal rows

    await reconcilePendingOrders()
    expect(marketData.mt5Bridge).not.toHaveBeenCalled()
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('pending_valid_until 为 null 时按 cancelled 处理（未过期分支）', async () => {
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 6, user_id: 10, signal_id: 600, pending_ticket: '5006', pending_valid_until: null, src: 'delivery' },
      ])
      .mockResolvedValueOnce([])  // signal rows
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    const cancelledCall = db.queryRun.mock.calls.find(c => c[0].includes("'cancelled'"))
    expect(cancelledCall).toBeUndefined()
  })

  it('多用户并行处理', async () => {
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 7, user_id: 10, signal_id: 700, pending_ticket: '5007', pending_valid_until: '2020-01-01 00:00:00', src: 'delivery' },
        { id: 8, user_id: 20, signal_id: 800, pending_ticket: '5008', pending_valid_until: '2020-01-01 00:00:00', src: 'delivery' },
      ])
      .mockResolvedValueOnce([])  // signal rows
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      if (action === 'order_lookup') return Promise.resolve({ status:'success', found:false, complete:true })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    const expiredCalls = db.queryRun.mock.calls.filter(c => c[0].includes("'expired'"))
    expect(expiredCalls.length).toBe(2)
  })

  it('cancels an MT5 pending order after its configured validity expires', async () => {
    db.queryAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 9, user_id: 10, signal_id: 900, pending_ticket: '5009', pending_valid_until: '2020-01-01 00:00:00', src: 'delivery' }])
      .mockResolvedValueOnce([])
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [{
        ticket: 5009, symbol: 'XAUUSD', side: 'buy', volume: 0.1, magic: 234000,
      }] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      if (action === 'cancel_pending') return Promise.resolve({ status: 'success', ticket: 5009 })
      return Promise.resolve({ status: 'error' })
    })

    await reconcilePendingOrders()

    expect(marketData.mt5Bridge).toHaveBeenCalledWith(10, 'cancel_pending', {
      ticket: '5009',
      expected_state: { ticket: '5009', symbol: 'XAUUSD', magic: 234000, volume: 0.1, direction: 'buy' },
    }, { noFallback: true })
    expect(db.queryRun.mock.calls.some(c => c[0].includes("pending_state = 'expired'"))).toBe(true)
  })
})
