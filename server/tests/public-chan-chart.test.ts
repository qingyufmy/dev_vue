import { describe, expect, it } from 'vitest'
import { publicChanChart, publicTrendGuide, recentBiFractalLines } from '../src/modules/market/application/public-chan-chart.js'

function candles(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const base = 2400 + Math.sin(index / 4) * 18 + index / 20
    return {
      openTime: new Date(Date.UTC(2026, 8, 1) + index * 300_000).toISOString(),
      open: base.toFixed(2), high: (base + 4).toFixed(2), low: (base - 4).toFixed(2),
      close: (base + Math.sin(index) * 2).toFixed(2), closed: true,
    }
  })
}

describe('public Chan chart projection', () => {
  it('does not calculate an unsupported timeframe', () => {
    expect(publicChanChart({ accountId: '1', platform: 'mt5', timeframe: 'invalid', candles: candles(40), clock: null,
      referenceTime: '2026-09-02T00:00:00.000Z' })).toBeNull()
  })

  it('reports insufficient closed history without treating a forming candle as evidence', () => {
    const rows = [...candles(29), { ...candles(1)[0]!, openTime: '2026-09-01T02:30:00.000Z', closed: false }]
    expect(publicChanChart({ accountId: '1', platform: 'mt5', timeframe: 'M5', candles: rows, clock: null,
      referenceTime: '2026-09-02T00:00:00.000Z' })).toEqual({
      algorithm: 'chan_structure_v8', status: 'insufficient_klines', reliability: 'low', based_on_closed_bars: 29, trend: null, trend_guide: null, lines: [],
    })
  })

  it('returns only bounded display line kinds from the production engine', () => {
    const result = publicChanChart({ accountId: '1', platform: 'mt5', timeframe: 'M5', candles: candles(300),
      clock: { offset: 180, checkedAt: '2026-09-02T00:00:00.000Z' }, referenceTime: '2026-09-02T00:00:00.000Z' })
    expect(result?.algorithm).toBe('chan_structure_v8')
    expect(result?.based_on_closed_bars).toBe(300)
    expect(result?.lines.length).toBeLessThanOrEqual(32)
    expect(result?.lines.every(line => ['bi', 'segment', 'forming_segment', 'center', 'bi_center', 'fractal_top', 'fractal_bottom'].includes(line.kind))).toBe(true)
    expect(result).toHaveProperty('trend')
    expect(result).toHaveProperty('trend_guide')
  })

  it('omits developing geometry from causal historical pages', () => {
    const result = publicChanChart({ accountId: '1', platform: 'mt5', timeframe: 'M5', candles: candles(300),
      clock: { offset: 180, checkedAt: '2026-09-02T00:00:00.000Z' }, referenceTime: '2026-09-02T00:00:00.000Z',
      includeDeveloping: false })
    expect(result?.lines.some(line => line.kind === 'forming_segment')).toBe(false)
  })

  it('projects every recent confirmed bi endpoint as a de-duplicated fractal', () => {
    const start = Date.UTC(2026, 8, 18, 10)
    const lines = recentBiFractalLines([
      { confirmed: true, dir: 'up', start_time_utc_msc: start, end_time_utc_msc: start + 300_000, start_price: 4300, end_price: 4310 },
      { confirmed: true, dir: 'down', start_time_utc_msc: start + 300_000, end_time_utc_msc: start + 600_000, start_price: 4310, end_price: 4298 },
    ])
    expect(lines.map(line => [line.kind, line.start])).toEqual([
      ['fractal_bottom', 4300], ['fractal_top', 4310], ['fractal_bottom', 4298],
    ])
  })

  it('projects a distinct trend guide from the structure that produced the trend state', () => {
    const start = Date.UTC(2026, 8, 18, 10)
    const trend = { state: 'structural_rise', direction: 'up' as const, phase: 'structure', confidence: 'medium' as const, reason: 'segments_without_center' }
    expect(publicTrendGuide({ trend_state: { segment_id: 7 }, _confirmed_segments: [
      { id: 7, dir: 'up', start_time_utc_msc: start, end_time_utc_msc: start + 900_000, start_price: 4300, end_price: 4330 },
    ] }, trend)).toEqual({ direction: 'up', from: new Date(start).toISOString(), to: new Date(start + 900_000).toISOString(),
      start: 4300, end: 4330, developing: false, basis: 'segment' })
  })
})
