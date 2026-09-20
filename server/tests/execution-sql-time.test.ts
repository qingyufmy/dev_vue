import { expect, it } from 'vitest'
import { executionSqlTime, executionIsoTime } from '../src/modules/execution/infrastructure/execution-sql-time.js'
it('roundtrips UTC DATETIME without interpreting it in the local timezone', () => {
  expect(executionSqlTime('2026-09-11T00:00:00.123Z')).toBe('2026-09-11 00:00:00.123')
  expect(executionIsoTime('2026-09-11 00:00:00.123')).toBe('2026-09-11T00:00:00.123Z')
})
it.each(['2026-02-30T00:00:00.000Z', '2026-09-11 00:00:00', '2026-09-11T08:00:00.000+08:00'])('rejects invalid or ambiguous write time %s', value => {
  expect(() => executionSqlTime(value)).toThrow('execution_time_invalid')
})
