import { describe, expect, it } from 'vitest'
import { buildReviewMarketPath, calculateHoldingPathMetrics, expectedLatestClosedOpen } from '../../server/routes/ai/review-market-path.js'

function rates(count = 120, start = Date.UTC(2026, 6, 1), step = 300000) {
  return Array.from({ length: count }, (_, index) => {
    const base = 4000 + Math.sin(index / 8) * 8
    return { time_utc_msc: start + index * step, open: base, high: base + 3, low: base - 2, close: base + 1, tick_volume: 100 + index }
  })
}

describe('review holding market path', () => {
  it('calculates direction-aware MFE, MAE and target touches', () => {
    const series = [
      { time_utc_msc: 1000, high: 101, low: 99 },
      { time_utc_msc: 2000, high: 108, low: 97 },
      { time_utc_msc: 3000, high: 104, low: 92 },
    ]
    const deals = [
      { entry_type: 0, volume: 1, price: 100, raw_json: JSON.stringify({ time_utc_msc: 1000 }) },
      { entry_type: 1, volume: 1, price: 94, raw_json: JSON.stringify({ time_utc_msc: 3000 }) },
    ]
    const result = calculateHoldingPathMetrics({ rates: series, deals, direction: 'sell_limit', timeframeIntervalMs:1000, signal: {
      take_profit_1_price: 95, take_profit_2_price: 90, stop_loss_price: 107,
    } })
    expect(result.status).toBe('complete')
    expect(result.max_favorable_excursion).toBe(6)
    expect(result.max_adverse_excursion).toBe(8)
    expect(result.take_profit_touched).toEqual([true, false, false])
    expect(result.stop_loss_touched).toBe(true)
    expect(result.metric_precision).toBe('bar_bounded')
    expect(result.boundary_candle_partial).toBe(false)
  })

  it('marks a short intrabar holding interval as not observable without fabricating path metrics', () => {
    const result = calculateHoldingPathMetrics({
      rates:[{ time_utc_msc:0, high:105, low:95 }, { time_utc_msc:3600000, high:110, low:90 }],
      deals:[
        { entry_type:0, volume:1, price:100, raw_json:JSON.stringify({ time_utc_msc:10 * 60000 }) },
        { entry_type:1, volume:1, price:102, raw_json:JSON.stringify({ time_utc_msc:20 * 60000 }) },
      ],
      direction:'buy', timeframeIntervalMs:3600000,
    })
    expect(result.status).toBe('not_observable')
    expect(result.path_metrics_status).toBe('not_observable')
    expect(result.trade_facts_status).toBe('complete')
    expect(result.reason).toBe('holding_path_intrabar_unobservable')
    expect(result.metric_precision).toBe('not_observable')
    expect(result.max_favorable_excursion).toBeNull()
    expect(result.max_adverse_excursion).toBeNull()
    expect(result.take_profit_touched).toBeNull()
    expect(result.stop_loss_touched).toBeNull()
    expect(result.boundary_candle_count).toBe(1)
  })

  it('keeps two boundary M5 candles observable only at the trade-facts level', () => {
    const start = Date.UTC(2026, 7, 17, 13, 50)
    const result = calculateHoldingPathMetrics({
      rates:[
        { time_utc_msc:start, high:4400, low:4380 },
        { time_utc_msc:start + 300000, high:4410, low:4370 },
      ],
      deals:[
        { entry_type:0, volume:1, price:4390, raw_json:JSON.stringify({ time_utc_msc:start + 110000 }) },
        { entry_type:1, volume:1, price:4385, raw_json:JSON.stringify({ time_utc_msc:start + 429999 }) },
      ],
      direction:'buy', timeframeIntervalMs:300000,
    })
    expect(result.status).toBe('not_observable')
    expect(result.path_metrics_status).toBe('not_observable')
    expect(result.boundary_candle_count).toBe(2)
    expect(result.holding_duration_ms).toBe(319999)
    expect(result.capabilities).toEqual({ mfe_mae:false, target_touch:false, intrabar_sequence:false })
  })

  it('fails closed when transaction facts do not have a trusted exit price', () => {
    const result = calculateHoldingPathMetrics({
      rates:[{ time_utc_msc:1000, high:101, low:99 }],
      deals:[
        { entry_type:0, volume:1, price:100, raw_json:JSON.stringify({ time_utc_msc:1000 }) },
        { entry_type:1, volume:1, raw_json:JSON.stringify({ time_utc_msc:2000 }) },
      ],
      direction:'buy', timeframeIntervalMs:1000,
    })
    expect(result.status).toBe('partial')
    expect(result.path_metrics_status).toBe('incomplete')
    expect(result.trade_facts_status).toBe('incomplete')
    expect(result.reason).toBe('holding_trade_facts_missing')
  })

  it('fails closed when any partial-close deal is missing trusted price evidence', () => {
    const result = calculateHoldingPathMetrics({
      rates:[{ time_utc_msc:1000, high:101, low:99 }, { time_utc_msc:2000, high:103, low:100 }],
      deals:[
        { entry_type:0, volume:2, price:100, raw_json:JSON.stringify({ time_utc_msc:1000 }) },
        { entry_type:1, volume:1, price:102, raw_json:JSON.stringify({ time_utc_msc:2000 }) },
        { entry_type:1, volume:1, raw_json:JSON.stringify({ time_utc_msc:2000 }) },
      ],
      direction:'buy', timeframeIntervalMs:1000,
    })
    expect(result.trade_facts_status).toBe('incomplete')
    expect(result.path_metrics_status).toBe('incomplete')
  })

  it('fails closed when transaction facts do not have a trusted entry time', () => {
    const result = calculateHoldingPathMetrics({
      rates:[{ time_utc_msc:1000, high:101, low:99 }],
      deals:[
        { entry_type:0, volume:1, price:100, raw_json:'{}' },
        { entry_type:1, volume:1, price:102, raw_json:JSON.stringify({ time_utc_msc:2000 }) },
      ],
      direction:'buy', timeframeIntervalMs:1000,
    })
    expect(result.path_metrics_status).toBe('incomplete')
    expect(result.trade_facts_status).toBe('incomplete')
    expect(result.entry_time_utc_msc).toBeNull()
  })

  it('aligns the latest closed candle to the timeframe boundary', () => {
    expect(expectedLatestClosedOpen(Date.UTC(2026, 7, 17, 10, 0, 0), 300000))
      .toBe(Date.UTC(2026, 7, 17, 9, 55, 0))
    expect(expectedLatestClosedOpen(Date.UTC(2026, 7, 17, 10, 1, 42), 300000))
      .toBe(Date.UTC(2026, 7, 17, 9, 55, 0))
    expect(expectedLatestClosedOpen(0, 300000)).toBeNull()
  })

  it('does not report a normal aligned pre-entry candle as truncated', async () => {
    const series = rates(120)
    const cutoff = series[90].time_utc_msc + 42_000
    const deals = [
      { entry_type:0, volume:1, price:4000, raw_json:JSON.stringify({ time_utc_msc:cutoff }) },
      { entry_type:1, volume:1, price:4002, raw_json:JSON.stringify({ time_utc_msc:series[105].time_utc_msc }) },
    ]
    const available = series.slice(0, 91)
    const result = await buildReviewMarketPath({ userId:7, symbol:'XAUUSD',
      signal:{ timeframe:'M5', signal_type:'hold' }, snapshot:{ klines:{ M5:[] } }, deals,
      asOfUtcMsc:cutoff, includeHoldingMetrics:false, timezoneOffsetMinutes:0,
      chanRequirement:{ status:'disabled', source:'test', timeframes:[] },
      fetchRates:async () => ({ status:'success', rates:[...available, { ...available.at(-1),
        time_utc_msc:available.at(-1).time_utc_msc + 300000 }], market_meta:{ timezone_offset_minutes:0 } }),
    })
    expect(result.timeframes.M5.truncated_before_exit).toBe(false)
    expect(result.timeframes.M5.expected_last_closed_open_utc_msc).toBe(series[89].time_utc_msc)
  })

  it('keeps only holding path plus context and calculates Chan evidence', async () => {
    const series = rates()
    const deals = [
      { entry_type: 0, volume: 1, price: 4000, raw_json: JSON.stringify({ time_utc_msc: series[90].time_utc_msc }) },
      { entry_type: 1, volume: 1, price: 4002, raw_json: JSON.stringify({ time_utc_msc: series[105].time_utc_msc }) },
    ]
    const result = await buildReviewMarketPath({ userId: 7, symbol: 'XAUUSD', signal: { signal_type: 'buy_limit', timeframe: 'M5' },
      snapshot: { klines: { M5: [] } }, deals,
      chanRequirement:{ status:'enabled', source:'test_frozen_enabled', timeframes:['M5'], window_policy_version:'chan_window_v6' },
      fetchRates: async () => ({ status: 'success', rates: [...series, { ...series.at(-1), time_utc_msc: series.at(-1).time_utc_msc + 300000 }], market_meta: { timezone_offset_minutes: 180, clock_status: 'calibrated' } }),
    })
    expect(result.primary_timeframe).toBe('M5')
    expect(result.metrics.status).toBe('complete')
    expect(result.timeframes.M5.candle_count).toBeLessThan(series.length)
    expect(result.timeframes.M5.chan).toBeTruthy()
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reads persisted historical windows without requiring a connected bridge', async () => {
    const series = rates(140)
    const deals = [
      { entry_type:0, volume:1, price:4000, raw_json:JSON.stringify({ time_msc:series[90].time_utc_msc + 180 * 60000 }) },
      { entry_type:1, volume:1, price:4002, raw_json:JSON.stringify({ time_msc:series[105].time_utc_msc + 180 * 60000 }) },
    ]
    let requestedWindow = null
    const result = await buildReviewMarketPath({ userId:7, symbol:'XAUUSD',
      signal:{ signal_type:'buy_limit', timeframe:'M5' }, snapshot:{ klines:{ M5:series.slice(-60) } }, deals,
      chanRequirement:{ status:'enabled', source:'test_frozen_enabled', timeframes:['M5'], window_policy_version:'chan_window_v6' },
      timezoneOffsetMinutes:180,
      loadWindow:async (_userId, _symbol, timeframe, startUtcMs, endUtcMs, options) => {
        requestedWindow = { timeframe, startUtcMs, endUtcMs, options }
        return { rates:series, marketMeta:{ source:'mysql_period_cache', timezone_offset_minutes:180 } }
      },
    })
    expect(requestedWindow).toMatchObject({ timeframe:'M5', options:{ alignToPeriodStart:false } })
    expect(result.status).toBe('complete')
    expect(result.metrics.status).toBe('complete')
  })

  it('aligns millisecond deal boundaries to the requested candle grid', async () => {
    const series = rates(140)
    const entryTime = series[90].time_utc_msc + 40_975
    const exitTime = series[105].time_utc_msc + 13_111
    const deals = [
      { entry_type:0, volume:1, price:4000, raw_json:JSON.stringify({ time_utc_msc:entryTime }) },
      { entry_type:1, volume:1, price:4002, raw_json:JSON.stringify({ time_utc_msc:exitTime }) },
    ]
    let requestedWindow = null

    const result = await buildReviewMarketPath({ userId:7, symbol:'XAUUSD',
      signal:{ signal_type:'buy_limit', timeframe:'M5' }, snapshot:{ klines:{ M5:series.slice(-60) } }, deals,
      chanRequirement:{ status:'disabled', source:'test_frozen_disabled', timeframes:[] },
      loadWindow:async (_userId, _symbol, timeframe, startUtcMs, endUtcMs) => {
        requestedWindow = { timeframe, startUtcMs, endUtcMs }
        return { rates:series, marketMeta:{ source:'mysql_period_cache', timezone_offset_minutes:0 } }
      },
    })

    expect(requestedWindow.timeframe).toBe('M5')
    expect(requestedWindow.startUtcMs % 300_000).toBe(0)
    expect(requestedWindow.endUtcMs % 300_000).toBe(0)
    expect(requestedWindow.startUtcMs).toBe(Math.floor(entryTime / 300_000) * 300_000 - 80 * 300_000)
    expect(result.metrics.status).toBe('complete')
  })

  it('allows a covered short holding to generate with not-observable path metrics', async () => {
    const series = rates(140)
    const entryTime = series[90].time_utc_msc + 60000
    const exitTime = series[90].time_utc_msc + 240000
    const deals = [
      { entry_type:0, volume:1, price:4000, raw_json:JSON.stringify({ time_utc_msc:entryTime }) },
      { entry_type:1, volume:1, price:4002, raw_json:JSON.stringify({ time_utc_msc:exitTime }) },
    ]
    const result = await buildReviewMarketPath({ userId:7, symbol:'XAUUSD',
      signal:{ signal_type:'buy', timeframe:'M5', take_profit_1_price:4010, stop_loss_price:3990 },
      snapshot:{ klines:{ M5:[] } }, deals, timezoneOffsetMinutes:0,
      chanRequirement:{ status:'disabled', source:'test_frozen_disabled', timeframes:[] },
      fetchRates:async () => ({ status:'success', rates:[...series, { ...series.at(-1), time_utc_msc:series.at(-1).time_utc_msc + 300000 }],
        market_meta:{ timezone_offset_minutes:0, clock_status:'verified' } }),
    })
    expect(result.status).toBe('complete')
    expect(result.trade_facts_status).toBe('complete')
    expect(result.market_coverage_status).toBe('complete')
    expect(result.path_metrics_status).toBe('not_observable')
    expect(result.metrics.max_favorable_excursion).toBeNull()
    expect(result.metrics.take_profit_touched).toBeNull()
    expect(result.timeframes.M5.internal_gap_count).toBe(0)
  })

  it('fails closed when a real M5 candle gap crosses the holding interval', async () => {
    const series = rates(140)
    const entryTime = series[90].time_utc_msc + 60000
    const exitTime = series[110].time_utc_msc + 60000
    const available = series.filter((_, index) => index !== 100)
    const deals = [
      { entry_type:0, volume:1, price:4000, raw_json:JSON.stringify({ time_utc_msc:entryTime }) },
      { entry_type:1, volume:1, price:4002, raw_json:JSON.stringify({ time_utc_msc:exitTime }) },
    ]
    const result = await buildReviewMarketPath({ userId:7, symbol:'XAUUSD',
      signal:{ signal_type:'buy', timeframe:'M5' }, snapshot:{ klines:{ M5:[] } }, deals,
      timezoneOffsetMinutes:0, chanRequirement:{ status:'disabled', source:'test_frozen_disabled', timeframes:[] },
      fetchRates:async () => ({ status:'success', rates:[...available, { ...available.at(-1), time_utc_msc:available.at(-1).time_utc_msc + 300000 }],
        market_meta:{ timezone_offset_minutes:0, clock_status:'verified' } }),
    })
    expect(result.status).toBe('partial')
    expect(result.market_coverage_status).toBe('partial')
    expect(result.timeframes.M5.status).toBe('partial')
    expect(result.timeframes.M5.internal_gap_count).toBeGreaterThan(0)
    expect(result.metrics.max_favorable_excursion).toBeNull()
    expect(result.metrics.take_profit_touched).toBeNull()
  })

  it('uses trusted continuity assessment instead of treating a known closure as a raw candle gap', async () => {
    const series = rates(140)
    const available = series.filter((_, index) => index !== 100)
    const deals = [
      { entry_type:0, volume:1, price:4000, raw_json:JSON.stringify({ time_utc_msc:series[90].time_utc_msc + 60000 }) },
      { entry_type:1, volume:1, price:4002, raw_json:JSON.stringify({ time_utc_msc:series[110].time_utc_msc + 60000 }) },
    ]
    const result = await buildReviewMarketPath({ userId:7, symbol:'XAUUSD',
      signal:{ signal_type:'buy', timeframe:'M5' }, snapshot:{ klines:{ M5:[] } }, deals,
      timezoneOffsetMinutes:0, chanRequirement:{ status:'disabled', source:'test_frozen_disabled', timeframes:[] },
      fetchRates:async () => ({ status:'success', rates:[...available, { ...available.at(-1), time_utc_msc:available.at(-1).time_utc_msc + 300000 }],
        market_meta:{ timezone_offset_minutes:0, clock_status:'verified', continuity_status:'reliable', internal_gap_count:0,
          expected_closures:[{ reason:'scheduled_closure' }] } }),
    })
    expect(result.market_coverage_status).toBe('complete')
    expect(result.timeframes.M5.internal_gap_count).toBe(0)
  })

  it('cuts counterfactual evidence at the entry boundary without holding metrics or future candles', async () => {
    const series = rates(120)
    const entryTime = series[90].time_utc_msc
    const deals = [
      { entry_type:0, volume:1, price:4000, raw_json:JSON.stringify({ time_utc_msc:entryTime }) },
      { entry_type:1, volume:1, price:4002, raw_json:JSON.stringify({ time_utc_msc:series[105].time_utc_msc }) },
    ]
    const result = await buildReviewMarketPath({ userId:7, symbol:'XAUUSD', signal:{ timeframe:'M5', signal_type:'hold' },
      snapshot:{ klines:{ M5:[] } }, deals, asOfUtcMsc:entryTime, includeHoldingMetrics:false,
      chanRequirement:{ status:'disabled', source:'test_frozen_disabled', timeframes:[] },
      fetchRates:async () => ({ status:'success', rates:[...series, { ...series.at(-1), time_utc_msc:series.at(-1).time_utc_msc + 300000 }],
        market_meta:{ timezone_offset_minutes:0, clock_status:'verified' } }),
    })
    expect(result.status).toBe('complete')
    expect(result.metrics).toBeNull()
    expect(result.timeframes.M5.candles.length).toBeGreaterThan(20)
    expect(result.timeframes.M5.candles.every(candle => candle.time_utc_msc + 300000 <= entryTime)).toBe(true)
  })

  it('does not compute or emit Chan evidence for a frozen disabled requirement', async () => {
    const series = rates(120)
    const deals = [
      { entry_type:0, volume:1, price:4000, raw_json:JSON.stringify({ time_utc_msc:series[90].time_utc_msc }) },
      { entry_type:1, volume:1, price:4002, raw_json:JSON.stringify({ time_utc_msc:series[105].time_utc_msc }) },
    ]
    const result = await buildReviewMarketPath({ userId:7, symbol:'XAUUSD', signal:{ timeframe:'M5', signal_type:'buy' },
      snapshot:{ klines:{ M5:[] } }, deals,
      chanRequirement:{ status:'disabled', source:'explicit_frozen_disabled', timeframes:[] },
      fetchRates:async () => ({ status:'success', rates:[...series, { ...series.at(-1), time_utc_msc:series.at(-1).time_utc_msc + 300000 }],
        market_meta:{ timezone_offset_minutes:180, clock_status:'calibrated' } }),
    })
    expect(result.timeframes.M5).not.toHaveProperty('chan')
  })
})
