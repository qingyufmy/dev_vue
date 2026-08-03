import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
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
const verifiedUtcClock = { timezoneOffsetMinutes:0, clockStatus:'verified' }

describe('subscription runtime schedule', () => {
  it('defaults new schedules to the bound terminal server timezone', () => {
    expect(SUBSCRIPTION_SCHEDULE_DEFAULTS.timezone).toBe('terminal_server')
    const normalized = normalizeSubscriptionSchedule({ schedule_enabled:false })
    expect(normalized.timezone).toBe('terminal_server')
  })

  it('treats a disabled schedule as always active', () => {
    expect(isSubscriptionScheduleActive({ schedule_enabled: 0 })).toBe(true)
  })

  it('applies weekdays and an end-exclusive daily window in the configured timezone', () => {
    expect(isSubscriptionScheduleActive(scheduled(), new Date('2026-07-13T09:30:00Z'), verifiedUtcClock)).toBe(true)
    expect(isSubscriptionScheduleActive(scheduled(), new Date('2026-07-13T17:00:00Z'), verifiedUtcClock)).toBe(false)
    expect(isSubscriptionScheduleActive(scheduled(), new Date('2026-07-12T10:00:00Z'), verifiedUtcClock)).toBe(false)
  })

  it('carries an overnight window into the following day', () => {
    const overnight = scheduled({
      schedule_weekdays_json: '[5]',
      schedule_windows_json: '[{"start":"22:00","end":"02:00"}]',
    })
    expect(isSubscriptionScheduleActive(overnight, new Date('2026-07-17T23:00:00Z'), verifiedUtcClock)).toBe(true)
    expect(isSubscriptionScheduleActive(overnight, new Date('2026-07-18T01:00:00Z'), verifiedUtcClock)).toBe(true)
    expect(isSubscriptionScheduleActive(overnight, new Date('2026-07-18T03:00:00Z'), verifiedUtcClock)).toBe(false)
  })

  it('allows signal generation but blocks execution outside a signals-only window', () => {
    const signalsOnly = scheduled({ outside_window_behavior: 'signals_only' })
    const outside = new Date('2026-07-13T20:00:00Z')
    expect(subscriptionAllowsInference(signalsOnly, outside, verifiedUtcClock)).toBe(true)
    expect(subscriptionAllowsExecution(signalsOnly, outside, verifiedUtcClock)).toBe(false)
  })

  it('validates timezone, weekdays, window count and time values', () => {
    expect(normalizeSubscriptionSchedule({ schedule_enabled:true, schedule_timezone:'Invalid/Zone', schedule_weekdays:[1], schedule_windows:[{ start:'09:00', end:'17:00' }] }).timezone).toBe('terminal_server')
    expect(() => normalizeSubscriptionSchedule({ schedule_enabled:true, schedule_weekdays:[], schedule_windows:[{ start:'09:00', end:'17:00' }] })).toThrow('schedule_weekdays_required')
    expect(() => normalizeSubscriptionSchedule({ schedule_enabled:true, schedule_weekdays:[1], schedule_windows:[{ start:'9:00', end:'17:00' }] })).toThrow('invalid_schedule_time')
  })

  it('pauses a time-sensitive schedule when the terminal clock has never been verified', () => {
    expect(isSubscriptionScheduleActive(scheduled(), new Date('2026-07-13T09:30:00Z'))).toBe(false)
  })

  it('migrates legacy fixed and IANA timezones to the terminal clock contract', () => {
    const migrations = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    expect(migrations).toContain("id: '157_terminal_server_schedule_timezone'")
    expect(migrations).toContain("DEFAULT 'terminal_server'")
    expect(migrations).toContain("SET schedule_timezone = 'terminal_server'")
  })
})
