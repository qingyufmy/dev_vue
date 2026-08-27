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

  it('freezes versioned continuity policy evidence in the timeframe summary', () => {
    const result = calculateMarketData('XAUUSD', 'M5', generateRates(50), baseAccount, basePositions, {
      chanDataQuality:{
        source_id:17, source_key:'mt5|broker-demo|9001', platform:'mt5',
        broker_server:'Broker-Demo', account_login:'9001',
        clock_status:'verified', cache_internal_gap_unresolved:false,
        continuity_engine_version:'market-session-policy-engine-v1',
        continuity_policy_id:'broker-metals', continuity_policy_version:3,
        continuity_policy_hash:'a'.repeat(64), continuity_policy_match:true,
        continuity_policy_mode:'audit', continuity_status:'reliable',
        closure_components:[{ kind:'daily_maintenance', reason:'daily_maintenance' }],
        uncovered_ranges:[], expected_closures:[], last_bar_closed:true,
      },
    })
    expect(result.market_data_quality).toMatchObject({
      continuity_engine_version:'market-session-policy-engine-v1',
      source_id:17, source_key:'mt5|broker-demo|9001', platform:'mt5',
      broker_server:'Broker-Demo', account_login:'9001',
      continuity_policy_id:'broker-metals', continuity_policy_version:3,
      continuity_policy_hash:'a'.repeat(64), continuity_policy_match:true,
      continuity_policy_mode:'audit', continuity_status:'reliable',
      closure_components:[{ kind:'daily_maintenance', reason:'daily_maintenance' }],
    })
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
    expect(result.atr_14_closed).toBeGreaterThanOrEqual(0)
  })

  it('已收盘ATR不受最后一根实时K线变化影响', () => {
    const rates = generateRates(50)
    const changed = rates.map(rate => ({ ...rate }))
    changed[changed.length - 1] = { ...changed[changed.length - 1], high: '9999', low: '1', close: '5000' }
    const baseline = calculateMarketData('XAUUSD', 'H1', rates, baseAccount, basePositions)
    const liveChanged = calculateMarketData('XAUUSD', 'H1', changed, baseAccount, basePositions)
    expect(liveChanged.atr_14_closed).toBe(baseline.atr_14_closed)
    expect(liveChanged.atr_14).not.toBe(baseline.atr_14)
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

  it('freezes one breakout reference before two different closed confirmation bars', () => {
    const rates = Array.from({ length:22 }, (_, index) => ({
      time:`2026-01-01 00:${String(index).padStart(2, '0')}:00`,
      time_utc_msc:1_800_000_000_000 + index * 60_000,
      open:100, high:index < 20 ? 110 : index === 20 ? 121 : 125,
      low:index === 21 ? 120 : 90, close:index < 20 ? 100 : index === 20 ? 120 : 124,
      tick_volume:100,
    }))
    const result = calculateMarketData('XAUUSD', 'M15', rates, baseAccount, [], {
      chanDataQuality:{ last_bar_closed:true },
    })
    expect(result.support_resistance.two_closed_bar_breakout).toMatchObject({
      ready:true,
      reference_high:110,
      reference_excludes_last_closed_bars:2,
      up:{ first_close_beyond:true, second_close_beyond:true, complete:true, confirmation_type:'continuation' },
      down:{ complete:false },
      recent_confirmed:{
        up:{ found:true, complete:true, age_closed_bars:0, reference_high:110, reference_low:90, still_valid:true, invalidation_bar:null },
        down:{ found:false, complete:false },
      },
    })
  })

  it.each([1, 2, 3])('keeps the latest confirmed event observable for age %i after the current window rolls forward', age => {
    const rates = Array.from({ length:22 }, (_, index) => ({
      time:`2026-01-01 00:${String(index).padStart(2, '0')}:00`,
      time_utc_msc:1_800_000_000_000 + index * 60_000,
      open:100,
      high:index < 20 ? 110 : index === 20 ? 121 : 125,
      low:index === 21 ? 120 : 90,
      close:index < 20 ? 100 : index === 20 ? 120 : 124,
      tick_volume:100,
    }))
    const laterRates = rates.concat([115, 116, 117].slice(0, age).map((close, offset) => ({
      time:`2026-01-01 00:${String(22 + offset).padStart(2, '0')}:00`,
      time_utc_msc:1_800_000_000_000 + (22 + offset) * 60_000,
      open:115, high:118, low:114, close, tick_volume:100,
    })))
    const result = calculateMarketData('XAUUSD', 'M15', laterRates, baseAccount, [], {
      chanDataQuality:{ last_bar_closed:true },
    })
    expect(result.support_resistance.two_closed_bar_breakout.up.complete).toBe(false)
    expect(result.support_resistance.two_closed_bar_breakout.recent_confirmed.up).toMatchObject({
      found:true,
      complete:true,
      age_closed_bars:age,
      reference_high:110,
      reference_low:90,
      still_valid:true,
      invalidation_bar:null,
      first_bar:{ time:'2026-01-01 00:20:00' },
      second_bar:{ time:'2026-01-01 00:21:00' },
    })
  })

  it('marks a confirmed event invalid only at the first later close returning to its reference', () => {
    const rates = Array.from({ length:22 }, (_, index) => ({
      time:`2026-01-01 00:${String(index).padStart(2, '0')}:00`,
      time_utc_msc:1_800_000_000_000 + index * 60_000,
      open:100,
      high:index < 20 ? 110 : index === 20 ? 121 : 125,
      low:index === 21 ? 120 : 90,
      close:index < 20 ? 100 : index === 20 ? 120 : 124,
      tick_volume:100,
    }))
    const laterRates = rates.concat([
      { time:'2026-01-01 00:22:00', time_utc_msc:1_800_000_000_000 + 22 * 60_000, open:115, high:118, low:114, close:115, tick_volume:100 },
      { time:'2026-01-01 00:23:00', time_utc_msc:1_800_000_000_000 + 23 * 60_000, open:112, high:114, low:108, close:110, tick_volume:100 },
    ])
    const result = calculateMarketData('XAUUSD', 'M15', laterRates, baseAccount, [], {
      chanDataQuality:{ last_bar_closed:true },
    })
    expect(result.support_resistance.two_closed_bar_breakout.recent_confirmed.up).toMatchObject({
      found:true,
      complete:true,
      age_closed_bars:2,
      reference_high:110,
      still_valid:false,
      invalidation_bar:{ time:'2026-01-01 00:23:00', close:110 },
    })
  })

  it('does not treat one breakout candle as two confirmation events', () => {
    const rates = Array.from({ length:22 }, (_, index) => ({
      time:`2026-01-01 00:${String(index).padStart(2, '0')}:00`,
      time_utc_msc:1_800_000_000_000 + index * 60_000,
      open:100, high:index === 21 ? 125 : 110,
      low:90, close:index === 21 ? 124 : 100,
      tick_volume:100,
    }))
    const result = calculateMarketData('XAUUSD', 'M15', rates, baseAccount, [], {
      chanDataQuality:{ last_bar_closed:true },
    })
    expect(result.support_resistance.two_closed_bar_breakout.up).toMatchObject({
      first_close_beyond:false,
      second_close_beyond:true,
      complete:false,
      confirmation_type:'none',
    })
    expect(result.support_resistance.two_closed_bar_breakout.recent_confirmed.up).toMatchObject({
      found:false,
      complete:false,
      age_closed_bars:null,
      invalidation_bar:null,
    })
  })

  it('applies the recent confirmation lifecycle symmetrically to down breakouts', () => {
    const rates = Array.from({ length:22 }, (_, index) => ({
      time:`2026-01-01 00:${String(index).padStart(2, '0')}:00`,
      time_utc_msc:1_800_000_000_000 + index * 60_000,
      open:100,
      high:110,
      low:90,
      close:index < 20 ? 100 : index === 20 ? 80 : 76,
      tick_volume:100,
    }))
    const result = calculateMarketData('XAUUSD', 'M15', rates, baseAccount, [], {
      chanDataQuality:{ last_bar_closed:true },
    })
    expect(result.support_resistance.two_closed_bar_breakout.recent_confirmed.down).toMatchObject({
      found:true,
      complete:true,
      age_closed_bars:0,
      reference_high:110,
      reference_low:90,
      still_valid:true,
      invalidation_bar:null,
      first_bar:{ close:80 },
      second_bar:{ close:76 },
    })
    expect(result.support_resistance.two_closed_bar_breakout.recent_confirmed.up).toMatchObject({
      found:false,
      complete:false,
    })
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
    expect(Object.getOwnPropertyDescriptor(result, 'strategy_score')).toMatchObject({ enumerable:false })
    expect(Object.keys(result)).not.toContain('strategy_score')
    expect(JSON.stringify(result)).not.toContain('strategy_score')
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
