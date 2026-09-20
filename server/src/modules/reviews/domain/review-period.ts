export interface ReviewPeriodBoundary {
  utcMsc: number
  offsetMinutes: number
  /** Caller verifies this historical terminal-clock proof; a current offset is not such proof. */
  evidenceRef: string
}
export interface ReviewPeriod {
  kind: 'daily' | 'monthly'
  key: string
  start: ReviewPeriodBoundary
  end: ReviewPeriodBoundary
}

/** Calendar boundaries are supplied independently, allowing a DST change within a day/month. */
export function freezeReviewPeriod(input: ReviewPeriod, asOfUtcMsc: number): ReviewPeriod {
  const period = structuredClone(input)
  const calendar = reviewPeriodCalendar(period.kind,period.key)
  for (const [boundary, expectedLocal] of [[period.start,calendar.localStartMsc],[period.end,calendar.localEndMsc]] as const) {
    if (!boundary || !Number.isSafeInteger(boundary.utcMsc) || boundary.utcMsc <= 0
      || !Number.isInteger(boundary.offsetMinutes) || Math.abs(boundary.offsetMinutes)>840
      || typeof boundary.evidenceRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/.test(boundary.evidenceRef)
      || boundary.utcMsc+boundary.offsetMinutes*60_000 !== expectedLocal) throw Error('review_period_boundary_unproven')
  }
  if (period.end.utcMsc <= period.start.utcMsc || !Number.isSafeInteger(asOfUtcMsc)
    || period.end.utcMsc > asOfUtcMsc) throw Error('review_period_not_closed')
  return period
}

/** Attribute by closure, even if the position opened before this period; the upper bound is exclusive. */
export function belongsToReviewPeriod(period: ReviewPeriod, closedAtUtcMsc: number): boolean {
  return Number.isSafeInteger(closedAtUtcMsc) && closedAtUtcMsc >= period.start.utcMsc && closedAtUtcMsc < period.end.utcMsc
}
import { reviewPeriodCalendar } from './review-period-calendar.js'
