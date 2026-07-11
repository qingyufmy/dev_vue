import { describe, it, expect } from 'vitest'
import { calculateMarketData, __chanTest } from '../../server/routes/ai/market-data.js'

describe('calculateMarketData', () => {
  const baseAccount = { balance: 10000, equity: 10500 }
  const basePositions = [
    { ticket: 1, symbol: 'XAUUSD', type: 'buy', volume: 0.03, open_price: 1990, price_current: 2000, profit: 30, sl: 1980, tp: 2020 }
  ]

  function generateRates(n, startPrice = 2000) {
    const rates = []
    for (let i = 0; i < n; i++) {
      const variation = Math.sin(i * 0.1) * 10
      rates.push({
        time: `2026-01-01 ${String(i).padStart(2, '0')}:00:00`,
        open: String(startPrice + variation - 2),
        high: String(startPrice + variation + 5),
        low: String(startPrice + variation - 5),
        close: String(startPrice + variation),
        tick_volume: String(100 + Math.floor(Math.random() * 50))
      })
    }
    return rates
  }

  it('返回基本字段', () => {
    const rates = generateRates(50)
    const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, basePositions)
    expect(result.symbol).toBe('XAUUSD')
    expect(result.timeframe).toBe('M5')
    expect(result.latest_price).toBeTruthy()
    expect(result.kline_count).toBe(50)
  })

  it('计算技术指标', () => {
    const rates = generateRates(100)
    const result = calculateMarketData('XAUUSD', 'H1', rates, baseAccount, basePositions)
    expect(result.sma_20).toBeTruthy()
    expect(result.sma_50).toBeTruthy()
    expect(result.ema_12).toBeTruthy()
    expect(result.ema_26).toBeTruthy()
    expect(result.rsi_14).toBeGreaterThanOrEqual(0)
    expect(result.rsi_14).toBeLessThanOrEqual(100)
    expect(result.atr_14).toBeGreaterThanOrEqual(0)
  })

  it('扩展缠论历史不会改变普通指标窗口', () => {
    const history = generateRates(300)
    const visible = history.slice(-80)
    const baseline = calculateMarketData('XAUUSD', 'H1', visible, baseAccount, basePositions)
    const withChan = calculateMarketData('XAUUSD', 'H1', visible, baseAccount, basePositions, {
      computeChan: true,
      chanRates: history,
      requestedChanHistoryCount: 300,
    })
    expect(withChan.kline_count).toBe(80)
    expect(withChan.price_change).toBe(baseline.price_change)
    expect(withChan.price_change_pct).toBe(baseline.price_change_pct)
    expect(withChan.avg_volatility).toBe(baseline.avg_volatility)
    expect(withChan.volume).toEqual(baseline.volume)
    expect(withChan.chan.received_history_count).toBe(300)
  })

  it('计算 MACD', () => {
    const rates = generateRates(50)
    const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, basePositions)
    expect(result.macd).toBeTruthy()
    expect(result.macd.line).toBeTruthy()
    expect(result.macd.signal).toBeTruthy()
    expect(result.macd.histogram).toBeTruthy()
    expect(['bullish', 'bearish', 'neutral']).toContain(result.macd.trend)
  })

  it('计算布林带', () => {
    const rates = generateRates(50)
    const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, basePositions)
    expect(result.bollinger).toBeTruthy()
    expect(result.bollinger.upper).toBeGreaterThan(result.bollinger.lower)
    expect(result.bollinger.position).toBeGreaterThanOrEqual(0)
    expect(result.bollinger.position).toBeLessThanOrEqual(1)
  })

  it('计算支撑阻力', () => {
    const rates = generateRates(50)
    const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, basePositions)
    expect(result.support_resistance).toBeTruthy()
    expect(result.support_resistance.r1).toBeGreaterThan(result.support_resistance.s1)
    expect(result.support_resistance.r2).toBeGreaterThan(result.support_resistance.r1)
  })

  it('计算 K 线形态', () => {
    const rates = generateRates(50)
    const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, basePositions)
    expect(result.kline_patterns).toBeTruthy()
    expect(result.kline_patterns.last_candle).toBeTruthy()
    expect(typeof result.kline_patterns.last_candle.is_doji).toBe('boolean')
  })

  it('计算成交量', () => {
    const rates = generateRates(50)
    const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, basePositions)
    expect(result.volume).toBeTruthy()
    expect(result.volume.current).toBeGreaterThanOrEqual(0)
    expect(result.volume.average).toBeGreaterThan(0)
    expect(result.volume.ratio).toBeGreaterThan(0)
  })

  it('计算策略评分', () => {
    const rates = generateRates(50)
    const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, basePositions)
    expect(result.strategy_score).toBeTruthy()
    expect(result.strategy_score.trend_strength).toBeGreaterThanOrEqual(0)
    expect(result.strategy_score.trend_strength).toBeLessThanOrEqual(1)
    expect([-1, 0, 1]).toContain(result.strategy_score.momentum_alignment)
  })

  it('计算持仓信息', () => {
    const rates = generateRates(50)
    const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, basePositions)
    expect(result.positions).toBeTruthy()
    expect(result.positions.total_positions).toBe(1)
    expect(result.positions.long_positions).toBe(1)
    expect(result.positions.short_positions).toBe(0)
    expect(result.positions.details[0].ticket).toBe(1)
  })

  it('无持仓时返回空', () => {
    const rates = generateRates(50)
    const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, [])
    expect(result.positions.total_positions).toBe(0)
    expect(result.positions.details).toEqual([])
  })

  it('无账户信息时返回 null', () => {
    const rates = generateRates(50)
    const result = calculateMarketData('XAUUSD', 'M5', rates, null, [])
    expect(result.account).toBe(null)
  })

  it('价格变化百分比计算正确', () => {
    const rates = generateRates(50, 2000)
    const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, basePositions)
    expect(typeof result.price_change_pct).toBe('number')
  })

  it('波动率计算', () => {
    const rates = generateRates(50)
    const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, basePositions)
    expect(result.volatility_pct).toBeGreaterThanOrEqual(0)
    expect(result.avg_volatility).toBeGreaterThanOrEqual(0)
  })

  it('MACD输出line/signal/histogram来自同一套序列', () => {
    const rates = generateRates(80)
    const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, basePositions)
    const series = __chanTest.calculateMacdSeries(rates.map(r => parseFloat(r.close)))
    expect(result.macd.line).toBeCloseTo(series.latestDif, 5)
    expect(result.macd.signal).toBeCloseTo(series.latestDea, 5)
    expect(result.macd.histogram).toBeCloseTo(series.latestHist, 5)
    expect(Math.abs((result.macd.line - result.macd.signal) - result.macd.histogram)).toBeLessThan(0.00002)
  })
})
