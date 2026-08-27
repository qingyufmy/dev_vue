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

  function makeBreakoutRates(direction = 'up', trailingBars = []) {
    const isUp = direction === 'up'
    const rates = Array.from({ length:22 }, (_, index) => ({
      time:`2026-01-01 00:${String(index).padStart(2, '0')}:00`,
      time_utc_msc:1_800_000_000_000 + index * 60_000,
      open:100,
      high:index < 20 ? 110 : isUp ? index === 20 ? 121 : 125 : index === 20 ? 85 : 80,
      low:index < 20 ? 90 : isUp ? index === 20 ? 115 : 120 : index === 20 ? 79 : 75,
      close:index < 20 ? 100 : isUp ? index === 20 ? 120 : 124 : index === 20 ? 80 : 76,
      tick_volume:100,
    }))
    return rates.concat(trailingBars.map((bar, offset) => ({
      time:`2026-01-01 00:${String(22 + offset).padStart(2, '0')}:00`,
      time_utc_msc:1_800_000_000_000 + (22 + offset) * 60_000,
      open:100,
      high:110,
      low:90,
      close:100,
      tick_volume:100,
      ...bar,
    })))
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

  it('未确认最后一根K线时所有闭盘证据保持不变，实时价格和ATR仍可更新', () => {
    const rates = generateRates(80)
    const changed = rates.map(rate => ({ ...rate }))
    changed[changed.length - 1] = {
      ...changed[changed.length - 1],
      open: '5100', high: '5200', low: '4900', close: '5150', tick_volume: '9999',
    }
    const baseline = calculateMarketData('XAUUSD', 'H1', rates, baseAccount, basePositions)
    const liveChanged = calculateMarketData('XAUUSD', 'H1', changed, baseAccount, basePositions)

    for (const key of [
      'sma_20', 'sma_50', 'ema_12', 'ema_26', 'avg_volatility',
      'recent_high_20', 'recent_low_20', 'range_position_20', 'sma_distance_pct',
      'momentum_3_pct', 'momentum_10_pct', 'momentum_20_pct', 'volatility_pct',
      'macd', 'rsi_14', 'bollinger', 'atr_14_closed', 'support_resistance',
      'kline_patterns', 'volume', 'last_closed_bar',
    ]) {
      expect(liveChanged[key]).toEqual(baseline[key])
    }
    expect(liveChanged.latest_price).not.toBe(baseline.latest_price)
    expect(liveChanged.atr_14).not.toBe(baseline.atr_14)
  })

  it('明确标记最后一根K线已收盘时仍使用完整输入', () => {
    const rates = generateRates(80)
    const changed = rates.map(rate => ({ ...rate }))
    changed[changed.length - 1] = {
      ...changed[changed.length - 1],
      open: '5100', high: '5200', low: '4900', close: '5150', tick_volume: '9999',
    }
    const options = { chanDataQuality: { last_bar_closed: true } }
    const baseline = calculateMarketData('XAUUSD', 'H1', rates, baseAccount, basePositions, options)
    const changedResult = calculateMarketData('XAUUSD', 'H1', changed, baseAccount, basePositions, options)

    expect(changedResult.latest_price).not.toBe(baseline.latest_price)
    expect(changedResult.sma_20).not.toBe(baseline.sma_20)
    expect(changedResult.macd).not.toEqual(baseline.macd)
    expect(changedResult.kline_patterns).not.toEqual(baseline.kline_patterns)
    expect(changedResult.volume).not.toEqual(baseline.volume)
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
        up:{ found:true, complete:true, age_closed_bars:0, reference_high:110, reference_low:90, still_valid:true, invalidation_bar:null, reclaim:{ found:false, confirmed:false, confirmation_type:'none', still_valid:null } },
        down:{ found:false, complete:false, reclaim:{ found:false, confirmed:false, confirmation_type:'none', still_valid:null } },
      },
    })
  })

  it('reports a closed-bar reclaim candidate before an independent confirmation', () => {
    const result = calculateMarketData('XAUUSD', 'M15', makeBreakoutRates('up', [
      { open:124, high:125, low:108, close:109 },
    ]), baseAccount, [], { chanDataQuality:{ last_bar_closed:true } })
    expect(result.support_resistance.two_closed_bar_breakout.recent_confirmed.up.reclaim).toEqual({
      found:true,
      recovery_direction:'down',
      bars_after_confirmation:1,
      age_closed_bars:0,
      reference_price:110,
      sweep_extreme:125,
      reclaim_bar:{ time:'2026-01-01 00:22:00', high:125, low:108, close:109, time_utc_msc:1_800_000_000_000 + 22 * 60_000 },
      confirmation_bar:null,
      confirmation_type:'none',
      confirmed:false,
      reclaim_close_beyond_breakout_bars:true,
      confirmation_close_beyond_reclaim_extreme:false,
      still_valid:true,
      invalidation_bar:null,
    })
  })

  it('reports full breakout-bar recovery and independent extreme extension as objective booleans', () => {
    const result = calculateMarketData('XAUUSD', 'M15', makeBreakoutRates('up', [
      { open:124, high:125, low:108, close:109 },
      { open:108, high:109, low:106, close:107 },
    ]), baseAccount, [], { chanDataQuality:{ last_bar_closed:true } })
    expect(result.support_resistance.two_closed_bar_breakout.recent_confirmed.up.reclaim).toMatchObject({
      found:true,
      reclaim_close_beyond_breakout_bars:true,
      confirmation_close_beyond_reclaim_extreme:true,
      confirmed:true,
    })
  })

  it.each([
    { label:'hold', confirmation:{ open:109, high:109, low:106, close:108 } },
    { label:'retest', confirmation:{ open:109, high:111, low:106, close:108 } },
  ])('confirms the reclaim on the next independent closed bar as $label', ({ label, confirmation }) => {
    const result = calculateMarketData('XAUUSD', 'M15', makeBreakoutRates('up', [
      { open:124, high:125, low:108, close:109 },
      confirmation,
    ]), baseAccount, [], { chanDataQuality:{ last_bar_closed:true } })
    expect(result.support_resistance.two_closed_bar_breakout.recent_confirmed.up.reclaim).toMatchObject({
      found:true,
      recovery_direction:'down',
      bars_after_confirmation:1,
      age_closed_bars:1,
      confirmation_bar:{ time:'2026-01-01 00:23:00', close:108 },
      confirmation_type:label,
      confirmed:true,
      still_valid:true,
      invalidation_bar:null,
    })
  })

  it('keeps a reclaim objectively observable after more than three closed bars', () => {
    const result = calculateMarketData('XAUUSD', 'M15', makeBreakoutRates('up', [
      { open:124, high:125, low:108, close:109 },
      { open:109, high:109, low:106, close:108 },
      { open:108, high:109, low:105, close:107 },
      { open:107, high:108, low:104, close:106 },
      { open:106, high:107, low:103, close:105 },
    ]), baseAccount, [], { chanDataQuality:{ last_bar_closed:true } })
    expect(result.support_resistance.two_closed_bar_breakout.recent_confirmed.up).toMatchObject({
      found:true,
      age_closed_bars:5,
      first_bar:{ time:'2026-01-01 00:20:00' },
      second_bar:{ time:'2026-01-01 00:21:00' },
      reclaim:{
        found:true,
        bars_after_confirmation:1,
        age_closed_bars:4,
        confirmed:true,
        still_valid:true,
      },
    })
  })

  it('keeps a six-bar-old confirmed event inside the extended lifecycle scan window', () => {
    const result = calculateMarketData('XAUUSD', 'M15', makeBreakoutRates('down', [
      { open:91, high:94, low:89, close:92 },
      { open:92, high:95, low:90, close:93 },
      { open:93, high:96, low:91, close:94 },
      { open:94, high:97, low:92, close:95 },
      { open:95, high:98, low:93, close:96 },
      { open:96, high:99, low:94, close:97 },
    ]), baseAccount, [], { chanDataQuality:{ last_bar_closed:true } })
    expect(result.support_resistance.two_closed_bar_breakout.recent_confirmed.down).toMatchObject({
      found:true,
      age_closed_bars:6,
      reclaim:{
        found:true,
        bars_after_confirmation:1,
        age_closed_bars:5,
        confirmed:true,
        still_valid:true,
      },
    })
  })

  it('records the first original-direction close that invalidates a confirmed reclaim', () => {
    const result = calculateMarketData('XAUUSD', 'M15', makeBreakoutRates('up', [
      { open:124, high:125, low:108, close:109 },
      { open:109, high:109, low:106, close:108 },
      { open:108, high:113, low:107, close:112 },
      { open:112, high:114, low:110, close:111 },
    ]), baseAccount, [], { chanDataQuality:{ last_bar_closed:true } })
    expect(result.support_resistance.two_closed_bar_breakout.recent_confirmed.up.reclaim).toMatchObject({
      found:true,
      confirmed:true,
      confirmation_type:'hold',
      still_valid:false,
      invalidation_bar:{ time:'2026-01-01 00:24:00', close:112 },
    })
  })

  it('applies reclaim evidence symmetrically to down breakouts', () => {
    const result = calculateMarketData('XAUUSD', 'M15', makeBreakoutRates('down', [
      { open:76, high:92, low:75, close:91 },
      { open:91, high:94, low:89, close:92 },
    ]), baseAccount, [], { chanDataQuality:{ last_bar_closed:true } })
    expect(result.support_resistance.two_closed_bar_breakout.recent_confirmed.down.reclaim).toMatchObject({
      found:true,
      recovery_direction:'up',
      bars_after_confirmation:1,
      age_closed_bars:1,
      reference_price:90,
      sweep_extreme:75,
      reclaim_bar:{ time:'2026-01-01 00:22:00', close:91 },
      confirmation_bar:{ time:'2026-01-01 00:23:00', close:92 },
      confirmation_type:'retest',
      confirmed:true,
      reclaim_close_beyond_breakout_bars:true,
      confirmation_close_beyond_reclaim_extreme:false,
      still_valid:true,
      invalidation_bar:null,
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
    const series = __chanTest.calculateMacdSeries(rates.slice(0, -1).map(r => parseFloat(r.close)))
    expect(result.macd.line).toBeCloseTo(series.latestDif, 5)
    expect(result.macd.signal).toBeCloseTo(series.latestDea, 5)
    expect(result.macd.histogram).toBeCloseTo(series.latestHist, 5)
    expect(Math.abs((result.macd.line - result.macd.signal) - result.macd.histogram)).toBeLessThan(0.00002)
  })
})
