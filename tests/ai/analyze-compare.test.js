import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQueryOne = vi.fn()
const mockQueryRun = vi.fn()
const mockQueryAll = vi.fn()

vi.mock('../../server/db.js', () => ({
  queryOne: (...args) => mockQueryOne(...args),
  queryRun: (...args) => mockQueryRun(...args),
  queryAll: (...args) => mockQueryAll(...args),
  withTransaction: vi.fn(),
  beijingNow: () => '2026-07-20 12:00:00',
}))

vi.mock('../../server/redis.js', () => ({
  cacheGetJSON: vi.fn(),
  cacheSetJSON: vi.fn(),
  cacheDel: vi.fn(),
}))

vi.mock('../../server/bridge-ws.js', () => ({
  isTradeEnabled: vi.fn(() => true),
  sendToBrowsers: vi.fn(),
}))

const mockMt5Bridge = vi.fn()
vi.mock('../../server/routes/ai/market-data.js', () => ({
  mt5Bridge: (...args) => mockMt5Bridge(...args),
  platformRates: (userId, params) => mockMt5Bridge(userId, 'rates', params),
  calculateMarketData: vi.fn((symbol, timeframe, rates) => ({
    symbol, timeframe,
    latest_price: 2000, price_change: 10, price_change_pct: 0.5,
    sma_20: 1995, sma_50: 1990, ema_12: 1998, ema_26: 1992,
    atr_14: 10, volatility_pct: 0.3,
    macd: { line: 5, signal: 3, histogram: 2, trend: 'bullish' },
    rsi_14: 55, bollinger: { upper: 2010, lower: 1990, width: 20, position: 0.5 },
    support_resistance: { pivot: 2000, r1: 2005, s1: 1995 },
    kline_patterns: { last_candle: { is_doji: false } },
    volume: { current: 100, average: 80, ratio: 1.25 },
    strategy_score: { trend_strength: 0.6, momentum_alignment: 1, data_confidence: 0.7 },
    kline_count: rates.length,
    positions: { total_positions: 0, details: [] },
    account: { balance: 10000, equity: 10500 },
  })),
  computeAtr14: vi.fn(() => 12),
}))

vi.mock('../../server/routes/ai/llm.js', () => ({
  maybeAiSignal: vi.fn(async (_db, config, _market, _prompt) => ({
    signal_type: 'buy',
    confidence: 0.8,
    recommended_volume: 0.05,
    analysis: 'Test analysis',
    reasoning: 'Test reasoning',
    stop_loss_price: 1990,
    take_profit_1_price: 2010,
    take_profit_2_price: 2020,
    take_profit_3_price: 2030,
    recommended_take_profit_tier: 'tp2',
    entry_method: 'market',
    limit_price: null,
    stop_limit_price: null,
    pending_valid_until: null,
    _inference_source: 'ai',
    _model_profile_id: config?._model_profile_id,
    model_name: config?.model_name,
  })),
}))

vi.mock('../../server/routes/ai/config.js', () => ({
  getAnalyzeApiKey: vi.fn(),
  insertAudit: vi.fn(),
  RiskReject: class extends Error {},
  signalOrderPayload: vi.fn(),
  executeOrderCore: vi.fn(),
  DEFAULT_MAX_POSITION_SIZE: 1.0,
  parsePromptSymbols: vi.fn(() => ['XAUUSD']),
}))

vi.mock('../../server/routes/ai/memory-system.js', () => ({
  retrievePersonalMemory: vi.fn(async () => ({ promptBlock: '', mode: 'off', logId: null })),
  attachMemoryInjectionSignal: vi.fn(),
  recordPairedInferenceRun: vi.fn(),
  buildPersonalMemoryRetrievalContext: vi.fn(() => ({ direction: null, entryMethod: null, marketRegime: null })),
}))

vi.mock('../../server/routes/ai/platform-experience.js', () => ({
  retrievePlatformExperience: vi.fn(async () => ({ promptBlock: '', mode: 'off', logId: null })),
}))

