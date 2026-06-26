import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildStrategyContextFromTags } from '../../server/routes/ai/strategy.js'

const mockMt5Bridge = vi.fn()
vi.mock('../../server/routes/ai/market-data.js', () => ({
  mt5Bridge: (...args) => mockMt5Bridge(...args),
  calculateMarketData: vi.fn(() => ({
    symbol: 'XAUUSD', timeframe: 'M5',
    latest_price: 2000, price_change: 10, price_change_pct: 0.5,
    sma_20: 1995, sma_50: 1990, ema_12: 1998, ema_26: 1992,
    atr_14: 10, volatility_pct: 0.3,
    macd: { line: 5, signal: 3, histogram: 2, trend: 'bullish' },
    rsi_14: 55, bollinger: { upper: 2010, lower: 1990, width: 20, position: 0.5 },
    support_resistance: { pivot: 2000, r1: 2005, s1: 1995 },
    kline_patterns: { last_candle: { is_doji: false } },
    volume: { current: 100, average: 80, ratio: 1.25 },
    strategy_score: { trend_strength: 0.6, momentum_alignment: 1, data_confidence: 0.7 },
    kline_count: 100, positions: { total_positions: 0, details: [] },
    account: { balance: 10000, equity: 10500 },
  })),
}))

describe('buildStrategyContextFromTags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('时间框架数据通过 Bridge 获取', async () => {
    const prompt = '分析 {{MTF:H1:80}}'
    await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], prompt, 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ timeframe: 'H1' }))
  })
})
