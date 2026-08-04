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
  prepareStrategyPolicyRuntime: vi.fn(() => null),
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
  CHAN_MAX_HISTORY_COUNT: 2000,
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

const mockResolveModelSnapshotSelection = vi.fn()
vi.mock('../../server/routes/ai/model-snapshot-samples.js', () => ({
  resolveModelSnapshotSelection: (...args) => mockResolveModelSnapshotSelection(...args),
}))

import {
  __historyCompareJobsTest,
  handleAnalyzeCompare,
  handleHistoryCompare,
  resolveStrategyEvaluationTimeframe,
  startHistoryCompareJobs,
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

  describe('durable live comparison boundary', () => {
    it('returns the committed result for a duplicate request without calling providers again', async () => {
      const committed = { ok:true, results:[{ model_id:10, status:'success' }], models:{}, market_snapshot:{ symbol:'XAUUSD' } }
      mockQueryRun.mockRejectedValueOnce(Object.assign(new Error('Duplicate entry'), { code:'ER_DUP_ENTRY' }))
      mockQueryOne.mockResolvedValueOnce({ status:'succeeded', result_json:JSON.stringify(committed) })
      const result = await handleAnalyzeCompare(1, {
        symbol:'XAUUSD', model_ids:[10, 20], strategy_id:1, request_id:'same-live-request',
      })
      expect(result).toEqual(committed)
      expect(maybeAiSignal).not.toHaveBeenCalled()
    })

    it('marks an interrupted live comparison unknown instead of replaying it as history', async () => {
      mockQueryRun.mockResolvedValue({ affectedRows:1 })
      mockQueryAll.mockResolvedValue([])
      await startHistoryCompareJobs()
      expect(mockQueryRun).toHaveBeenCalledWith(expect.stringContaining("live_compare_status_unknown_after_restart"))
      expect(mockQueryAll).toHaveBeenCalledWith(expect.stringContaining("<> 'live'"))
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
  const mockAdminWithTerminalClock = () => {
    mockQueryOne.mockImplementation(async sql => String(sql).includes('timezone_offset_minutes')
      ? { timezone_offset_minutes:180, clock_status:'progressing_tick' }
      : { role:'admin' })
  }

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
      mockAdminWithTerminalClock()
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
      mockAdminWithTerminalClock()
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

    it('uses the verified terminal clock instead of a client-supplied timezone', async () => {
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
      expect(utc3Start).toBe(utc8Start)
    })
  })

  describe('historical inference', () => {
    beforeEach(() => {
      mockAdminWithTerminalClock()
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

    it('restores completed model-step checkpoints without issuing another provider request', async () => {
      let manifest = null
      const checkpoints = []
      const params = {
        symbol:'XAUUSD', model_ids:[10, 20], strategy_id:1,
        start_time:'2026-07-01', end_time:'2026-07-02', step:25,
      }
      const first = await handleHistoryCompare(1, params, {
        onCheckpointManifest: value => { manifest = value },
        onCheckpoint: value => { checkpoints.push(value) },
      })
      expect(first.status).toBe('success')
      expect(manifest).toMatchObject({
        version:1,
        strategy_version:1,
        strategy_fingerprint:expect.any(String),
        prompt_hash:expect.any(String),
        model_config_fingerprint:expect.any(String),
        output_contract_hash:expect.any(String),
        market_evidence_hash:expect.any(String),
        manifest_fingerprint:expect.any(String),
      })
      expect(checkpoints.filter(item => item.checkpoint_status === 'completed'))
        .toHaveLength(first.meta.evaluation_count * 2)

      maybeAiSignal.mockClear()
      const resumed = await handleHistoryCompare(1, params, {
        checkpointManifest:manifest,
        checkpoints,
      })
      expect(resumed.status).toBe('success')
      expect(maybeAiSignal).not.toHaveBeenCalled()
      expect(resumed.results).toEqual(first.results)
    })

    it('rejects a checkpoint when the frozen source manifest changes', async () => {
      let manifest = null
      const checkpoints = []
      const params = {
        symbol:'XAUUSD', model_ids:[10, 20], strategy_id:1,
        start_time:'2026-07-01', end_time:'2026-07-02', step:25,
      }
      await handleHistoryCompare(1, params, {
        onCheckpointManifest: value => { manifest = value },
        onCheckpoint: value => { checkpoints.push(value) },
      })
      const changed = { ...manifest, prompt_hash:'changed-prompt-hash', manifest_fingerprint:'stale' }
      maybeAiSignal.mockClear()
      const result = await handleHistoryCompare(1, params, {
        checkpointManifest:changed,
        checkpoints,
      })
      expect(result).toEqual({ status:'error', message:'history_compare_checkpoint_source_stale' })
      expect(maybeAiSignal).not.toHaveBeenCalled()
    })

    it('fails closed when a provider submission checkpoint is still unresolved', async () => {
      let manifest = null
      const checkpoints = []
      const params = {
        symbol:'XAUUSD', model_ids:[10, 20], strategy_id:1,
        start_time:'2026-07-01', end_time:'2026-07-02', step:25,
      }
      await handleHistoryCompare(1, params, {
        onCheckpointManifest: value => { manifest = value },
        onCheckpoint: value => { checkpoints.push(value) },
      })
      const submitting = checkpoints.find(item => item.checkpoint_status === 'submitting')
      expect(submitting).toBeTruthy()
      maybeAiSignal.mockClear()
      const result = await handleHistoryCompare(1, params, {
        checkpointManifest:manifest,
        checkpoints:[submitting],
      })
      expect(result).toEqual({ status:'error', message:'history_compare_status_unknown' })
      expect(maybeAiSignal).not.toHaveBeenCalled()
    })

    it('replays the exact stored prompts for selected closed-trade snapshots', async () => {
      mockGetStrategyById.mockResolvedValueOnce({
        id:1, scope:'platform', symbols_json:'["XAUUSD"]', system_prompt:'current-v5-prompt',
        version:5, include_portfolio_context:0, interval_minutes:30,
      })
      const samples = [0, 1].map(index => ({
        snapshot_id:101 + index,
        signal_id:501 + index,
        strategy_id:1,
        strategy_version:4,
        symbol:'XAUUSD',
        output_schema_version:'schema-v4',
        strategy_scope:'private',
        system_prompt:`stored-system-${index}\nentry_method 只允许 stop_limit`,
        user_prompt:JSON.stringify({ strategy_context:{ timeframes:{
          M5:{ klines:Array(60).fill({ close:2000 }) },
          H1:{ klines:Array(40).fill({ close:2000 }) },
        } } }),
        prompt_hash:`prompt-${index}`,
        content_hash:`content-${index}`,
        signal_created_at:index ? '2026-07-01 08:45:00' : '2026-07-01 08:15:00',
        market_snapshot:{
          symbol:'XAUUSD', timeframe:'H1', primary_timeframe:'H1', latest_price:2000 + index,
          strategy_context:{ chan_structures:{ M5:{ status:'ok' } } },
        },
        klines:{ M5:[{
          time:new Date(Date.UTC(2026, 6, 1, 0, index * 30)).toISOString(),
          open:2000, high:2010, low:1990, close:2005,
        }], H1:[{
          time:new Date(Date.UTC(2026, 6, 1, 0, 0)).toISOString(),
          open:2000, high:2010, low:1990, close:2005,
        }] },
        original_signal_type:'buy',
        net_profit:index ? -10 : 20,
      }))
      mockResolveModelSnapshotSelection.mockResolvedValue({
        samples,
        snapshot_ids:[101, 102],
        strategy_id:1,
        strategy_version:4,
        symbol:'XAUUSD',
        output_schema_version:'schema-v4',
        fingerprint:'selection-hash',
      })

      const result = await handleHistoryCompare(1, {
        symbol:'XAUUSD', model_ids:[10, 20], strategy_id:1,
        data_source:'snapshots', snapshot_ids:[101, 102],
      })

      expect(result.status).toBe('success')
      expect(result.meta.data_source).toBe('snapshots')
      expect(result.meta.snapshot_selection.snapshot_ids).toEqual([101, 102])
      expect(result.meta.reproducibility.strategy.strategy_version).toBe(4)
      expect(result.meta.reproducibility.evaluator_strategy.strategy_version).toBe(4)
      expect(result.meta.evaluation_timeframe).toBe('M5')
      expect(result.results[0].signals[0].decision_time_utc_msc).toBe(Date.UTC(2026, 6, 1, 0, 15))
      expect(maybeAiSignal).toHaveBeenCalledWith(null, expect.objectContaining({
        _comparison_replay_system_prompt:'stored-system-0\nentry_method 只允许 stop_limit',
        _comparison_replay_user_prompt:samples[0].user_prompt,
        _comparison_replay_output_schema_version:'schema-v4',
        _allowed_entry_methods:['stop_limit'],
        _market_data_plan:{
          primary_timeframe:'H1',
          timeframes:[
            { timeframe:'M5', kline_count:60 },
            { timeframe:'H1', kline_count:40 },
          ],
        },
        _use_chan_analysis:true,
        _market_only:false,
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
        executable_count:0, output_compliance_rate:0, average_confidence:80,
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
        run_version:'history-compare-v7',
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

  it('exposes the admin historical-snapshot selection endpoint', () => {
    expect(routes).toContain("router.get('/ai/model-compare/snapshots', authMiddleware")
    expect(routes).toContain('listModelSnapshotSamples(req.user.id')
  })

  it('normalizes persisted Beijing DATETIME values before MT5 display', () => {
    const backend = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')
    expect(backend).toContain('function compareJobUtcMs(value)')
    expect(backend).toContain('created_at_utc_msc:compareJobUtcMs(job.created_at)')
    expect(backend).toContain('updated_at_utc_msc:compareJobUtcMs(job.updated_at)')
  })
})

describe('historical comparison execution windows', () => {
  it('uses the persisted inference instant and aligns only the next evaluation candle', () => {
    const point = __historyCompareJobsTest.snapshotDecisionPoint({
      signal_created_at:'2026-07-20 10:15:07',
      klines:{ H1:[{ time:'2026-07-20 05:00:00' }] },
    }, 'M5', 180)
    expect(point).toEqual({
      decisionUtcMs:Date.UTC(2026, 6, 20, 2, 15, 7),
      outcomeOpenUtcMs:Date.UTC(2026, 6, 20, 2, 20),
      timeframe:'M5',
    })
  })

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
  const aiHtml = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
  const aiFrontend = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
  const adminFrontend = readFileSync(new URL('../../public/admin/app.js', import.meta.url), 'utf8')
  const adminRoutes = readFileSync(new URL('../../server/routes/admin-console.js', import.meta.url), 'utf8')

  it('retires the duplicate AI-laboratory evaluation workspace', () => {
    expect(aiHtml).not.toContain('id="model-compare"')
    expect(aiHtml).not.toContain('id="cmpSnapshotList"')
    expect(aiFrontend).not.toContain('/api/ai/model-compare/snapshots')
    expect(aiFrontend).not.toContain('async function loadModelCompare()')
  })

  it('hosts model evaluation in the unified administrator workbench', () => {
    expect(adminFrontend).toContain('data-ai-tab="model-compare"')
    expect(adminFrontend).toContain('/api/admin/ai/model-compare/setup')
    expect(adminFrontend).toContain('/api/admin/ai/model-compare/snapshots?')
    expect(adminFrontend).toContain("api('/api/admin/ai/model-compare/jobs'")
    expect(adminFrontend).toContain('至少 2 条；一次评测只能使用同一策略版本')
    expect(adminRoutes).toContain("router.get('/admin/ai/model-compare/setup'")
    expect(adminRoutes).toContain("router.post('/admin/ai/model-compare/jobs'")
    expect(adminRoutes).toContain("router.delete('/admin/ai/model-compare/jobs/:jobId'")
  })

  it('keeps background reconciliation and cancellation in the authoritative backend', () => {
    const backend = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')
    expect(backend).toContain('async function reconcileInterruptedHistoryCompareJobs')
    expect(backend).toContain('queueHistoryCompareJob(stale)')
    expect(backend).toContain("history_compare_checkpoint_source_stale")
    expect(backend).not.toContain("stale.error = 'history_compare_interrupted'")
    expect(backend).toContain('abort_controller:new AbortController()')
    expect(backend).toContain('job.abort_controller.abort')
    expect(backend).toContain('historyCompareJobs.delete(job.id)')
  })

  it('keeps the optional manual-task transaction fence before ai_signals insertion', () => {
    const backend = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')
    const fence = backend.indexOf('await options.assertCanApplyTx?.(run)')
    const insert = backend.indexOf('INSERT INTO ai_signals')
    expect(fence).toBeGreaterThanOrEqual(0)
    expect(insert).toBeGreaterThan(fence)
  })

  it('deletes comparison checkpoints and their terminal job atomically', () => {
    const backend = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')
    const start = backend.indexOf('export async function deleteHistoryCompareJob')
    const section = backend.slice(start, backend.indexOf('export const __historyCompareJobsTest', start))
    expect(section).toContain('await withTransaction(async run =>')
    expect(section.indexOf('DELETE FROM ai_model_compare_checkpoints'))
      .toBeLessThan(section.indexOf('DELETE FROM ai_model_compare_jobs'))
    expect(section).not.toContain('result?.changes')
  })

  it('uses only fully closed candles and preserves the strategy decision clock', () => {
    const backend = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')
    expect(backend).toContain('utcMs + evaluationDurationMs <= evaluationCutoffUtcMs')
    expect(backend).toContain('last_bar_closed:true')
    expect(backend).toContain('chan_structure_anchor_utc_msc:null')
    expect(resolveStrategyEvaluationTimeframe({ interval_minutes:5 }, [
      { timeframe:'H1' }, { timeframe:'M15' }, { timeframe:'M5' }, { timeframe:'H4' },
    ])).toBe('M5')
  })
})
