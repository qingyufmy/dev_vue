import { expect, it } from 'vitest'
import { strategyIsoTime, strategySqlTime } from '../src/modules/strategies/infrastructure/strategy-sql-time.js'

it('binds UTC instants as MySQL datetime text and reads dateStrings without the machine timezone', () => {
  expect(strategySqlTime('2026-09-09T08:10:00.123Z')).toBe('2026-09-09 08:10:00.123')
  expect(strategySqlTime('2026-09-09T08:10:00Z')).toBe('2026-09-09 08:10:00.000')
  for (const value of ['2026-09-09 08:10:00', '2026-09-09 08:10:00.0', '2026-09-09T08:10:00Z']) {
    expect(strategyIsoTime(value)).toBe('2026-09-09T08:10:00.000Z')
  }
  expect(strategyIsoTime('2026-09-09 08:10:00.12')).toBe('2026-09-09T08:10:00.120Z')
  for (const value of ['2026-02-30T00:00:00.000Z', '2026-09-09T24:00:00Z', '2026-09-09T08:10:00+03:00', '2026-09-09T08:10:00Z\n']) {
    expect(() => strategySqlTime(value)).toThrow('strategy_time_invalid')
  }
})
