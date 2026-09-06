import { describe, expect, it } from 'vitest'
import { terminalDisplayDate, terminalDisplayTimezone } from '../terminal-display-time'
import { formatDateTime as traderTime } from '../../features/trader/model/trader-presentation'
import { formatDateTime as riskTime } from '../../features/risk/model/risk-presentation'

describe('terminal display timezone', () => {
  it('uses a visibly uncalibrated default without changing source evidence', () => {
    const snapshot = Object.freeze({ timezoneOffsetMinutes: null, clockStatus: 'unavailable' })
    expect(terminalDisplayTimezone(snapshot.timezoneOffsetMinutes, snapshot.clockStatus)).toEqual({
      offsetMinutes: 180, label: 'UTC+03:00', statusLabel: '默认时区，待校准', isDefault: true,
    })
    expect(snapshot.timezoneOffsetMinutes).toBeNull()
    expect(snapshot.clockStatus).toBe('unavailable')
  })

  it('retains supplied stale offsets and does not carry them to another account', () => {
    expect(terminalDisplayTimezone(120, 'stale')).toMatchObject({ offsetMinutes: 120, statusLabel: '沿用最近时区，待更新', isDefault: false })
    expect(terminalDisplayTimezone(null).offsetMinutes).toBe(180)
    expect(terminalDisplayTimezone(0, 'calibrated')).toMatchObject({ offsetMinutes: 0, label: 'UTC+00:00', isDefault: false })
    expect(terminalDisplayTimezone(-210).label).toBe('UTC-03:30')
    expect(terminalDisplayTimezone(345).label).toBe('UTC+05:45')
  })

  it.each([undefined, null, NaN, Infinity, 841, -841, 1.5])('falls back on invalid offset %s', (offset) => {
    expect(terminalDisplayTimezone(offset).isDefault).toBe(true)
  })

  it('formats across midnight without mutating the UTC instant or using browser timezone', () => {
    const instant = new Date('2026-09-04T23:30:00.000Z')
    expect(terminalDisplayDate(instant).toISOString()).toBe('2026-09-05T02:30:00.000Z')
    expect(instant.toISOString()).toBe('2026-09-04T23:30:00.000Z')
    for (const format of [traderTime, riskTime]) {
      expect(format(instant.toISOString())).toContain('02:30:00')
      expect(format(instant.toISOString(), 0)).toContain('23:30:00')
      expect(format(instant.toISOString(), -210)).toContain('20:00:00')
      expect(format(null)).toBe('--')
    }
  })
})
