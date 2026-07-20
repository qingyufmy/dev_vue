import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const routes = readFileSync(new URL('../../server/routes/ai/index.js', import.meta.url), 'utf8')

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

const mockGetStrategyById = vi.fn(async () => ({
  id: 1, scope: 'platform', symbols_json: '["XAUUSD"]',
  system_prompt: 'test prompt', version: 1,
  include_portfolio_context: 0,
}))

vi.mock('../../server/routes/ai/strategy-ownership.js', () => ({
  getStrategyById: (...args) => mockGetStrategyById(...args),
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

vi.mock('../../server/routes/ai/period-market-evidence.js', () => ({
  loadPeriodMarketWindow: async (userId, symbol, timeframe, startUtcMs, endUtcMs) => {
    const response = await mockMt5Bridge(userId, 'rates', {
      symbol, timeframe, review_window: true,
      start_utc_msc: startUtcMs, end_utc_msc: endUtcMs,
    })
    return { periodRates: response?.rates || [], marketMeta: response?.market_meta || {} }
  },
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

import { handleAnalyzeCompare, handleHistoryCompare } from '../../server/routes/ai/strategy.js'
import { maybeAiSignal } from '../../server/routes/ai/llm.js'

function makeRates(count = 100) {
  return Array.from({ length: count }, (_, i) => ({
    time: new Date(Date.UTC(2026, 6, 1, 0, i * 30)).toISOString(),
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
    it('returns error when strategy_id is missing', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [1, 2] })
      expect(result.ok).toBe(false)
      expect(result.error).toBe('strategy_id_required')
    })

    it('returns error when strategy is not found', async () => {
      mockGetStrategyById.mockResolvedValueOnce(null)
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [1, 2], strategy_id: 999 })
      expect(result.ok).toBe(false)
      expect(result.error).toBe('strategy_not_found')
    })

    it('returns error when symbol is not supported by strategy', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'EURUSD', model_ids: [1, 2], strategy_id: 1 })
      expect(result.ok).toBe(false)
      expect(result.error).toBe('symbol_not_supported_by_strategy')
    })

    it('returns error when model_ids is missing', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', strategy_id: 1 })
      expect(result.status).toBe('error')
      expect(result.message).toContain('model_ids')
    })

    it('returns error when model_ids has fewer than 2 items', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', strategy_id: 1, model_ids: [1] })
      expect(result.status).toBe('error')
      expect(result.message).toContain('model_ids')
    })

    it('returns error when model_ids has more than 5 items', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', strategy_id: 1, model_ids: [1, 2, 3, 4, 5, 6] })
      expect(result.status).toBe('error')
      expect(result.message).toContain('model_ids')
    })

    it('returns error when model_ids is not an array', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', strategy_id: 1, model_ids: 'bad' })
      expect(result.status).toBe('error')
      expect(result.message).toContain('model_ids')
    })
  })

  describe('market data fetch', () => {
    it('fetches market data and shares across models', async () => {
      await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [1, 2], strategy_id: 1 })
      expect(mockMt5Bridge).toHaveBeenCalled()
    })
  })

  describe('parallel inference', () => {
    it('calls maybeAiSignal for each model_id', async () => {
      await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20], strategy_id: 1 })
      expect(maybeAiSignal).toHaveBeenCalledTimes(2)
      expect(maybeAiSignal).toHaveBeenCalledWith(null, expect.objectContaining({ model_name: 'deepseek-chat-10' }), expect.any(Object), expect.any(String))
      expect(maybeAiSignal).toHaveBeenCalledWith(null, expect.objectContaining({ model_name: 'deepseek-chat-20' }), expect.any(Object), expect.any(String))
    })

    it('resolves model profiles for each id', async () => {
      await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20, 30], strategy_id: 1 })
      expect(mockResolveOwnedModelProfileForRuntime).toHaveBeenCalledTimes(3)
      expect(mockResolveOwnedModelProfileForRuntime).toHaveBeenCalledWith(10, 1)
      expect(mockResolveOwnedModelProfileForRuntime).toHaveBeenCalledWith(20, 1)
      expect(mockResolveOwnedModelProfileForRuntime).toHaveBeenCalledWith(30, 1)
    })
  })

  describe('return format', () => {
    it('returns ok=true with results and market_snapshot', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20], strategy_id: 1 })
      expect(result).toHaveProperty('ok', true)
      expect(result).toHaveProperty('results')
      expect(result).toHaveProperty('market_snapshot')
      expect(Array.isArray(result.results)).toBe(true)
      expect(result.results).toHaveLength(2)
    })

    it('each result contains model_id, status, and signal', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20], strategy_id: 1 })
      for (const r of result.results) {
        expect(r).toHaveProperty('model_id')
        expect(r).toHaveProperty('status')
        expect(r).toHaveProperty('signal')
        expect(r.signal_type).toBe(r.signal.signal_type)
        expect(r.confidence).toBe(r.signal.confidence)
      }
      expect(result.models[10]).toMatchObject({ model_name: 'deepseek-chat-10', provider: 'deepseek' })
    })

    it('returns success for fulfilled inference and error for rejected', async () => {
      maybeAiSignal
        .mockResolvedValueOnce({ signal_type: 'buy', confidence: 0.8, analysis: 'a', reasoning: 'r', _inference_source: 'ai' })
        .mockRejectedValueOnce(new Error('llm_timeout'))
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20], strategy_id: 1 })
      const fulfilled = result.results.find(r => r.model_id === 10)
      const rejected = result.results.find(r => r.model_id === 20)
      expect(fulfilled.status).toBe('success')
      expect(rejected.status).toBe('error')
      expect(rejected.error).toContain('llm_timeout')
    })

    it('does not label an LLM fallback hold as a successful comparison', async () => {
      maybeAiSignal
        .mockResolvedValueOnce({ signal_type: 'hold', reasoning: 'llm_timeout', _inference_source: 'ai_error_hold' })
        .mockResolvedValueOnce({ signal_type: 'buy', confidence: 0.8, analysis: 'ok', _inference_source: 'ai' })
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20], strategy_id: 1 })
      expect(result.results.find(r => r.model_id === 10)).toMatchObject({ status: 'error', error: 'llm_timeout' })
      expect(result.results.find(r => r.model_id === 20).status).toBe('success')
    })
  })

  describe('does not persist or execute', () => {
    it('does not call withTransaction', async () => {
      const { withTransaction } = await import('../../server/db.js')
      await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20], strategy_id: 1 })
      expect(withTransaction).not.toHaveBeenCalled()
    })

    it('does not send browser notifications', async () => {
      const { sendToBrowsers } = await import('../../server/bridge-ws.js')
      await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20], strategy_id: 1 })
      expect(sendToBrowsers).not.toHaveBeenCalled()
    })
  })

  describe('market_snapshot structure', () => {
    it('contains symbol and latest_price', async () => {
      const result = await handleAnalyzeCompare(1, { symbol: 'XAUUSD', model_ids: [10, 20], strategy_id: 1 })
      expect(result.market_snapshot).toHaveProperty('symbol', 'XAUUSD')
      expect(result.market_snapshot).toHaveProperty('latest_price')
    })
  })
})

