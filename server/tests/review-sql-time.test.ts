import { expect, it } from 'vitest'
import { reviewSqlTime, reviewIsoTime } from '../src/modules/reviews/infrastructure/review-sql-time.js'
it('binds explicit UTC as MySQL DATETIME and interprets dateStrings as UTC', () => {
  expect(reviewSqlTime('2026-09-09T12:00:00.123Z')).toBe('2026-09-09 12:00:00.123')
  expect(reviewIsoTime('2026-09-09 12:00:00.123')).toBe('2026-09-09T12:00:00.123Z')
  expect(reviewIsoTime(new Date('2026-09-09T12:00:00.123Z'))).toBe('2026-09-09T12:00:00.123Z')
})
it.each(['2026-02-30T00:00:00Z','2026-09-09 12:00:00','2026-09-09T12:00:00+03:00','invalid'])('rejects ambiguous or invalid write time %s', value => {
  expect(() => reviewSqlTime(value)).toThrow('review_time_invalid')
})
