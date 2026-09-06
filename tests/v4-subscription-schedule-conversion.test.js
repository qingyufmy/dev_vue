import { describe, expect, it } from 'vitest'
import { convertSubscriptionSchedule } from '../scripts/lib/v4-subscription-schedule-conversion.mjs'
import { normalizeSubscriptionSchedule, subscriptionAllowsInference, subscriptionAllowsExecution } from '../server/routes/ai/subscription-schedule.js'

const source = (overrides = {}) => ({ schedule_enabled: '1', schedule_timezone: 'terminal_server',
  schedule_weekdays_json: '[1]', schedule_windows_json: '[{"start":"22:00","end":"02:00"}]',
  outside_window_behavior: 'pause_all', ...overrides })
const restored = candidate => ({ schedule_enabled: Number(candidate.enabled), schedule_timezone: candidate.timezone,
  schedule_weekdays_json: JSON.stringify(candidate.weekdays), schedule_windows_json: JSON.stringify(candidate.windows),
  outside_window_behavior: candidate.outsideBehavior })

describe('subscription schedule conversion', () => {
  it('keeps terminal-relative overnight windows and their selected starting weekday', () => {
    const row = source(), result = convertSubscriptionSchedule(row)
    expect(result.status).toBe('converted')
    expect(result.candidate.windows).toEqual([{ start: '22:00', end: '02:00' }])
    const clock = { timezoneOffsetMinutes: 180, clockStatus: 'calibrated' }
    for (const [utc, allowed] of [['2026-09-07T18:59:00Z', false], ['2026-09-07T19:00:00Z', true],
      ['2026-09-07T22:59:00Z', true], ['2026-09-07T23:00:00Z', false], ['2026-09-08T19:00:00Z', false]]) {
      expect(subscriptionAllowsExecution(restored(result.candidate), new Date(utc), clock)).toBe(allowed)
      expect(subscriptionAllowsExecution(row, new Date(utc), clock)).toBe(allowed)
    }
    expect(result.executable).toBe(false)
  })
  it('preserves equal endpoints as full selected day, not an empty interval', () => {
    const result = convertSubscriptionSchedule(source({ schedule_windows_json: '[{"start":"10:00","end":"10:00"}]' }))
    expect(subscriptionAllowsExecution(restored(result.candidate), new Date('2026-09-07T00:00:00Z'), { timezoneOffsetMinutes: 0, clockStatus: 'calibrated' })).toBe(true)
  })
  it('preserves exclusive 23:59 and signals-only outside behavior', () => {
    const result = convertSubscriptionSchedule(source({ schedule_windows_json: null, outside_window_behavior: 'signals_only' }))
    const row = restored(result.candidate), clock = { timezoneOffsetMinutes: 0, clockStatus: 'calibrated' }
    expect(subscriptionAllowsExecution(row, new Date('2026-09-07T23:58:59Z'), clock)).toBe(true)
    expect(subscriptionAllowsExecution(row, new Date('2026-09-07T23:59:00Z'), clock)).toBe(false)
    expect(subscriptionAllowsInference(row, new Date('2026-09-07T23:59:00Z'), clock)).toBe(true)
  })
  it('records legacy timezone normalization without turning UTC+3 display fallback into clock evidence', () => {
    const row = source({ schedule_timezone: 'Asia/Shanghai' }), result = convertSubscriptionSchedule(row)
    expect(result.timezoneNormalized).toBe(true)
    expect(result.candidate.timezone).toBe(normalizeSubscriptionSchedule({}, row).timezone)
    expect(subscriptionAllowsExecution(restored(result.candidate), new Date('2026-09-07T19:00:00Z'), { timezoneOffsetMinutes: 180, clockStatus: 'fallback' })).toBe(false)
    expect(result.blockers).toContain('terminal_clock_trust_policy')
  })
  it('records null defaults and retains disabled empty lists', () => {
    const result = convertSubscriptionSchedule(source({ schedule_weekdays_json: null, schedule_windows_json: null, outside_window_behavior: null }))
    expect(result.defaultsApplied).toHaveLength(3)
    expect(result.candidate.weekdays).toEqual([1, 2, 3, 4, 5])
    const disabled = convertSubscriptionSchedule(source({ schedule_enabled: '0', schedule_weekdays_json: '[]', schedule_windows_json: '[]' }))
    expect(disabled.candidate.windows).toEqual([])
    expect(subscriptionAllowsExecution(restored(disabled.candidate), new Date(), {})).toBe(true)
  })
  it('blocks malformed source instead of silently widening runtime defaults', () => {
    for (const changes of [{ schedule_weekdays_json: '' }, { schedule_weekdays_json: '["1"]' }, { schedule_weekdays_json: '[7]' },
      { schedule_weekdays_json: '[]' }, { schedule_windows_json: '[]' }, { schedule_windows_json: '{}' },
      { schedule_windows_json: '[{"start":"24:00","end":"02:00"}]' },
      { schedule_windows_json: '[{"start":"00:00","end":"02:00","extra":true}]' },
      { schedule_windows_json: JSON.stringify(Array(7).fill({ start: '00:00', end: '01:00' })) },
      { schedule_enabled: '2' }, { outside_window_behavior: 'allow_all' }]) {
      const result = convertSubscriptionSchedule(source(changes))
      expect(result.status).toBe('blocked')
      expect(result.candidate).toBeNull()
    }
    expect(() => convertSubscriptionSchedule({})).toThrow('schedule_source_shape_invalid')
  })
  it('deduplicates weekdays while hashing exact source spelling', () => {
    const a = convertSubscriptionSchedule(source({ schedule_weekdays_json: '[2,1,1]' }))
    const b = convertSubscriptionSchedule(source({ schedule_weekdays_json: '[1,2]' }))
    expect(a.candidate).toEqual(b.candidate)
    expect(a.sourceHash).not.toBe(b.sourceHash)
  })
})
