import { describe, it, expect, vi, beforeEach } from 'vitest'
import { attachAtrAnchor, buildChanTimeframeAlignment, buildStrategyContextFromTags, resolveChanHistoryCount, __strategyTest } from '../../server/routes/ai/strategy.js'

const mockMt5Bridge = vi.fn()
vi.mock('../../server/routes/ai/market-data.js', () => ({
  mt5Bridge: (...args) => mockMt5Bridge(...args),
  platformRates: (userId, params) => mockMt5Bridge(userId, 'rates', params),
  computeAtr14: vi.fn(() => 12),
  calculateMarketData: vi.fn((symbol, timeframe, rates, _account, _positions, options = {}) => ({
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
    kline_count: rates.length, positions: { total_positions: 0, details: [] },
    account: { balance: 10000, equity: 10500 },
    ...(options.computeChan ? { chan: {
      segment_count: rates[0]?.chan_segment_count ?? (rates.length >= 1000 ? 1 : 0),
      center_count: rates[0]?.chan_center_count ?? (rates.length >= 1000 ? 1 : 0),
    } } : {}),
  })),
}))

describe('buildStrategyContextFromTags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __strategyTest.clearChanHistoryHints()
    mockMt5Bridge.mockResolvedValue({ rates: Array(100).fill({ time: '2026-01-01', open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }) })
  })

  it('解析标签并构建策略上下文', async () => {
    const prompt = '分析 {{MTF:M5:100}} {{MTF:H1:80}}'
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], prompt, 'M5', [], 'manual'
    )
    expect(result.strategy_sequence).toContain('M5')
    expect(result.required_timeframes).toContain('M5')
    expect(result.timeframes).toHaveProperty('M5')
    expect(result.timeframes).toHaveProperty('H1')
  })

  it('无标签时使用 fallback', async () => {
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '', 'M5', [], 'manual'
    )
    expect(result.timeframes).toHaveProperty('M5')
  })

  it('使用已有数据时跳过 Bridge 调用', async () => {
    const rates = Array(100).fill({ time: '2026-01-01', open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' })
    const prompt = '分析 {{MTF:M5:100}}'
    await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], prompt, 'M5', rates, 'manual'
    )
    expect(mockMt5Bridge).not.toHaveBeenCalled()
  })

  it('已有1000根缠论回退数据时不会重复请求1000根', async () => {
    const rates = Array.from({ length: 1000 }, (_, i) => ({ time: `t${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'H1', rates, 'manual'
    )
    expect(mockMt5Bridge).not.toHaveBeenCalled()
  })

  it('时间框架数据通过 Bridge 获取', async () => {
    const prompt = '分析 {{MTF:H1:80}}'
    await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], prompt, 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ timeframe: 'H1' }))
  })

  it('缠论使用扩展历史但模型K线保持标签数量', async () => {
    const rates = Array.from({ length: 300 }, (_, i) => ({ time: `t${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    const extended = Array.from({ length: 1000 }, (_, i) => ({ time: `e${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    mockMt5Bridge.mockResolvedValueOnce({ rates }).mockResolvedValueOnce({ rates: extended })
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 300 }))
    expect(result.timeframes.H1.klines).toHaveLength(80)
    expect(result.timeframes.H1.klines[0].time).toBe('e920')
    expect(result.visualization_klines.H1).toHaveLength(1000)
    expect(result.visualization_klines.H1[0].time).toBe('e0')
    expect(JSON.stringify(result)).not.toContain('visualization_klines')
  })

  it('300根没有完整线段时仅对该周期自适应补取1000根', async () => {
    const rates300 = Array.from({ length: 300 }, (_, i) => ({ time: `a${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    const rates1000 = Array.from({ length: 1000 }, (_, i) => ({ time: `b${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    mockMt5Bridge.mockResolvedValueOnce({ rates: rates300 }).mockResolvedValueOnce({ rates: rates1000 })
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenNthCalledWith(1, 1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 300 }))
    expect(mockMt5Bridge).toHaveBeenNthCalledWith(2, 1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 1000 }))
    expect(result.timeframes.H1.klines).toHaveLength(80)
    expect(result.timeframes.H1.klines[0].time).toBe('b920')
    expect(result.visualization_klines.H1).toHaveLength(1000)
  })

  it('300根已有线段但没有中枢时自适应补取1000根', async () => {
    const rates300 = Array.from({ length: 300 }, (_, i) => ({
      time: `a${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100',
      chan_segment_count: 2, chan_center_count: 0,
    }))
    const rates1000 = Array.from({ length: 1000 }, (_, i) => ({ time: `b${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    mockMt5Bridge.mockResolvedValueOnce({ rates: rates300 }).mockResolvedValueOnce({ rates: rates1000 })
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenNthCalledWith(1, 1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 300 }))
    expect(mockMt5Bridge).toHaveBeenNthCalledWith(2, 1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 1000 }))
    expect(result.timeframes.H1.klines).toHaveLength(80)
    expect(result.timeframes.H1.klines[0].time).toBe('b920')
  })

  it('某品种周期补取过1000根后下轮直接请求1000根', async () => {
    const rates300 = Array.from({ length: 300 }, (_, i) => ({ time: `a${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    const rates1000 = Array.from({ length: 1000 }, (_, i) => ({ time: `b${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    mockMt5Bridge.mockResolvedValueOnce({ rates: rates300 }).mockResolvedValue({ rates: rates1000 })
    const args = [1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual']
    await buildStrategyContextFromTags(...args)
    expect(resolveChanHistoryCount(1, 'XAUUSD', 'H1', 80, true)).toBe(1000)
    mockMt5Bridge.mockClear()
    await buildStrategyContextFromTags(...args)
    expect(mockMt5Bridge).toHaveBeenCalledTimes(1)
    expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 1000 }))
  })
  it('reports missing timeframes as a partial strategy context', async () => {
    const fallbackRates = Array.from({ length: 100 }, (_, i) => ({
      time: `m${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100',
    }))
    mockMt5Bridge.mockResolvedValue({ status: 'error', rates: [] })
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], 'analyze {{MTF:M5:100}} {{MTF:H1:80}}', 'M5', fallbackRates, 'manual'
    )
    expect(result).toMatchObject({
      context_status: 'partial',
      required_timeframes: ['M5', 'H1'],
      used_timeframes: ['M5'],
      missing_timeframes: ['H1'],
    })
    expect(result.timeframes).toHaveProperty('M5')
    expect(result.timeframes).not.toHaveProperty('H1')
  })
})

describe('buildChanTimeframeAlignment', () => {
  const frame = (reliability, direction, state, entryCandidates = []) => ({
    summary: { chan: {
      reliability,
      trend_state: { direction, state, phase: state.includes('trend') ? 'trend' : 'breakout', reversal_bias: 'none' },
      entry_candidates: entryCandidates,
    } },
  })

  it('reports aligned higher and execution timeframes', () => {
    const result = buildChanTimeframeAlignment({
      H4: frame('high', 'up', 'uptrend'),
      H1: frame('medium', 'up', 'upward_breakout'),
      M15: frame('medium', 'up', 'structural_rise', [{ type: 'third_buy', side: 'buy', usable_for_entry: true }]),
    }, 'H1')
    expect(result).toMatchObject({
      status: 'complete', higher_timeframe: 'H4', higher_timeframe_direction: 'up',
      agreement: 'aligned_up', direction: 'up', conflict: false, execution_policy: 'evidence_only',
    })
    expect(result.entry_candidates[0]).toMatchObject({ timeframe: 'M15', alignment_with_higher: 'aligned' })
  })

  it('marks opposing reliable timeframes and entry evidence as conflicted', () => {
    const result = buildChanTimeframeAlignment({
      H4: frame('high', 'down', 'downtrend'),
      M15: frame('medium', 'up', 'upward_breakout', [{ type: 'first_buy', side: 'buy', usable_for_entry: true }]),
      M5: frame('low', 'up', 'structural_rise'),
    }, 'M15', 'partial')
    expect(result).toMatchObject({ status: 'partial', agreement: 'mixed', conflict: true })
    expect(result.excluded_low_reliability_timeframes).toEqual(['M5'])
    expect(result.entry_candidates[0].alignment_with_higher).toBe('conflict')
  })

  it('safely ignores legacy Chan payloads without trend state', () => {
    const result = buildChanTimeframeAlignment({ H1: { summary: { chan: { reliability: 'high' } } } }, 'H1')
    expect(result).toMatchObject({ status: 'unavailable', agreement: 'insufficient', execution_policy: 'evidence_only' })
  })

  it('does not promote an all-low-reliability structure to higher-timeframe bias', () => {
    const result = buildChanTimeframeAlignment({
      H4: frame('low', 'up', 'structural_rise', [{ type: 'first_buy', side: 'buy', usable_for_entry: false }]),
    }, 'H4')
    expect(result).toMatchObject({
      higher_timeframe: 'H4', higher_timeframe_direction: 'neutral', higher_timeframe_phase: 'unknown',
      agreement: 'insufficient', direction: 'neutral',
    })
    expect(result.entry_candidates[0].alignment_with_higher).toBe('unconfirmed')
  })
})

describe('attachAtrAnchor', () => {
  beforeEach(() => vi.clearAllMocks())

  it('按H1、H4优先级复用已收盘ATR', async () => {
    const market = { atr_14: 3, strategy_context: { timeframes: { H4: { summary: { atr_14_closed: 20 } }, H1: { summary: { atr_14: 99, atr_14_closed: 15 } } } } }
    await attachAtrAnchor(1, 'XAUUSD', market, 'M5')
    expect(market).toMatchObject({ atr_anchor: 15, atr_anchor_tf: 'H1' })
    expect(mockMt5Bridge).not.toHaveBeenCalled()
  })

  it('上下文没有锚点周期时主动获取H1', async () => {
    mockMt5Bridge.mockResolvedValue({ rates: Array(50).fill({ high: 10, low: 5, close: 8 }) })
    const market = { atr_14: 3, strategy_context: { timeframes: { M5: { summary: { atr_14: 3 } } } } }
    await attachAtrAnchor(1, 'XAUUSD', market, 'M5')
    expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'rates', { symbol: 'XAUUSD', timeframe: 'H1', count: 50 })
    expect(market).toMatchObject({ atr_anchor: 12, atr_anchor_tf: 'H1' })
  })

  it('不会退回短周期ATR', async () => {
    mockMt5Bridge.mockResolvedValue({ rates: [] })
    const market = { atr_14: 3, strategy_context: { timeframes: { M5: { summary: { atr_14_closed: 3 } }, M15: { summary: { atr_14_closed: 6 } } } } }
    await attachAtrAnchor(1, 'XAUUSD', market, 'M5')
    expect(market).toMatchObject({ atr_anchor: 0, atr_anchor_tf: null })
  })
})
