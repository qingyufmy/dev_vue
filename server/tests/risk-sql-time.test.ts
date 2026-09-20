import { expect, it } from 'vitest'
import { riskSqlTime } from '../src/modules/risk/infrastructure/risk-sql-time.js'

it('preserves UTC milliseconds without host timezone conversion', () => {
  expect(riskSqlTime('2026-09-08T23:59:59.123Z')).toBe('2026-09-08 23:59:59.123')
})
it('rejects ambiguous offsets, impossible calendar dates and missing milliseconds', () => {
  for (const value of ['2026-09-09 00:00:00', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00.000+03:00', '2026-02-30T00:00:00.000Z']) {
    expect(() => riskSqlTime(value)).toThrow('risk_timestamp_invalid')
  }
})
