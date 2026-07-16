import { describe, expect, it } from 'vitest'
import {
  isSubscriptionScheduleActive,
  normalizeSubscriptionSchedule,
  SUBSCRIPTION_SCHEDULE_DEFAULTS,
  subscriptionAllowsExecution,
  subscriptionAllowsInference,
} from '../../server/routes/ai/subscription-schedule.js'

const scheduled = (overrides = {}) => ({
  schedule_enabled: 1,
  schedule_timezone: 'UTC',
  schedule_weekdays_json: '[1,2,3,4,5]',
  schedule_windows_json: '[{"start":"09:00","end":"17:00"}]',
  outside_window_behavior: 'pause_all',
  ...overrides,
})

describe('subscription runtime schedule', () => {
  it('defaults new schedules to the MT5 server timezone (UTC+3)', () => {
    expect(SUBSCRIPTION_SCHEDULE_DEFAULTS.timezone).toBe('Etc/GMT-3')
    const normalized = normalizeSubscriptionSchedule({ schedule_enabled:false })
    expect(normalized.timezone).toBe('Etc/GMT-3')
  })

  it('treats a disabled schedule as always active', () => {
    expect(isSubscriptionScheduleActive({ schedule_enabled: 0 })).toBe(true)
  })

  it('applies weekdays and an end-exclusive daily window in the configured timezone', () => {
    expect(isSubscriptionScheduleActive(scheduled(), new Date('2026-07-13T09:30:00Z'))).toBe(true)
    expect(isSubscriptionScheduleActive(scheduled(), new Date('2026-07-13T17:00:00Z'))).toBe(false)
    expect(isSubscriptionScheduleActive(scheduled(), new Date('2026-07-12T10:00:00Z'))).toBe(false)
  })

  it('carries an overnight window into the following day', () => {
    const overnight = scheduled({
      schedule_weekdays_json: '[5]',
      schedule_windows_json: '[{"start":"22:00","end":"02:00"}]',
    })
    expect(isSubscriptionScheduleActive(overnight, new Date('2026-07-17T23:00:00Z'))).toBe(true)
    expect(isSubscriptionScheduleActive(overnight, new Date('2026-07-18T01:00:00Z'))).toBe(true)
    expect(isSubscriptionScheduleActive(overnight, new Date('2026-07-18T03:00:00Z'))).toBe(false)
  })

  it('allows signal generation but blocks execution outside a signals-only window', () => {
    const signalsOnly = scheduled({ outside_window_behavior: 'signals_only' })
    const outside = new Date('2026-07-13T20:00:00Z')
    expect(subscriptionAllowsInference(signalsOnly, outside)).toBe(true)
    expect(subscriptionAllowsExecution(signalsOnly, outside)).toBe(false)
  })

  it('validates timezone, weekdays, window count and time values', () => {
    expect(() => normalizeSubscriptionSchedule({ schedule_enabled:true, schedule_timezone:'Invalid/Zone', schedule_weekdays:[1], schedule_windows:[{ start:'09:00', end:'17:00' }] })).toThrow('invalid_schedule_timezone')
    expect(() => normalizeSubscriptionSchedule({ schedule_enabled:true, schedule_weekdays:[], schedule_windows:[{ start:'09:00', end:'17:00' }] })).toThrow('schedule_weekdays_required')
    expect(() => normalizeSubscriptionSchedule({ schedule_enabled:true, schedule_weekdays:[1], schedule_windows:[{ start:'9:00', end:'17:00' }] })).toThrow('invalid_schedule_time')
  })
})
