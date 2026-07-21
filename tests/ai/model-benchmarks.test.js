import { describe, expect, it } from 'vitest'
import { selectClassicBenchmarkCases, __modelBenchmarksTest } from '../../server/routes/ai/model-benchmarks.js'

function windowFromCloses(closes) {
  return closes.map((close, index) => {
    const open = index ? closes[index - 1] : close
    return { open, close, high:Math.max(open, close) + 0.2, low:Math.min(open, close) - 0.2 }
  })
}

function syntheticRates(count = 900) {
  const start = Date.UTC(2026, 5, 1)
  let price = 2000
  return Array.from({ length:count }, (_, index) => {
    const phase = Math.floor(index / 90) % 6
    const local = index % 90
    const delta = phase === 0 ? 0.8
      : phase === 1 ? -0.75
        : phase === 2 ? (local < 45 ? -0.9 : 1.15)
          : phase === 3 ? (local < 45 ? 0.9 : -1.15)
            : phase === 4 ? Math.sin(local / 4) * 1.4
              : Math.sin(local / 3) * 0.25
    const open = price
    const close = price + delta
    price = close
    return {
      time_utc_msc:start + index * 300_000,
      open, high:Math.max(open, close) + 0.35, low:Math.min(open, close) - 0.35, close,
      tick_volume:100 + index,
    }
  })
}

describe('classic model benchmark selection', () => {
  it('classifies clear directional windows', () => {
    const rising = windowFromCloses(Array.from({ length:24 }, (_, index) => 100 + index))
    const falling = windowFromCloses(Array.from({ length:24 }, (_, index) => 124 - index))
    expect(__modelBenchmarksTest.classifyWindow(rising, 8).regime_type).toBe('trend_up')
    expect(__modelBenchmarksTest.classifyWindow(falling, 8).regime_type).toBe('trend_down')
  })

  it('returns deterministic, chronological and non-duplicated cases', () => {
    const rates = syntheticRates()
    const first = selectClassicBenchmarkCases(rates, 18)
    const second = selectClassicBenchmarkCases(rates, 18)
    expect(first).toEqual(second)
    expect(first).toHaveLength(18)
    expect(new Set(first.map(item => item.decision_time_utc_msc)).size).toBe(18)
    expect(first.map(item => item.decision_time_utc_msc)).toEqual(
      [...first].map(item => item.decision_time_utc_msc).sort((a, b) => a - b),
    )
    expect(new Set(first.map(item => item.regime_type)).size).toBeGreaterThanOrEqual(3)
  })

  it('rejects a source window that cannot provide context and outcome bars', () => {
    expect(() => selectClassicBenchmarkCases(syntheticRates(30), 12))
      .toThrow('benchmark_market_data_insufficient')
  })
})
