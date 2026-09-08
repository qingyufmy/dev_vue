export interface FreshnessPoint {
  observationAt: string
  availableAt: string
  value: string | null
  calendar: string
  freshnessLimitSeconds: number
}

// Intervals are UTC and half-open. A source-owned, versioned calendar supplies
// exact counted time, including holidays and DST, rather than guessing weekends.
export interface SourceFreshnessCalendar {
  id: string
  coverageFrom: string
  coverageTo: string
  intervals: readonly { from: string; to: string }[]
  maxWallAgeSeconds: number
}

export class MacroFreshnessPolicy {
  private readonly calendars = new Map<string, { from: number; to: number; maxAge: number; intervals: { from: number; to: number }[] }>()

  constructor(calendars: readonly SourceFreshnessCalendar[] = []) {
    for (const calendar of calendars) {
      const from = Date.parse(calendar.coverageFrom), to = Date.parse(calendar.coverageTo)
      if (!calendar.id || calendar.id === 'utc_elapsed_v1' || this.calendars.has(calendar.id)
        || !Number.isFinite(from) || !Number.isFinite(to) || from >= to
        || !Number.isSafeInteger(calendar.maxWallAgeSeconds) || calendar.maxWallAgeSeconds < 60) throw Error('macro_calendar_invalid')
      let previous = from
      const intervals = calendar.intervals.map(interval => {
        const start = Date.parse(interval.from), end = Date.parse(interval.to)
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < previous || end <= start || end > to) throw Error('macro_calendar_invalid')
        previous = end
        return { from: start, to: end }
      })
      this.calendars.set(calendar.id, { from, to, maxAge: calendar.maxWallAgeSeconds * 1000, intervals })
    }
  }

  evaluate(point: FreshnessPoint, asOf: string): 'fresh' | 'stale' | 'missing' | 'invalid' {
    const start = Date.parse(point.observationAt), end = Date.parse(asOf), available = Date.parse(point.availableAt)
    if (![start, end, available].every(Number.isFinite) || start > end || available > end
      || !Number.isInteger(point.freshnessLimitSeconds) || point.freshnessLimitSeconds < 60
      || point.freshnessLimitSeconds > 31536000) return 'invalid'
    if (point.value === null) return 'missing'
    if (!/^-?\d+(?:\.\d+)?$/.test(point.value)) return 'invalid'
    let age = end - start
    if (point.calendar !== 'utc_elapsed_v1') {
      const calendar = this.calendars.get(point.calendar)
      if (!calendar || start < calendar.from || end > calendar.to) return 'invalid'
      // Closed days must not hide a prolonged provider outage.
      if (age > calendar.maxAge) return 'stale'
      age = calendar.intervals.reduce((total, interval) => total + Math.max(0, Math.min(end, interval.to) - Math.max(start, interval.from)), 0)
    }
    return age <= point.freshnessLimitSeconds * 1000 ? 'fresh' : 'stale'
  }
}
