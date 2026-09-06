import { describe, expect, it } from 'vitest'
import { resolveAccountClock, type AccountClock } from '../src/modules/trading/domain/account-clock.js'

describe('account clock retention', () => {
  const unavailable: AccountClock = { timezoneOffsetMinutes: null, clockStatus: 'unavailable' }
  it('keeps a proven zero offset stale during closure without mutating evidence', () => {
    const previous = Object.freeze({ timezoneOffsetMinutes: 0, clockStatus: 'calibrated' as const })
    expect(resolveAccountClock(unavailable, previous)).toEqual({ timezoneOffsetMinutes: 0, clockStatus: 'stale' })
    expect(previous.clockStatus).toBe('calibrated')
    expect(resolveAccountClock(unavailable, { timezoneOffsetMinutes: -210, clockStatus: 'stale' }))
      .toEqual({ timezoneOffsetMinutes: -210, clockStatus: 'stale' })
  })
  it('does not bootstrap from guessed, stale, observer or absent evidence', () => {
    for (const previous of [null, { timezoneOffsetMinutes: 180, clockStatus: 'observer_bootstrap' as const }, { timezoneOffsetMinutes: 180, clockStatus: 'unavailable' as const }]) {
      expect(resolveAccountClock({ timezoneOffsetMinutes: 180, clockStatus: 'stale' }, previous)).toEqual(unavailable)
    }
    expect(resolveAccountClock(unavailable, { timezoneOffsetMinutes: null, clockStatus: 'calibrated' })).toEqual(unavailable)
  })
  it('accepts a new calibrated offset but never adopts a changed uncalibrated offset', () => {
    const previous: AccountClock = { timezoneOffsetMinutes: 120, clockStatus: 'calibrated' }
    expect(resolveAccountClock({ timezoneOffsetMinutes: 180, clockStatus: 'calibrated' }, previous).timezoneOffsetMinutes).toBe(180)
    expect(resolveAccountClock({ timezoneOffsetMinutes: 180, clockStatus: 'stale' }, previous).timezoneOffsetMinutes).toBe(120)
  })
  it.each([null, 841, NaN, 120.5])('rejects invalid new calibration %s', offset => {
    expect(() => resolveAccountClock({ timezoneOffsetMinutes: offset, clockStatus: 'calibrated' }, null)).toThrow('trading_context_invalid')
  })
})