describe('POST /ai/analyze-compare route', () => {
  it('route is registered in ai/index.js', () => {
    expect(routes).toContain("router.post('/ai/analyze-compare', authMiddleware")
  })

  it('route imports handleAnalyzeCompare from strategy.js', () => {
    expect(routes).toContain('handleAnalyzeCompare')
  })

  it('route calls handleAnalyzeCompare(req.user.id, req.body)', () => {
    expect(routes).toContain('handleAnalyzeCompare(req.user.id, req.body || {})')
  })

  it('enforces current Pro access on the direct HTTP route', () => {
    expect(routes).toContain('has_pro_access')
    expect(routes).toContain("error: 'pro_access_required'")
  })

  it('uses the model-specific timeout for connection tests', () => {
    expect(routes).toContain('timeout: resolved.model.request_timeout_ms || 120000')
  })
})

describe('handleHistoryCompare', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveOwnedModelProfileForRuntime.mockImplementation(async (id) => mockModelProfile(id))
  })

  describe('admin check', () => {
    it('returns error for non-admin user', async () => {
      mockQueryOne.mockResolvedValueOnce({ role: 'user' })
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [1, 2], strategy_id: 1, start_time: '2026-07-01 00:00:00', end_time: '2026-07-02 00:00:00' })
      expect(result.status).toBe('error')
      expect(result.message).toBe('admin_only')
    })

    it('returns error when user not found', async () => {
      mockQueryOne.mockResolvedValueOnce(null)
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [1, 2], strategy_id: 1, start_time: '2026-07-01 00:00:00', end_time: '2026-07-02 00:00:00' })
      expect(result.status).toBe('error')
      expect(result.message).toBe('admin_only')
    })
  })

  describe('input validation', () => {
    beforeEach(() => {
      mockQueryOne.mockResolvedValue({ role: 'admin' })
    })

    it('returns error when symbol is missing', async () => {
      const result = await handleHistoryCompare(1, { timeframe: 'M30', model_ids: [1, 2], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02' })
      expect(result.status).toBe('error')
      expect(result.message).toBe('symbol required')
    })

    it('returns error when timeframe is missing', async () => {
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', model_ids: [1, 2], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02' })
      expect(result.status).toBe('error')
      expect(result.message).toBe('timeframe required')
    })

    it('returns error when strategy_id is missing', async () => {
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [1, 2], start_time: '2026-07-01', end_time: '2026-07-02' })
      expect(result.status).toBe('error')
      expect(result.message).toBe('strategy required')
    })

    it('returns error when start_time is missing', async () => {
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [1, 2], strategy_id: 1, end_time: '2026-07-02' })
      expect(result.status).toBe('error')
      expect(result.message).toBe('start_time and end_time required')
    })

    it('returns error when model_ids has fewer than 2 items', async () => {
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [1], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02' })
      expect(result.status).toBe('error')
      expect(result.message).toContain('model_ids')
    })

    it('returns error when model_ids is not an array', async () => {
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: 'bad', strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02' })
      expect(result.status).toBe('error')
      expect(result.message).toContain('model_ids')
    })

    it('returns error when strategy is not found', async () => {
      mockGetStrategyById.mockResolvedValueOnce(null)
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [1, 2], strategy_id: 999, start_time: '2026-07-01', end_time: '2026-07-02' })
      expect(result.status).toBe('error')
      expect(result.message).toBe('strategy_not_found')
    })
  })

  describe('kline data', () => {
    beforeEach(() => {
      mockQueryOne.mockResolvedValue({ role: 'admin' })
    })

    it('returns error when no kline data for range', async () => {
      mockMt5Bridge.mockResolvedValueOnce({ status: 'success', rates: [], market_meta: { source: 'mysql' } })
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [1, 2], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02' })
      expect(result.status).toBe('error')
      expect(result.message).toBe('insufficient_kline_data_for_compare')
    })

    it('hydrates the existing market candle cache through platformRates', async () => {
      mockMt5Bridge.mockResolvedValueOnce({ status: 'success', rates: [], market_meta: { source: 'mysql' } })
      await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [1, 2], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02' })
      expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({
        symbol: 'XAUUSD', timeframe: 'M30', review_window: true,
        start_utc_msc: expect.any(Number), end_utc_msc: expect.any(Number),
      }))
    })
  })

  describe('historical inference', () => {
    beforeEach(() => {
      mockQueryOne.mockResolvedValue({ role: 'admin' })
      mockMt5Bridge.mockResolvedValue({
        status: 'success',
        market_meta: { source: 'mysql_period_cache' },
        rates: Array.from({ length: 50 }, (_, i) => ({
          time: new Date(Date.UTC(2026, 6, 1, 0, i * 30)).toISOString(),
          open: 2000 + i, high: 2010 + i, low: 1990 + i, close: 2005 + i, tick_volume: 100,
        })),
      })
    })

    it('calls maybeAiSignal for each model at each step', async () => {
      await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [10, 20], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02', step: 10 })
      expect(maybeAiSignal).toHaveBeenCalled()
      const callCount = maybeAiSignal.mock.calls.length
      expect(callCount).toBeGreaterThan(0)
    })

    it('returns next-closed-bar directional scores without labelling them as PnL', async () => {
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [10, 20], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02', step: 25 })
      expect(result.status).toBe('success')
      expect(result.results).toHaveLength(2)
      for (const r of result.results) {
        expect(r).toHaveProperty('model_id')
        expect(r).toHaveProperty('model_name')
        expect(r).toHaveProperty('status', 'success')
        expect(r).toHaveProperty('signals')
        expect(r).not.toHaveProperty('simulated_pnl')
        expect(r).toHaveProperty('directional_score')
        expect(r.directional_score).toHaveProperty('total_move')
        expect(r.directional_score).toHaveProperty('directional_accuracy')
        expect(r.directional_score).toHaveProperty('direction_quality_score')
        expect(r.directional_score).toHaveProperty('action_rate')
        expect(r.directional_score).toHaveProperty('response_success_rate')
        expect(r.directional_score).toHaveProperty('average_confidence')
        expect(r.directional_score).toHaveProperty('average_latency_ms')
        expect(r.directional_score).toHaveProperty('buy_count')
        expect(r.directional_score).toHaveProperty('sell_count')
        expect(r.directional_score).toHaveProperty('hold_count')
      }
    })

    it('includes meta with kline_count and step', async () => {
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [10, 20], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02', step: 10 })
      expect(result.meta).toHaveProperty('symbol', 'XAUUSD')
      expect(result.meta).toHaveProperty('timeframe', 'M30')
      expect(result.meta.kline_count).toBeGreaterThan(20)
      expect(result.meta.kline_count).toBeLessThanOrEqual(50)
      expect(result.meta).toHaveProperty('requested_step', 10)
      expect(result.meta.evaluation_count).toBeLessThanOrEqual(20)
      expect(result.meta).toHaveProperty('metric_type', 'next_closed_bar_direction')
      expect(result.meta).toHaveProperty('metric_version', 'directional-eval-v2')
      expect(result.meta).toHaveProperty('average_agreement_rate')
    })

    it('uses an explicit evenly distributed sample size for the new client', async () => {
      const result = await handleHistoryCompare(1, {
        symbol: 'XAUUSD', timeframe: 'M30', model_ids: [10, 20], strategy_id: 1,
        start_time: '2026-07-01', end_time: '2026-07-02', sample_size: 8,
      })
      expect(result.status).toBe('success')
      expect(result.meta.sample_size).toBe(8)
      expect(result.meta.evaluation_count).toBe(8)
      expect(result.meta.estimated_model_calls).toBe(16)
      expect(result.results[0].signals[0]).toHaveProperty('decision_time')
      expect(result.results[0].signals[0]).toHaveProperty('outcome_time')
    })

    it('evaluates a signal against the next unseen candle and records losses', async () => {
      maybeAiSignal.mockResolvedValue({
        signal_type: 'buy', confidence: 0.8, analysis: 'a', reasoning: 'r', _inference_source: 'ai',
      })
      mockMt5Bridge.mockResolvedValue({
        status: 'success',
        rates: Array.from({ length: 25 }, (_, i) => ({
          time: new Date(Date.UTC(2026, 6, 1, 0, i * 30)).toISOString(),
          open: 2000, high: 2010, low: 1980, close: i === 20 ? 1990 : 2005, tick_volume: 100,
        })),
        market_meta: { source: 'mysql_period_cache' },
      })
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [10, 20], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02', step: 50 })
      expect(result.results[0].signals[0].time).toContain('10:00:00')
      expect(result.results[0].signals[0].next_bar_move).toBe(-10)
      expect(result.results[0].directional_score.incorrect_count).toBeGreaterThan(0)
    })

    it('rejects a comparison timeframe outside the strategy market-data plan', async () => {
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'H1', model_ids: [10, 20], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02', step: 10 })
      expect(result).toEqual({ status: 'error', message: 'timeframe_not_supported_by_strategy' })
      expect(maybeAiSignal).not.toHaveBeenCalled()
    })
  })
})

