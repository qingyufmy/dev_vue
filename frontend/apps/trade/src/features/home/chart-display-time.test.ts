import { describe, expect, it } from 'vitest'
import { TickMarkType, type UTCTimestamp } from 'lightweight-charts'
import { chartDisplayTime } from './chart-display-time'

describe('chart timezone labels', () => {
  it('uses the same default for the axis and crosshair across the year boundary', () => {
    const time = (Date.parse('2026-12-31T23:30:00Z') / 1000) as UTCTimestamp
    expect(chartDisplayTime(time)).toBe('2027-01-01 02:30:00')
    expect(chartDisplayTime(time, null, TickMarkType.Year)).toBe('2027')
    expect(chartDisplayTime(time, null, TickMarkType.DayOfMonth)).toBe('01-01')
    expect(chartDisplayTime(time, null, TickMarkType.Time)).toBe('02:30')
    expect(chartDisplayTime(time, 0, TickMarkType.Time)).toBe('23:30')
    expect(chartDisplayTime(time, -210, TickMarkType.Time)).toBe('20:00')
    expect(time).toBe(Date.parse('2026-12-31T23:30:00Z') / 1000)
  })
})
