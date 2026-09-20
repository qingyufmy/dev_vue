import { expect, it } from 'vitest'
import { listReviewPeriodCalendars, reviewPeriodCalendar } from '../src/modules/reviews/domain/review-period-calendar.js'

it('paginates calendar candidates without duplicates and includes monthly scopes', () => {
  const range = { rangeStartUtcMsc: Date.parse('2024-02-01T00:00:00Z'), rangeEndUtcMsc: Date.parse('2024-03-02T00:00:00Z') }
  const all = listReviewPeriodCalendars({ ...range, after: null, limit: 100 }).items
  const collected = []; let cursor: string | null = null
  do {
    const page = listReviewPeriodCalendars({ ...range, after: cursor, limit: 3 })
    collected.push(...page.items); cursor = page.next
  } while (cursor !== null)
  expect(collected).toEqual(all)
  expect(new Set(all.map(item => item.cursor)).size).toBe(all.length)
  expect(all.some(item => item.cursor === 'daily:2024-02-29')).toBe(true)
  expect(all.some(item => item.cursor === 'monthly:2024-02')).toBe(true)
  expect(all.some(item => item.cursor === 'monthly:2024-03')).toBe(false)
})
it('seeks directly past daily work when continuing monthly discovery', () => {
  const page = listReviewPeriodCalendars({ rangeStartUtcMsc: Date.parse('2000-01-01T00:00:00Z'),
    rangeEndUtcMsc: Date.parse('2026-09-11T00:00:00Z'), after: 'monthly:2026-07', limit: 1 })
  expect(page.items.map(item => item.cursor)).toEqual(['monthly:2026-08'])
  expect(page.next).toBe(null)
})
it('validates calendar keys and preserves local labels for later historical timezone resolution', () => {
  expect(() => reviewPeriodCalendar('daily','2026-02-30')).toThrow('review_period_key_invalid')
  const month = reviewPeriodCalendar('monthly','2024-02')
  expect(month.localEndMsc-month.localStartMsc).toBe(29*86400000)
  expect(() => listReviewPeriodCalendars({ rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000, after: 'daily:bad', limit: 2 })).toThrow()
})