describe('POST /ai/model-compare/history route', () => {
  it('route is registered in ai/index.js', () => {
    expect(routes).toContain("router.post('/ai/model-compare/history', authMiddleware")
  })

  it('route imports the history comparison job API from strategy.js', () => {
    expect(routes).toContain('startHistoryCompareJob')
    expect(routes).toContain('getHistoryCompareJob')
    expect(routes).toContain('cancelHistoryCompareJob')
  })

  it('route creates a background comparison job', () => {
    expect(routes).toContain('startHistoryCompareJob(req.user.id, req.body || {})')
    expect(routes).toContain("router.get('/ai/model-compare/history/:jobId'")
    expect(routes).toContain("router.delete('/ai/model-compare/history/:jobId'")
  })

  it('exposes a lightweight recent-job list', () => {
    expect(routes).toContain("router.get('/ai/model-compare/history', authMiddleware")
    expect(routes).toContain('listHistoryCompareJobs')
  })
})

describe('historical comparison frontend contract', () => {
  const frontend = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')

  it('polls background jobs and supports cancellation', () => {
    expect(frontend).toContain('/api/ai/model-compare/history/${encodeURIComponent(jobId)}')
    expect(frontend).toContain('{ method:"DELETE" }')
  })

  it('presents directional evaluation instead of simulated profit', () => {
    expect(frontend).toContain('方向准确率')
    expect(frontend).toContain('下一根已收盘 K 线方向')
    expect(frontend).not.toContain('模拟盈亏')
  })
})
