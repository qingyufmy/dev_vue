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
    const result = calculateHoldingPathMetrics({ rates: series, deals, direction: 'sell_limit', signal: {
      take_profit_1_price: 95, take_profit_2_price: 90, stop_loss_price: 107,
    } })
    expect(result.status).toBe('complete')
    expect(result.max_favorable_excursion).toBe(8)
    expect(result.max_adverse_excursion).toBe(8)
    expect(result.take_profit_touched).toEqual([true, false, false])
    expect(result.stop_loss_touched).toBe(true)
  })

  it('keeps only holding path plus context and calculates Chan evidence', async () => {
    const series = rates()
    const deals = [
      { entry_type: 0, volume: 1, price: 4000, raw_json: JSON.stringify({ time_utc_msc: series[90].time_utc_msc }) },
      { entry_type: 1, volume: 1, price: 4002, raw_json: JSON.stringify({ time_utc_msc: series[105].time_utc_msc }) },
    ]
    const result = await buildReviewMarketPath({ userId: 7, symbol: 'XAUUSD', signal: { signal_type: 'buy_limit', timeframe: 'M5' },
      snapshot: { klines: { M5: [] } }, deals,
      fetchRates: async () => ({ status: 'success', rates: [...series, { ...series.at(-1), time_utc_msc: series.at(-1).time_utc_msc + 300000 }], market_meta: { timezone_offset_minutes: 180, clock_status: 'calibrated' } }),
    })
    expect(result.primary_timeframe).toBe('M5')
    expect(result.metrics.status).toBe('complete')
    expect(result.timeframes.M5.candle_count).toBeLessThan(series.length)
    expect(result.timeframes.M5.chan).toBeTruthy()
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/)
  })
})

