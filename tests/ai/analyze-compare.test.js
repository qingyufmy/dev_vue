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
  maybeAiSignal: vi.fn(async (_db, config, _market, _prompt) => {
    config?._onInferencePrepared?.({
      systemPrompt:'rendered-system-prompt',
      userPrompt:'rendered-user-prompt',
      outputSchemaVersion:'schema-v1',
    })
    config?._onProviderRequest?.({ phase:'request' })
    config?._onProviderUsage?.({ phase:'request', status:'success', tokenCount:123 })
    return {
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
    }
  }),
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

import {
  __historyCompareJobsTest,
  handleAnalyzeCompare,
  handleHistoryCompare,
  resolveStrategyEvaluationTimeframe,
} from '../../server/routes/ai/strategy.js'
import { maybeAiSignal } from '../../server/routes/ai/llm.js'
const defaultMaybeAiSignalImplementation = maybeAiSignal.getMockImplementation()

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
    profile_updated_at: '2026-07-20 12:00:00',
    owner_user_id: 1,
  },
  credential_source: 'user',
  model_profile_id: id,
})

describe('handleAnalyzeCompare', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    maybeAiSignal.mockImplementation(defaultMaybeAiSignalImplementation)
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
      expect(maybeAiSignal).toHaveBeenCalledWith(null, expect.objectContaining({
        model_name:'deepseek-chat-10',
        _usage:'model_compare',
        _strategyId:1,
        _comparison_mode:true,
      }), expect.any(Object), expect.any(String))
      expect(maybeAiSignal).toHaveBeenCalledWith(null, expect.objectContaining({
        model_name:'deepseek-chat-20',
        _usage:'model_compare',
        _strategyId:1,
      }), expect.any(Object), expect.any(String))
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
    maybeAiSignal.mockImplementation(defaultMaybeAiSignalImplementation)
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

    it('derives the evaluation timeframe from the strategy when the client omits it', async () => {
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', model_ids: [1, 2], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02' })
      expect(result.status).toBe('success')
      expect(result.meta.timeframe).toBe('M30')
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

    it('interprets legacy unqualified ranges with the supplied MT5 timezone', async () => {
      mockMt5Bridge.mockResolvedValue({ status:'success', rates:[], market_meta:{ source:'mysql' } })
      await handleHistoryCompare(1, {
        symbol:'XAUUSD', model_ids:[1, 2], strategy_id:1,
        start_time:'2026-07-01 00:00:00', end_time:'2026-07-02 00:00:00',
        timezone_offset_minutes:180,
      })
      const utc3Start = mockMt5Bridge.mock.calls.find(call => call[1] === 'rates')[2].start_utc_msc
      mockMt5Bridge.mockClear()
      mockMt5Bridge.mockResolvedValue({ status:'success', rates:[], market_meta:{ source:'mysql' } })
      await handleHistoryCompare(1, {
        symbol:'XAUUSD', model_ids:[1, 2], strategy_id:1,
        start_time:'2026-07-01 00:00:00', end_time:'2026-07-02 00:00:00',
        timezone_offset_minutes:480,
      })
      const utc8Start = mockMt5Bridge.mock.calls.find(call => call[1] === 'rates')[2].start_utc_msc
      expect(utc3Start - utc8Start).toBe(5 * 60 * 60 * 1000)
    })
  })

  describe('historical inference', () => {
    beforeEach(() => {
      mockQueryOne.mockResolvedValue({ role: 'admin' })
      mockMt5Bridge.mockImplementation(async (_userId, action) => {
        if (action === 'symbol_snapshot') {
          return {
            status:'success',
            account:{ currency:'USD', balance:10_000, equity:10_000, leverage:100 },
            instrument:{
              name:'XAUUSD', digits:2, point:0.01, tick_size:0.01, tick_value:1,
              contract_size:100, volume_min:0.01, volume_max:100, volume_step:0.01,
              currency_profit:'USD',
            },
          }
        }
        return {
          status: 'success',
          market_meta: { source: 'mysql_period_cache', timezone_offset_minutes: 180 },
          rates: Array.from({ length: 90 }, (_, i) => ({
            time: new Date(Date.UTC(2026, 6, 1, 0, (i - 40) * 30)).toISOString(),
            open: 2000 + i, high: 2010 + i, low: 1990 + i, close: 2005 + i, tick_volume: 100,
          })),
        }
      })
    })

    it('calls maybeAiSignal for each model at each step', async () => {
      await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [10, 20], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02', step: 10 })
      expect(maybeAiSignal).toHaveBeenCalled()
      const callCount = maybeAiSignal.mock.calls.length
      expect(callCount).toBeGreaterThan(0)
      expect(maybeAiSignal).toHaveBeenCalledWith(null, expect.objectContaining({
        _comparison_mode:true,
      }), expect.any(Object), expect.any(String))
    })

    it('passes a shared abort signal to every model and exits when it is cancelled', async () => {
      const controller = new AbortController()
      maybeAiSignal.mockImplementation(async (_db, config) => {
        expect(config._abortSignal).toBe(controller.signal)
        controller.abort(new Error('history_compare_cancelled'))
        throw controller.signal.reason
      })

      await expect(handleHistoryCompare(1, {
        symbol:'XAUUSD', model_ids:[10, 20], strategy_id:1,
        start_time:'2026-07-01', end_time:'2026-07-02', sample_size:4,
      }, {
        abortSignal:controller.signal,
        shouldCancel:() => controller.signal.aborted,
      })).rejects.toThrow('history_compare_cancelled')
    })

    it('returns direction scores and a separately labelled account replay', async () => {
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [10, 20], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02', step: 25 })
      expect(result.status).toBe('success')
      expect(result.results).toHaveLength(2)
      for (const r of result.results) {
        expect(r).toHaveProperty('model_id')
        expect(r).toHaveProperty('model_name')
        expect(r).toHaveProperty('status', 'success')
        expect(r).toHaveProperty('signals')
        expect(r).toHaveProperty('directional_score')
        expect(r).toHaveProperty('account_simulation')
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
        expect(r.directional_score).toHaveProperty('downgraded_count')
        expect(r.directional_score).toHaveProperty('constraint_invalid_count')
        expect(r.directional_score).toHaveProperty('executable_count')
        expect(r.directional_score).toHaveProperty('output_compliance_rate')
        expect(r.directional_score).toHaveProperty('invalid_count')
        expect(r.account_simulation.options).toMatchObject({
          timezone_offset_minutes:180,
          account_currency:'USD',
          apply_swap:true,
        })
      }
    })

    it('keeps a constraint-invalid raw direction out of account replay without turning it into hold', async () => {
      maybeAiSignal.mockResolvedValue({
        signal_type:'buy_limit', entry_method:'limit', confidence:0.8,
        recommended_volume:0.02, limit_price:2010, stop_loss_price:1990,
        take_profit_1_price:2020, recommended_take_profit_tier:1,
        comparison_validation:{ status:'invalid', execution_eligible:false, errors:['pending_price_direction_invalid'], warnings:[] },
        analysis:'a', reasoning:'r', _inference_source:'ai',
      })
      const result = await handleHistoryCompare(1, {
        symbol:'XAUUSD', model_ids:[10, 20], strategy_id:1,
        start_time:'2026-07-01', end_time:'2026-07-02', step:25,
      })
      expect(result.results[0].signals[0]).toMatchObject({
        signal_type:'buy', decision_class:'constraint_invalid', execution_eligible:false,
      })
      expect(result.results[0].directional_score).toMatchObject({
        buy_count:expect.any(Number), hold_count:0, constraint_invalid_count:expect.any(Number),
        executable_count:0, output_compliance_rate:0,
      })
      expect(result.meta.account_simulation_status).toBe('not_applicable')
    })

    it('treats an unknown signal type as an invalid model response', async () => {
      maybeAiSignal.mockResolvedValue({
        signal_type:'buy_now', confidence:0.8, analysis:'a', reasoning:'r', _inference_source:'ai',
      })
      const result = await handleHistoryCompare(1, {
        symbol:'XAUUSD', model_ids:[10, 20], strategy_id:1,
        start_time:'2026-07-01', end_time:'2026-07-02', step:25,
      })
      expect(result.status).toBe('success')
      expect(result.results.every(item => item.status === 'error')).toBe(true)
      expect(result.results[0]).toMatchObject({
        error:'model_compare_no_valid_response',
        directional_score:{ response_success_rate:0, error_count:expect.any(Number) },
      })
      expect(result.results[0].signals.every(signal =>
        signal.signal_type === 'error' && signal.error === 'invalid_model_signal_type')).toBe(true)
    })

    it('does not report agreement when fewer than two models have valid responses', async () => {
      maybeAiSignal.mockImplementation(async (_db, config) => {
        if (config._model_profile_id === 10) throw new Error('llm_timeout')
        return {
          signal_type:'buy', entry_method:'market', confidence:0.8,
          analysis:'a', reasoning:'r', _inference_source:'ai',
        }
      })
      const result = await handleHistoryCompare(1, {
        symbol:'XAUUSD', model_ids:[10, 20], strategy_id:1,
        start_time:'2026-07-01', end_time:'2026-07-02', step:25,
      })
      expect(result.meta.average_agreement_rate).toBe(0)
      expect(result.meta.agreement_comparable_count).toBe(0)
      expect(result.meta.agreement_insufficient_count).toBe(result.meta.evaluation_count)
      expect(result.meta.high_agreement_count).toBe(0)
      expect(result.meta.disagreement_count).toBe(0)
    })

    it('bounds repeated provider errors stored in comparison results', async () => {
      maybeAiSignal.mockRejectedValue(new Error(`provider_failure:${'x'.repeat(2000)}`))
      const result = await handleHistoryCompare(1, {
        symbol:'XAUUSD', model_ids:[10, 20], strategy_id:1,
        start_time:'2026-07-01', end_time:'2026-07-02', step:25,
      })
      const errors = result.results.flatMap(item => item.signals.map(signal => signal.error))
      expect(errors.length).toBeGreaterThan(0)
      expect(errors.every(error => error.length === 500)).toBe(true)
    })

    it('includes meta with kline_count and step', async () => {
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'M30', model_ids: [10, 20], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02', step: 10 })
      expect(result.meta).toHaveProperty('symbol', 'XAUUSD')
      expect(result.meta).toHaveProperty('timeframe', 'M30')
      expect(result.meta.kline_count).toBeGreaterThan(20)
      expect(result.meta.kline_count).toBeLessThanOrEqual(50)
      expect(result.meta).toHaveProperty('requested_step', 10)
      expect(result.meta.evaluation_count).toBeLessThanOrEqual(20)
      expect(result.meta).toHaveProperty('metric_type', 'next_evaluation_bar_direction')
      expect(result.meta).toHaveProperty('metric_version', 'directional-eval-v4')
      expect(result.meta).toHaveProperty('average_agreement_rate')
      expect(result.meta).toHaveProperty('agreement_comparable_count')
      expect(result.meta).toHaveProperty('agreement_insufficient_count')
      expect(result.meta).toHaveProperty('execution_timezone_offset_minutes', 180)
      expect(result.meta).toHaveProperty('selection_timezone_offset_minutes', 180)
    })

    it('serializes production cache timestamps even when candles have no legacy time field', async () => {
      const baseImplementation = mockMt5Bridge.getMockImplementation()
      mockMt5Bridge.mockImplementation(async (...args) => {
        const response = await baseImplementation(...args)
        if (args[1] !== 'rates') return response
        return {
          ...response,
          rates:response.rates.map(({ time, ...rate }) => ({
            ...rate,
            time_utc_msc:new Date(time).getTime(),
          })),
        }
      })
      const result = await handleHistoryCompare(1, {
        symbol:'XAUUSD', model_ids:[10, 20], strategy_id:1,
        start_time:'2026-07-01', end_time:'2026-07-02', sample_size:4,
      })
      expect(result.status).toBe('success')
      expect(result.meta.start_time).toMatch(/^2026-/)
      expect(result.meta.end_time).toMatch(/^2026-/)
      expect(result.results[0].signals.every(signal => signal.time?.startsWith('2026-'))).toBe(true)
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
      expect(result.meta.actual_model_calls).toBe(16)
      expect(result.meta.repair_model_calls).toBe(0)
      expect(result.meta.model_token_count).toBe(16 * 123)
      expect(result.meta.reproducibility).toMatchObject({
        run_version:'history-compare-v6',
        reproducibility_level:'input_auditable_model_nondeterministic',
        strategy:{
          strategy_id:1,
          strategy_version:1,
          system_prompt_sha256:expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        market_data:[expect.objectContaining({
          timeframe:'M30',
          sha256:expect.stringMatching(/^[a-f0-9]{64}$/),
        })],
      })
      expect(result.meta.reproducibility.decision_inputs).toHaveLength(8)
      expect(result.meta.reproducibility.evidence_sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(result.results[0].runtime_model).toMatchObject({
        model_profile_id:10,
        model_name:'deepseek-chat-10',
        api_base_url_sha256:expect.stringMatching(/^[a-f0-9]{64}$/),
        runtime_config_sha256:expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(result.results[0].provider_usage).toMatchObject({
        provider_request_count:8,
        repair_request_count:0,
        successful_request_count:8,
        token_count:8 * 123,
      })
      expect(JSON.stringify(result.meta.reproducibility)).not.toContain('encrypted-key')
      expect(JSON.stringify(result.meta.reproducibility)).not.toContain('api.deepseek.com')
      expect(result.results[0].signals[0]).toHaveProperty('decision_time')
      expect(result.results[0].signals[0]).toHaveProperty('outcome_time')
      expect(result.results[0].signals[0].decision_time_utc_msc)
        .toBe(result.results[0].signals[0].outcome_time_utc_msc)
    })

    it('evaluates every eligible primary candle in continuous mode', async () => {
      const result = await handleHistoryCompare(1, {
        symbol: 'XAUUSD', model_ids: [10, 20], strategy_id: 1,
        start_time: '2026-07-01', end_time: '2026-07-02',
        evaluation_mode: 'continuous',
      })
      expect(result.status).toBe('success')
      expect(result.meta.evaluation_mode).toBe('continuous')
      expect(result.meta.sample_size).toBeNull()
      expect(result.meta.evaluation_count).toBe(result.meta.kline_count - 1)
      expect(result.meta.max_evaluation_count).toBe(120)
      expect(result.meta.estimated_model_calls).toBe(result.meta.evaluation_count * 2)
    })

    it('rejects an oversized continuous range before calling any model', async () => {
      const baseImplementation = mockMt5Bridge.getMockImplementation()
      mockMt5Bridge.mockImplementation(async (userId, action, params) => {
        if (action !== 'rates') return baseImplementation(userId, action, params)
        return {
          status: 'success',
          market_meta: { source: 'mysql_period_cache', timezone_offset_minutes: 180 },
          rates: Array.from({ length: 170 }, (_, i) => ({
            time: new Date(Date.UTC(2026, 6, 1, 0, (i - 20) * 30)).toISOString(),
            open: 2000 + i, high: 2010 + i, low: 1990 + i, close: 2005 + i, tick_volume: 100,
          })),
        }
      })
      maybeAiSignal.mockClear()
      const result = await handleHistoryCompare(1, {
        symbol: 'XAUUSD', model_ids: [10, 20], strategy_id: 1,
        start_time: '2026-07-01', end_time: '2026-07-05',
        evaluation_mode: 'continuous',
      })
      expect(result.status).toBe('error')
      expect(result.message).toBe('continuous_backtest_range_too_large')
      expect(result.evaluation_count).toBeGreaterThan(120)
      expect(result.max_evaluation_count).toBe(120)
      expect(maybeAiSignal).not.toHaveBeenCalled()
    })

    it('validates all strategy timeframe context before continuous model calls', async () => {
      mockMt5Bridge.mockResolvedValue({
        status: 'success',
        market_meta: { source: 'mysql_period_cache', timezone_offset_minutes: 180 },
        rates: Array.from({ length: 10 }, (_, i) => ({
          time: new Date(Date.UTC(2026, 6, 1, 0, i * 30)).toISOString(),
          open: 2000 + i, high: 2010 + i, low: 1990 + i, close: 2005 + i, tick_volume: 100,
        })),
      })
      maybeAiSignal.mockClear()
      const result = await handleHistoryCompare(1, {
        symbol: 'XAUUSD', model_ids: [10, 20], strategy_id: 1,
        start_time: '2026-07-01', end_time: '2026-07-02',
        evaluation_mode: 'continuous',
      })
      expect(result.status).toBe('error')
      expect(result.message).toBe('history_compare_strategy_context_incomplete')
      expect(result.missing_timeframes).toEqual(['M30'])
      expect(maybeAiSignal).not.toHaveBeenCalled()
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

    it('ignores a client-supplied timeframe and always uses the strategy primary timeframe', async () => {
      const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', timeframe: 'H1', model_ids: [10, 20], strategy_id: 1, start_time: '2026-07-01', end_time: '2026-07-02', step: 10 })
      expect(result.status).toBe('success')
      expect(result.meta.timeframe).toBe('M30')
      expect(maybeAiSignal).toHaveBeenCalled()
    })

    it('falls back to the legacy compact risk snapshot until an older bridge is restarted', async () => {
      const baseImplementation = mockMt5Bridge.getMockImplementation()
      mockMt5Bridge.mockImplementation(async (userId, action, params) => {
        if (action === 'symbol_snapshot') return { status:'error', message:'unknown action' }
        if (action === 'risk_snapshot') {
          return {
            status:'success',
            account:{ currency:'USD', balance:10_000, equity:10_000 },
            instruments:{ XAUUSD:{
              name:'XAUUSD', digits:2, point:0.01, tick_size:0.01, tick_value:1,
              contract_size:100, volume_min:0.01, volume_max:100, volume_step:0.01,
              currency_profit:'USD',
            } },
          }
        }
        return baseImplementation(userId, action, params)
      })
      const result = await handleHistoryCompare(1, {
        symbol:'XAUUSD', model_ids:[10, 20], strategy_id:1,
        start_time:'2026-07-01', end_time:'2026-07-02', sample_size:4,
      })
      expect(result.status).toBe('success')
      expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'symbol_snapshot', { symbol:'XAUUSD' }, expect.objectContaining({ noFallback:true }))
      expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'risk_snapshot', expect.objectContaining({
        symbol:'XAUUSD',
        baseline_from_utc_msc:expect.any(Number),
      }), expect.objectContaining({ noFallback:true }))
      expect(result.meta.account_simulation_status).toBe('ready')
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

  it('exposes admin benchmark set list and generation endpoints', () => {
    expect(routes).toContain("router.get('/ai/model-compare/benchmarks', authMiddleware")
    expect(routes).toContain("router.post('/ai/model-compare/benchmarks', authMiddleware")
    expect(routes).toContain('createClassicBenchmarkSet(req.user.id')
  })

  it('normalizes persisted Beijing DATETIME values before MT5 display', () => {
    const backend = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')
    expect(backend).toContain('function compareJobUtcMs(value)')
    expect(backend).toContain('created_at_utc_msc:compareJobUtcMs(job.created_at)')
    expect(backend).toContain('updated_at_utc_msc:compareJobUtcMs(job.updated_at)')
  })
})

describe('historical comparison execution windows', () => {
  it('includes the M1 candle at the configured holding horizon', () => {
    const decisionTime = Date.UTC(2026, 6, 20, 10, 0, 0)
    const evaluationEnd = decisionTime + 4 * 60 * 60 * 1000

    expect(__historyCompareJobsTest.executionWindows([
      { signal_type:'buy', decision_time_utc_msc:decisionTime },
    ], evaluationEnd, 2)).toEqual([
      { start:decisionTime, end:decisionTime + 2 * 60 * 60 * 1000 + 60_000 },
    ])
  })

  it('does not extend an execution window beyond the selected evaluation range', () => {
    const decisionTime = Date.UTC(2026, 6, 20, 10, 0, 0)
    const evaluationEnd = decisionTime + 90 * 60 * 1000

    expect(__historyCompareJobsTest.executionWindows([
      { signal_type:'sell', decision_time_utc_msc:decisionTime },
    ], evaluationEnd, 2)).toEqual([
      { start:decisionTime, end:evaluationEnd },
    ])
  })
})

describe('historical comparison time range normalization', () => {
  it('converts legacy MT5 wall time to explicit UTC before persisting a job', () => {
    const range = __historyCompareJobsTest.normalizeTimeRange(
      '2026-07-20T18:47:00',
      '2026-07-20T19:47:00',
      180,
      Date.UTC(2026, 6, 20, 17, 0),
    )
    expect(range).toMatchObject({
      startTime:'2026-07-20T15:47:00.000Z',
      endTime:'2026-07-20T16:47:00.000Z',
    })
  })

  it('rejects a stale client that submits an end time in the future', () => {
    expect(() => __historyCompareJobsTest.normalizeTimeRange(
      '2026-07-13T23:47:00',
      '2026-07-20T23:47:00',
      180,
      Date.UTC(2026, 6, 20, 15, 47, 23),
    )).toThrow('history_compare_end_time_in_future')
  })
})

describe('historical comparison frontend contract', () => {
  it('offers a reproducible classic-market source separately from ad-hoc history', () => {
    const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
    expect(html).toContain('name="cmpDataSource" value="benchmark"')
    expect(html).toContain('id="cmpBenchmarkSet"')
    expect(html).toContain('经典行情集')
    expect(frontend).toContain('/api/ai/model-compare/benchmarks')
    expect(frontend).toContain('data_source:dataSource')
    expect(frontend).toContain('约束异常')
  })

  const frontend = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')

  it('polls background jobs and supports cancellation', () => {
    expect(frontend).toContain('/api/ai/model-compare/history/${encodeURIComponent(jobId)}')
    expect(frontend).toContain('{ method:"DELETE" }')
    expect(frontend).not.toContain('showToast(')
    expect(frontend).toContain('formatCompareChartTime(job.created_at_utc_msc, params.timezone_offset_minutes)')
    const backend = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')
    expect(backend).toContain('abort_controller:new AbortController()')
    expect(backend).toContain('job.abort_controller.abort')
    expect(backend).toContain('abortSignal:job.abort_controller.signal')
  })

  it('reattaches to an active background job after reloading the page', () => {
    expect(frontend).toContain('async function monitorHistoryCompareJob')
    expect(frontend).toContain('const activeJob = jobs.find')
    expect(frontend).toContain('void monitorHistoryCompareJob(activeJob.id, activeJob)')
    expect(frontend).toContain('consecutivePollFailures >= 3')
  })

  it('reconciles interrupted jobs and releases terminal in-memory state', () => {
    const backend = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')
    expect(backend).toContain('async function reconcileInterruptedHistoryCompareJobs')
    expect(backend).toContain("stale.error = 'history_compare_interrupted'")
    expect(backend).toContain('historyCompareJobs.delete(job.id)')
  })

  it('uses only fully closed historical candles and ignores live Chan anchors', () => {
    const backend = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')
    expect(backend).toContain('utcMs + evaluationDurationMs <= evaluationCutoffUtcMs')
    expect(backend).toContain('last_bar_closed:true')
    expect(backend).toContain('chan_structure_anchor_utc_msc:null')
    expect(backend).toContain('const exclusiveEnd = boundedEnd < endUtcMs ? boundedEnd + 60_000 : boundedEnd')
  })

  it('uses the strategy run interval as the decision clock while retaining the primary analysis timeframe', () => {
    expect(resolveStrategyEvaluationTimeframe({ interval_minutes:5 }, [
      { timeframe:'H1' }, { timeframe:'M15' }, { timeframe:'M5' }, { timeframe:'H4' },
    ])).toBe('M5')
    expect(resolveStrategyEvaluationTimeframe({ interval_minutes:15 }, [
      { timeframe:'H1' }, { timeframe:'M15' }, { timeframe:'M5' },
    ])).toBe('M15')
  })

  it('presents directional evaluation separately from the event-driven virtual account', () => {
    expect(frontend).toContain('方向准确率')
    expect(frontend).toContain('保留模型原始方向')
    expect(frontend).toContain('抽样账户资金回放')
    expect(frontend).toContain('实盘账户状态、冷却、报价时效和 ATR 风控不参与模型排名')
    expect(frontend).toContain('尚未接入真实逐笔 Tick')
    expect(frontend).toContain('决策周期')
  })

  it('does not invent a leading model when every response holds, no order trades, or scores tie', () => {
    expect(frontend).toContain('本次没有模型给出可评估方向')
    expect(frontend).toContain('本次只有观望或异常响应')
    expect(frontend).toContain('没有形成模拟成交')
    expect(frontend).toContain('订单均未成交')
    expect(frontend).toContain('多个模型的方向质量暂时并列')
    expect(frontend).toContain('directionHasUniqueLeader')
    expect(frontend).toContain('replayHasUniqueLeader')
  })

  it('discloses conservative gap, stop-limit and intrabar margin assumptions', () => {
    expect(frontend).toContain('跳空触发和跳空止损按更差的开盘成交价计算')
    expect(frontend).toContain('挂单在柱内成交时，只采用价格路径能够证明发生在入场后的同柱止盈止损')
    expect(frontend).toContain('Stop Limit 在同柱内无法确认激活与成交顺序时也延后到下一根')
    expect(frontend).toContain('保证金优先采用桥接端 MT5 按账户币种计算的买卖方向快照')
    expect(frontend).toContain('当前 MT5 合约参数快照，并非经纪商当时的历史合约参数')
    expect(frontend).toContain('保证金强平按方向不利的盘中极值进行保守检查')
    expect(frontend).toContain('异常模型不参与排名与一致度计算')
    expect(frontend).toContain('apiErrorMessage(reason)')
    expect(frontend).toContain('simulation.margin_calculation_status')
    expect(frontend).toContain('simulation.margin_calculation_unavailable_count')
    expect(frontend).toContain('未触发 / 同柱待定 / 歧义')
    expect(frontend).toContain('stop_limit_same_bar_deferred_count')
    expect(frontend).toContain('intrabar_entry_exit_deferred_count')
  })

  it('shows commission and MT5-timezone swap accounting separately', () => {
    expect(frontend).toContain('隔夜利息按 MT5 服务器时区跨日计提')
    expect(frontend).toContain('币种无法可靠换算时会明确标记为“部分未计入”')
    expect(frontend).toContain('simulation.total_commission')
    expect(frontend).toContain('simulation.total_swap')
    expect(frontend).toContain('simulation.swap_status === "partial"')
  })

  it('renders an accessible multi-model equity curve with MT5 time tooltips', () => {
    expect(frontend).toContain('data-cmp-equity-chart')
    expect(frontend).toContain('role="img"')
    expect(frontend).toContain('抽样资金曲线')
    expect(frontend).toContain('execution_timezone_offset_minutes')
    expect(frontend).toContain('bindCompareEquityChart(replaySorted, meta)')
  })

  it('supports an explicitly confirmed continuous mode with a hard decision cap', () => {
    expect(frontend).toContain('cmpEvaluationMode')
    expect(frontend).toContain('确认开始连续回测')
    expect(frontend).toContain('evaluation_mode:evaluationMode')
    expect(frontend).toContain('HISTORY_COMPARE_CONTINUOUS_LIMIT = 120')
    expect(frontend).toContain('连续回测资金曲线')
    expect(frontend).toContain('逐根主周期连续决策 + M1 OHLC 执行回放')
  })

  it('confirms sampled comparisons that are expected to make many model requests', () => {
    expect(frontend).toContain('HISTORY_COMPARE_CONFIRM_CALLS = 20')
    expect(frontend).toContain('确认开始高调用量评估')
    expect(frontend).toContain('模型输出需要修复时可能产生额外调用')
    expect(frontend).toContain('estimate.calls >= HISTORY_COMPARE_CONFIRM_CALLS')
  })

  it('shows actual provider usage and a reproducibility fingerprint', () => {
    expect(frontend).toContain('meta.actual_model_calls ?? meta.estimated_model_calls')
    expect(frontend).toContain('meta.repair_model_calls')
    expect(frontend).toContain('meta.model_token_count')
    expect(frontend).toContain('meta.reproducibility?.evidence_sha256')
    expect(frontend).toContain('输入与行情已留指纹')
    expect(frontend).toContain('模型输出具有随机性')
  })

  it('shows localized failure details in recent comparison jobs', () => {
    expect(frontend).toContain('失败原因：${escapeHtml(apiErrorMessage(job.error))}')
    expect(frontend).toContain('所选区间内没有可用的完整历史 K 线')
  })
})