vi.mock('../../server/routes/ai/inference-snapshots.js', () => ({
  buildSharedMarketSnapshot: vi.fn((market) => market),
  persistInferenceSnapshotTx: vi.fn(),
}))

vi.mock('../../server/routes/ai/strategy-ownership.js', () => ({
  getStrategyById: vi.fn(async () => ({
    id: 1, scope: 'platform', symbols_json: '["XAUUSD"]',
    system_prompt: 'test prompt', version: 1,
    include_portfolio_context: 0,
  })),
}))

vi.mock('../../server/routes/ai/strategy-policy.js', () => ({
  parseStrategyPolicy: vi.fn(() => ({
    entryMethods: ['market'],
    marketDataPlan: {
      primary_timeframe: 'M30',
      timeframes: [{ timeframe: 'M30', kline_count: 100 }],
    },
    useChanAnalysis: false,
  })),
  normalizeEntryMethods: vi.fn(() => ['market']),
  signalTypesForEntryMethods: vi.fn(() => ['buy', 'sell', 'hold']),
}))

vi.mock('../../server/routes/ai/signal-presentation.js', () => ({
  attachSignalPresentation: vi.fn((signal) => signal),
  normalizeDecisionFields: vi.fn((signal) => signal),
  SIGNAL_SCHEMA_VERSION: 1,
}))

vi.mock('../../server/routes/ai/platform-market-data.js', () => ({
  saveChanStructureAnchor: vi.fn(),
}))

vi.mock('../../server/routes/ai/utils.js', () => ({
  STRATEGY_TIMEFRAME_COUNTS: { M5: 100, M15: 100, M30: 100, H1: 80, H4: 50 },
  CHAN_HISTORY_COUNT: 300,
  CHAN_MAX_HISTORY_COUNT: 1000,
  attachSignalTiming: vi.fn(),
  parseTimeframeTags: vi.fn(() => [{ tf: 'M30', count: 100 }]),
  compactRates: vi.fn((rates) => rates),
  signalTtlSeconds: vi.fn(() => 3600),
  stripBrokerSuffix: vi.fn((s) => s),
  DEFAULT_PROMPT: 'default prompt',
  stripTimeframeTags: vi.fn((s) => s),
  round2: vi.fn((n) => n),
  parseJsonObject: vi.fn(),
  aiFailureHold: vi.fn((_market, reason) => ({ signal_type: 'hold', confidence: 0, recommended_volume: 0, analysis: '', reasoning: reason, _inference_source: 'ai_error_hold' })),
}))

const mockResolveOwnedModelProfileForRuntime = vi.fn()
vi.mock('../../server/routes/ai/model-profiles.js', () => ({
  resolveOwnedModelProfileForRuntime: (...args) => mockResolveOwnedModelProfileForRuntime(...args),
}))

import { handleAnalyzeCompare } from '../../server/routes/ai/strategy.js'
import { maybeAiSignal } from '../../server/routes/ai/llm.js'

function makeRates(count = 100) {
  return Array.from({ length: count }, (_, i) => ({
    time: `2026-07-01 ${String(i).padStart(2, '0')}:00:00`,
    open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100',
  }))
}

const mockModelProfile = (id) => ({
  model: {
    id,
    provider: 'deepseek',
    api_provider: 'deepseek',
    model_name: `deepseek-chat-${id}`,
    api_base_url: 'https://api.deepseek.com/v1',
    api_key_encrypted: 'encrypted-key',
    key_version: '1',
    temperature: 0.3,
    max_tokens: 2000,
    thinking_enabled: 0,
    reasoning_effort: 'max',
    owner_user_id: 1,
  },
  credential_source: 'user',
  model_profile_id: id,
})

