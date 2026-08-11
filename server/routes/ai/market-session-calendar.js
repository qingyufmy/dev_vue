// Deterministic, dependency-free market-session closure classification.
// This is intentionally conservative: only known closures are released from
// the continuity failure gate.  Unknown weekday gaps remain suspicious.

export const MARKET_SESSION_CALENDAR_VERSION = 'xauusd-fixed-holiday-v1'
const SUPPORTED_HOLIDAY_SYMBOLS = new Set(['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD'])

const DAY_MS = 24 * 60 * 60 * 1000

function utcDate(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0)
}

function holidayWindows(year) {
  return [
    {
      code: 'christmas_closure',
      name: 'Christmas',
      start_utc_msc: utcDate(year, 12, 24, 17),
      end_utc_msc: utcDate(year, 12, 25, 21),
    },
    {
      code: 'new_year_closure',
      name: 'New Year',
      start_utc_msc: utcDate(year, 12, 31, 17),
      end_utc_msc: utcDate(year + 1, 1, 1, 21),
    },
  ]
}

function candidateHolidayWindows(startUtcMs, endUtcMs) {
  const startYear = new Date(startUtcMs).getUTCFullYear() - 1
  const endYear = new Date(endUtcMs).getUTCFullYear() + 1
  const result = []
  for (let year = startYear; year <= endYear; year++) result.push(...holidayWindows(year))
  return result
}

function crossesWeekend(startUtcMs, endUtcMs) {
  const first = new Date(startUtcMs)
  const last = new Date(endUtcMs)
  // Check UTC calendar days covered by a gap; a weekend is an expected market
  // closure for the supported FX/metal sessions.
  for (let cursor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
    cursor <= last.getTime(); cursor += DAY_MS) {
    const day = new Date(cursor).getUTCDay()
    if (day === 0 || day === 6) return true
  }
  return false
}

export function classifyMarketClosure(startUtcMs, endUtcMs, timeframe, options = {}) {
  const start = Number(startUtcMs)
  const end = Number(endUtcMs)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  const intervalMs = Math.max(1, Number(options.intervalMs) || 0)
  const standardSymbol = String(options.standardSymbol || '').trim().toUpperCase()
  const holidayCalendarEnabled = SUPPORTED_HOLIDAY_SYMBOLS.has(standardSymbol)
  const windows = holidayCalendarEnabled ? candidateHolidayWindows(start, end) : []
  const holiday = windows.find(window => (
    start >= window.start_utc_msc - intervalMs
      && end <= window.end_utc_msc + intervalMs
      && end >= window.start_utc_msc
      && start <= window.end_utc_msc
  ))
  if (holiday) {
    return {
      classification: 'holiday_closure',
      reason: holiday.code,
      calendar_version: MARKET_SESSION_CALENDAR_VERSION,
      timeframe: String(timeframe || '').toUpperCase() || null,
      ...holiday,
    }
  }
  if (crossesWeekend(start, end)) {
    return {
      classification: 'weekend_closure',
      reason: 'weekend',
      calendar_version: MARKET_SESSION_CALENDAR_VERSION,
      timeframe: String(timeframe || '').toUpperCase() || null,
    }
  }
  return null
}

export function classifyContinuityGap(startUtcMs, endUtcMs, timeframe, options = {}) {
  return classifyMarketClosure(startUtcMs, endUtcMs, timeframe, options)
}

export const __marketSessionCalendarTest = { utcDate, holidayWindows, crossesWeekend }
