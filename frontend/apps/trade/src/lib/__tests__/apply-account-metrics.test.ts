import { describe, expect, it } from 'vitest'
import type { AccountSnapshot } from '@aurum/contracts'
import { applyAccountMetrics } from '../apply-account-metrics'

const snapshot = Object.freeze({ id: 'account-a', revision: 10, timezoneOffsetMinutes: 120, clockStatus: 'calibrated' }) as AccountSnapshot
const metrics = { balance: '100', equity: '100', margin: '0', free_margin: '100', floating_profit: '0', currency: 'USD', observed_at: '2026-09-06T08:00:00.000Z' }

describe('account metrics clock updates', () => {
  it('updates permissions and leverage without overwriting metadata omitted by old producers', () => {
    const base = { ...snapshot, tradePermission: true, leverage: 100 }
    expect(applyAccountMetrics(base, metrics, 11)).toMatchObject({ tradePermission: true, leverage: 100 })
    expect(applyAccountMetrics(base, { ...metrics, leverage: 500, trade_permission: false }, 11)).toMatchObject({ tradePermission: false, leverage: 500 })
  })

  it('preserves old-producer clock evidence and applies explicit stale, zero, and null updates', () => {
    expect(applyAccountMetrics(snapshot, metrics, 11).timezoneOffsetMinutes).toBe(120)
    const stale = applyAccountMetrics(snapshot, { ...metrics, timezone_offset_minutes: 120, clock_status: 'stale' }, 11)
    expect(stale).toMatchObject({ timezoneOffsetMinutes: 120, clockStatus: 'stale' })
    const calibrated = applyAccountMetrics(stale, { ...metrics, timezone_offset_minutes: 0, clock_status: 'calibrated' }, 12)
    expect(calibrated).toMatchObject({ timezoneOffsetMinutes: 0, clockStatus: 'calibrated' })
    expect(applyAccountMetrics(calibrated, { ...metrics, timezone_offset_minutes: null, clock_status: 'unavailable' }, 13))
      .toMatchObject({ timezoneOffsetMinutes: null, clockStatus: 'unavailable' })
    expect(snapshot).toMatchObject({ revision: 10, timezoneOffsetMinutes: 120, clockStatus: 'calibrated' })
  })

  it.each([
    { timezone_offset_minutes: 180 }, { clock_status: 'calibrated' },
    { timezone_offset_minutes: 841, clock_status: 'calibrated' },
    { timezone_offset_minutes: 120.5, clock_status: 'calibrated' },
    { timezone_offset_minutes: 180, clock_status: 'guessed' },
  ])('rejects malformed clock pairs atomically: %j', (clock) => {
    expect(applyAccountMetrics(snapshot, { ...metrics, ...clock }, 11)).toBe(snapshot)
  })

  it.each([9, 10, NaN, 11.5, Number.MAX_SAFE_INTEGER + 1])('ignores invalid or superseded revision %s', revision => {
    expect(applyAccountMetrics(snapshot, { ...metrics, timezone_offset_minutes: 180, clock_status: 'calibrated' }, revision)).toBe(snapshot)
  })
})
