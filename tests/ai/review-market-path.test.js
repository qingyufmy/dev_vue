import { describe, expect, it } from 'vitest'
import { buildReviewMarketPath, calculateHoldingPathMetrics } from '../../server/routes/ai/review-market-path.js'

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
    expect(result.max_favorable_excursion).toBe(8)
    expect(result.max_adverse_excursion).toBe(8)
    expect(result.take_profit_touched).toEqual([true, false, false])
    expect(result.stop_loss_touched).toBe(true)
  })

  it('includes the candle that already opened when a short holding period starts', () => {
    const result = calculateHoldingPathMetrics({
      rates:[{ time_utc_msc:0, high:105, low:95 }, { time_utc_msc:3600000, high:110, low:90 }],
      deals:[
        { entry_type:0, volume:1, price:100, raw_json:JSON.stringify({ time_utc_msc:10 * 60000 }) },
        { entry_type:1, volume:1, price:102, raw_json:JSON.stringify({ time_utc_msc:20 * 60000 }) },
      ],
      direction:'buy', timeframeIntervalMs:3600000,
    })
    expect(result.status).toBe('complete')
    expect(result.bars_held).toBe(1)
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