describe('handleAnalyzeCompare', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMt5Bridge.mockResolvedValue({ rates: makeRates(100), market_meta: { source: 'platform_admin_bridge', timezone_offset_minutes: -480 } })
    mockResolveOwnedModelProfileForRuntime.mockImplementation(async (id) => mockModelProfile(id))
  })

  describe('input validation', () => {
    it('returns error when model_ids is missing', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD' })
      expect(result.status).toBe('error')
      expect(result.message).toContain('model_ids')
    })

    it('returns error when model_ids has fewer than 2 items', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [1] })
      expect(result.status).toBe('error')
      expect(result.message).toContain('model_ids')
    })

    it('returns error when model_ids has more than 5 items', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [1, 2, 3, 4, 5, 6] })
      expect(result.status).toBe('error')
      expect(result.message).toContain('model_ids')
    })

    it('returns error when model_ids is not an array', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: 'bad' })
      expect(result.status).toBe('error')
      expect(result.message).toContain('model_ids')
    })
  })

  describe('market data fetch', () => {
    it('fetches market data once and shares across models', async () => {
      await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [1, 2] })
      expect(mockMt5Bridge).toHaveBeenCalledTimes(1)
    })
  })

  describe('parallel inference', () => {
    it('calls maybeAiSignal for each model_id via Promise.allSettled', async () => {
      await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20] })
      expect(maybeAiSignal).toHaveBeenCalledTimes(2)
      expect(maybeAiSignal).toHaveBeenCalledWith(null, expect.objectContaining({ model_name: 'deepseek-chat-10' }), expect.any(Object), expect.any(String))
      expect(maybeAiSignal).toHaveBeenCalledWith(null, expect.objectContaining({ model_name: 'deepseek-chat-20' }), expect.any(Object), expect.any(String))
    })

    it('resolves model profiles for each id', async () => {
      await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20, 30] })
      expect(mockResolveOwnedModelProfileForRuntime).toHaveBeenCalledTimes(3)
      expect(mockResolveOwnedModelProfileForRuntime).toHaveBeenCalledWith(10, 1)
      expect(mockResolveOwnedModelProfileForRuntime).toHaveBeenCalledWith(20, 1)
      expect(mockResolveOwnedModelProfileForRuntime).toHaveBeenCalledWith(30, 1)
    })
  })

  describe('return format', () => {
    it('returns ok=true with results and market_snapshot', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20] })
      expect(result).toHaveProperty('ok', true)
      expect(result).toHaveProperty('results')
      expect(result).toHaveProperty('market_snapshot')
      expect(Array.isArray(result.results)).toBe(true)
      expect(result.results).toHaveLength(2)
    })

    it('each result contains model_id, status, and signal', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20] })
      for (const r of result.results) {
        expect(r).toHaveProperty('model_id')
        expect(r).toHaveProperty('status')
        expect(r).toHaveProperty('signal')
      }
    })

    it('returns success for fulfilled inference and error for rejected', async () => {
      maybeAiSignal
        .mockResolvedValueOnce({ signal_type: 'buy', confidence: 0.8, analysis: 'a', reasoning: 'r', _inference_source: 'ai' })
        .mockRejectedValueOnce(new Error('llm_timeout'))
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20] })
      const fulfilled = result.results.find(r => r.model_id === 10)
      const rejected = result.results.find(r => r.model_id === 20)
      expect(fulfilled.status).toBe('success')
      expect(rejected.status).toBe('error')
      expect(rejected.error).toContain('llm_timeout')
    })
  })

  describe('does not persist or execute', () => {
    it('does not call withTransaction', async () => {
      const { withTransaction } = await import('../../server/db.js')
      await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20] })
      expect(withTransaction).not.toHaveBeenCalled()
    })

    it('does not send browser notifications', async () => {
      const { sendToBrowsers } = await import('../../server/bridge-ws.js')
      await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20] })
      expect(sendToBrowsers).not.toHaveBeenCalled()
    })
  })

  describe('market_snapshot structure', () => {
    it('contains symbol and latest_price', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20] })
      expect(result.market_snapshot).toHaveProperty('symbol', 'XAUUSD')
      expect(result.market_snapshot).toHaveProperty('latest_price')
    })
  })
})
