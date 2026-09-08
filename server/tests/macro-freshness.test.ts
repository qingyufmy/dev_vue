import { expect, it } from 'vitest'
import { MacroFreshnessPolicy, type SourceFreshnessCalendar } from '../src/modules/market/domain/macro-freshness.js'

const at = (day: string) => `2026-09-${day}T00:00:00.000Z`
const point = { observationAt: at('04'), availableAt: at('04'), value: '1.23', calendar: 'fixture-v1', freshnessLimitSeconds: 86400 }
// Deliberately synthetic: not a US or Cboe publication calendar.
const calendar: SourceFreshnessCalendar = { id: 'fixture-v1', coverageFrom: at('01'), coverageTo: at('15'), maxWallAgeSeconds: 7 * 86400,
  intervals: [{ from: at('04'), to: at('05') }, { from: at('08'), to: at('09') }] }

it('counts approved intervals, preserves holiday gaps and enforces exact threshold and wall age', () => {
  const policy = new MacroFreshnessPolicy([calendar])
  expect(policy.evaluate(point, at('08'))).toBe('fresh')
  expect(policy.evaluate(point, '2026-09-08T00:00:00.001Z')).toBe('stale')
  expect(policy.evaluate({ ...point, freshnessLimitSeconds: 10 * 86400 }, at('12'))).toBe('stale')
  expect(policy.evaluate({ ...point, calendar: 'utc_elapsed_v1' }, at('05'))).toBe('fresh')
  expect(policy.evaluate({ ...point, calendar: 'utc_elapsed_v1' }, at('06'))).toBe('stale')
})

it('does not turn missing, future, unknown-calendar or out-of-coverage data into fresh facts', () => {
  const policy = new MacroFreshnessPolicy([calendar])
  expect(policy.evaluate({ ...point, value: null }, at('08'))).toBe('missing')
  expect(policy.evaluate({ ...point, calendar: 'not-registered' }, at('08'))).toBe('invalid')
  expect(policy.evaluate(point, at('16'))).toBe('invalid')
  expect(policy.evaluate({ ...point, observationAt: '2026-08-31T00:00:00.000Z' }, at('08'))).toBe('invalid')
  expect(policy.evaluate({ ...point, availableAt: at('09') }, at('08'))).toBe('invalid')
  expect(policy.evaluate({ ...point, value: 'NaN' }, at('08'))).toBe('invalid')
})

it('rejects overlapping calendars and snapshots caller-owned interval definitions', () => {
  expect(() => new MacroFreshnessPolicy([{ ...calendar, intervals: [{ from: at('04'), to: at('09') }, { from: at('08'), to: at('10') }] }])).toThrow('macro_calendar_invalid')
  expect(() => new MacroFreshnessPolicy([calendar, calendar])).toThrow('macro_calendar_invalid')
  const mutable = { ...calendar, intervals: [...calendar.intervals] }
  const policy = new MacroFreshnessPolicy([mutable])
  mutable.intervals.length = 0
  expect(policy.evaluate(point, at('09'))).toBe('stale')
})
