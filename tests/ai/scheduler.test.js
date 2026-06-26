import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 依赖
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
}))

vi.mock('../market-data.js', () => ({
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

vi.mock('../llm.js', () => ({
  maybeAiSignal: vi.fn(() => ({
    signal_type: 'buy', confidence: 0.7, recommended_volume: 0.03,
    analysis: 'test', reasoning: 'test',
    stop_loss_price: 1990, take_profit_1_price: 2010,
    _inference_source: 'ai',
  })),
}))

vi.mock('../config.js', () => ({
  getAutoConfig: vi.fn(() => ({ enabled: true, symbols: 'XAUUSD' })),
  getGlobalAutoConfig: vi.fn(() => ({ symbols: 'XAUUSD', interval_minutes: 5 })),
  getAutoInferenceConfig: vi.fn(() => ({
    api_key_encrypted: 'test-key', api_provider: 'deepseek',
    model_name: 'deepseek-chat', _source: 'auto',
  })),
  upsertAutoConfig: vi.fn(),
  getCloseConfig: vi.fn(() => ({ enabled: false })),
  insertAudit: vi.fn(),
  signalOrderPayload: vi.fn(() => ({ symbol: 'XAUUSD', order_type: 'buy', volume: 0.03 })),
  getActiveConfig: vi.fn(() => ({ api_key_encrypted: 'test-key' })),
}))

vi.mock('../strategy.js', () => ({
  buildStrategyContextFromTags: vi.fn(() => ({
    strategy_sequence: 'M5(100)',
    required_timeframes: ['M5'],
    timeframes: { M5: { summary: {}, klines: [] } },
  })),
  executeOrder: vi.fn(() => ({ status: 'success' })),
}))

import { isAutoSchedulerRunning, closeSchedulerState } from '../../server/routes/ai/scheduler.js'

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
