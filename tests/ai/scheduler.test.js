import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 依赖 — 路径必须与 scheduler.js 的导入路径一致
vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
  beijingNow: vi.fn(() => '2026-06-26 12:00:00'),
}))

vi.mock('../../server/bridge-ws.js', () => ({
  isBridgeAlive: vi.fn(() => true),
  getOwnBridgeTradeMode: vi.fn(() => 4),
  getBridgeTradeMode: vi.fn(() => 4),
  sendBridgeCommand: vi.fn(),
  sendToBrowsers: vi.fn(),
}))

vi.mock('../../server/routes/ai/market-data.js', () => ({
  mt5Bridge: vi.fn(),
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
  upsertAutoConfig: vi.fn(),
  getCloseConfig: vi.fn(() => ({ enabled: false })),
  saveCloseConfig: vi.fn(),
  insertAudit: vi.fn(),
  signalOrderPayload: vi.fn(() => ({ symbol: 'XAUUSD', order_type: 'buy', volume: 0.03 })),
  getActiveConfig: vi.fn(() => ({ api_key_encrypted: 'test-key' })),
  getExecuteRiskConfig: vi.fn(() => ({})),
  getDeliveryExecuteRiskConfig: vi.fn(() => ({})),
  validateTradeRequest: vi.fn(),
  RiskReject: class RiskReject extends Error {},
  getAutoPromptTypeById: vi.fn(() => null),
  getAutoPromptTypes: vi.fn(() => []),
  getUnifiedAutoInferenceConfig: vi.fn(() => null),
  getAutoSubscribers: vi.fn(() => []),
  parsePromptSymbols: vi.fn(() => ['XAUUSD']),
  buildBridgeOrderCall: vi.fn(() => ({ bridgeAction: 'open', params: {} })),
}))

vi.mock('../../server/routes/ai/strategy.js', () => ({
  buildStrategyContextFromTags: vi.fn(() => ({
    strategy_sequence: 'M5(100)',
    required_timeframes: ['M5'],
    timeframes: { M5: { summary: {}, klines: [] } },
  })),
  executeOrder: vi.fn(() => ({ status: 'success' })),
  handleAnalyze: vi.fn(),
}))

vi.mock('../../server/routes/ai/utils.js', () => ({
  attachSignalTiming: vi.fn(),
  signalTtlSeconds: vi.fn(() => 120),
  stripTimeframeTags: vi.fn((s) => s),
  round2: vi.fn((n) => n),
  parseTimeframeTags: vi.fn(() => []),
}))

vi.mock('../../server/redis.js', () => ({
  getRedis: vi.fn(() => null),
  isRedisAvailable: vi.fn(() => false),
}))

import { isAutoSchedulerRunning, closeSchedulerState } from '../../server/routes/ai/scheduler.js'
import * as db from '../../server/db.js'
import * as marketData from '../../server/routes/ai/market-data.js'
import * as bridgeWs from '../../server/bridge-ws.js'

describe('isAutoSchedulerRunning', () => {
  it('未启动的调度器返回 false', () => {
    expect(isAutoSchedulerRunning(999)).toBe(false)
  })
})

describe('closeSchedulerState', () => {
  it('初始状态为空对象', () => {
    expect(typeof closeSchedulerState).toBe('object')
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
    expect(cancelledCall).toBeTruthy()
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
    expect(cancelledCall).toBeTruthy()
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
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    const expiredCalls = db.queryRun.mock.calls.filter(c => c[0].includes("'expired'"))
    expect(expiredCalls.length).toBe(2)
  })
})
