import { describe, it, expect, vi, beforeEach } from 'vitest'
import { attachAtrAnchor, buildStrategyContextFromTags, resolveChanHistoryCount, __strategyTest } from '../../server/routes/ai/strategy.js'

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
      segment_count: rates[0]?.chan_segment_count ?? (rates.length >= 500 ? 1 : 0),
      center_count: rates[0]?.chan_center_count ?? (rates.length >= 500 ? 1 : 0),
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

  it('已有500根缠论回退数据时不会重复请求500根', async () => {
    const rates = Array.from({ length: 500 }, (_, i) => ({ time: `t${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
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
    mockMt5Bridge.mockResolvedValueOnce({ rates })
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 300 }))
    expect(result.timeframes.H1.klines).toHaveLength(80)
    expect(result.timeframes.H1.klines[0].time).toBe('t220')
  })

  it('300根没有完整线段时仅对该周期自适应补取500根', async () => {
    const rates300 = Array.from({ length: 300 }, (_, i) => ({ time: `a${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    const rates500 = Array.from({ length: 500 }, (_, i) => ({ time: `b${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    mockMt5Bridge.mockResolvedValueOnce({ rates: rates300 }).mockResolvedValueOnce({ rates: rates500 })
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenNthCalledWith(1, 1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 300 }))
    expect(mockMt5Bridge).toHaveBeenNthCalledWith(2, 1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 500 }))
    expect(result.timeframes.H1.klines).toHaveLength(80)
    expect(result.timeframes.H1.klines[0].time).toBe('b420')
  })

  it('300根已有线段但没有中枢时自适应补取500根', async () => {
    const rates300 = Array.from({ length: 300 }, (_, i) => ({
      time: `a${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100',
      chan_segment_count: 2, chan_center_count: 0,
    }))
    const rates500 = Array.from({ length: 500 }, (_, i) => ({ time: `b${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    mockMt5Bridge.mockResolvedValueOnce({ rates: rates300 }).mockResolvedValueOnce({ rates: rates500 })
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenNthCalledWith(1, 1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 300 }))
    expect(mockMt5Bridge).toHaveBeenNthCalledWith(2, 1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 500 }))
    expect(result.timeframes.H1.klines).toHaveLength(80)
    expect(result.timeframes.H1.klines[0].time).toBe('b420')
  })

  it('某品种周期补取过500根后下轮直接请求500根', async () => {
    const rates300 = Array.from({ length: 300 }, (_, i) => ({ time: `a${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    const rates500 = Array.from({ length: 500 }, (_, i) => ({ time: `b${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    mockMt5Bridge.mockResolvedValueOnce({ rates: rates300 }).mockResolvedValue({ rates: rates500 })
    const args = [1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual']
    await buildStrategyContextFromTags(...args)
    expect(resolveChanHistoryCount(1, 'XAUUSD', 'H1', 80, true)).toBe(500)
    mockMt5Bridge.mockClear()
    await buildStrategyContextFromTags(...args)
    expect(mockMt5Bridge).toHaveBeenCalledTimes(1)
    expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 500 }))
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
