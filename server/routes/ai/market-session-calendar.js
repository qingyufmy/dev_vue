// Versioned, conservative market-session closure classifier.  A gap is only
// expected when every theoretical missing bar opens inside a known closure;
// merely crossing a UTC weekend is never sufficient.

export const MARKET_SESSION_CALENDAR_VERSION = 'xauusd-session-v2'
const SUPPORTED_SYMBOLS = new Set(['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD'])
const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

function utcDate(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0)
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase().replace(/\.[A-Z0-9]+$/, '')
}

function validOffset(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= -14 * 60 && number <= 14 * 60 ? Math.trunc(number) : null
}

function timezoneOffsetAt(utcMs, options = {}) {
  const timezone = String(options.sessionTimezone || options.session_timezone || '').trim()
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone:timezone, hour12:false, year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit',
      }).formatToParts(new Date(utcMs))
      const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
      const asUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour === 24 ? 0 : values.hour, values.minute, values.second)
      const offset = Math.round((asUtc - Number(utcMs)) / MINUTE_MS)
      return validOffset(offset)
    } catch {
      return null
    }
  }
  const explicit = validOffset(options.sessionTimezoneOffsetMinutes
    ?? options.timezoneOffsetMinutes
    ?? options.timezone_offset_minutes)
  if (explicit != null) return explicit
  return options.strict === true || options.strictSessionPolicy === true ? null : 0
}

function localDateParts(utcMs, offsetMinutes) {
  const date = new Date(Number(utcMs) + Number(offsetMinutes || 0) * MINUTE_MS)
  return {
    year:date.getUTCFullYear(), month:date.getUTCMonth() + 1, day:date.getUTCDate(),
    weekday:date.getUTCDay(), minutes:date.getUTCHours() * 60 + date.getUTCMinutes(),
  }
}

function localDayKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function holidayClosure(parts) {
  // These are intentionally broad only for the two existing fixed holiday
  // windows.  Other holidays must be supplied by a future policy version.
  if (parts.month === 12 && parts.day === 24 && parts.minutes >= 17 * 60) return { code:'christmas_closure', name:'Christmas' }
  if (parts.month === 12 && parts.day === 25 && parts.minutes < 21 * 60) return { code:'christmas_closure', name:'Christmas' }
  if (parts.month === 12 && parts.day === 31 && parts.minutes >= 17 * 60) return { code:'new_year_closure', name:'New Year' }
  if (parts.month === 1 && parts.day === 1 && parts.minutes < 21 * 60) return { code:'new_year_closure', name:'New Year' }
  return null
}

function weekendClosure(parts) {
  // Typical FX/metal policy represented in the supplied session timezone:
  // Friday 22:00 through Sunday 22:00.  The policy is deliberately not
  // inferred from UTC weekdays, so DST/session offsets remain explicit.
  return parts.weekday === 6
    || (parts.weekday === 5 && parts.minutes >= 22 * 60)
    || (parts.weekday === 0 && parts.minutes < 22 * 60)
}

function knownPolicy(options = {}) {
  const symbol = normalizeSymbol(options.standardSymbol || options.symbol)
  const supportedSymbols = options.supportedSymbols instanceof Set
    ? options.supportedSymbols : SUPPORTED_SYMBOLS
  const policyVersion = String(options.policyVersion || options.marketSessionPolicyVersion
    || options.market_session_policy_version || MARKET_SESSION_CALENDAR_VERSION)
  if (!supportedSymbols.has(symbol) || policyVersion !== MARKET_SESSION_CALENDAR_VERSION) return false
  const strict = options.strict === true || options.strictSessionPolicy === true
  const clockStatus = String(options.clockStatus || options.clock_status || '').trim().toLowerCase()
  if (clockStatus && !['calibrated', 'verified', 'observer_bootstrap'].includes(clockStatus)) return false
  if (strict && (!clockStatus || !['calibrated', 'verified', 'observer_bootstrap'].includes(clockStatus))) return false
  if (strict) {
    const timezone = String(options.sessionTimezone || options.session_timezone || '').trim()
    const explicitOffset = validOffset(options.sessionTimezoneOffsetMinutes
      ?? options.timezoneOffsetMinutes ?? options.timezone_offset_minutes)
    if (!timezone && explicitOffset == null) return false
  }
  return timezoneOffsetAt(Date.now(), options) != null
}

function classifyBar(openUtcMs, intervalMs, options = {}) {
  const offset = timezoneOffsetAt(openUtcMs, options)
  if (offset == null) return null
  const parts = localDateParts(openUtcMs, offset)
  const holiday = holidayClosure(parts)
  if (holiday) return { classification:'holiday_closure', reason:holiday.code, ...holiday, offset_minutes:offset }
  if (weekendClosure(parts)) return { classification:'weekend_closure', reason:'weekend', offset_minutes:offset }
  return null
}

export function classifyMarketClosure(startUtcMs, endUtcMs, timeframe, options = {}) {
  const start = Number(startUtcMs)
  const end = Number(endUtcMs)
  const intervalMs = Math.max(1, Number(options.intervalMs || options.interval_ms) || 0)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !intervalMs) return null
  if (!knownPolicy(options)) {
    return {
      classification:'unknown_session', reason:'market_session_policy_unavailable', known:false,
      calendar_version:MARKET_SESSION_CALENDAR_VERSION, timeframe:String(timeframe || '').toUpperCase() || null,
    }
  }
  const missing = []
  for (let cursor = start + intervalMs; cursor < end; cursor += intervalMs) {
    missing.push(cursor)
    // Avoid an accidental unbounded loop if a corrupt interval is supplied.
    if (missing.length > 100000) return { classification:'unknown_session', reason:'gap_too_large', known:false, calendar_version:MARKET_SESSION_CALENDAR_VERSION }
  }
  if (!missing.length) return null
  let first = null
  for (const openUtcMs of missing) {
    const closure = classifyBar(openUtcMs, intervalMs, options)
    if (!closure) return null
    first ||= closure
  }
  return {
    ...first,
    known:true,
    calendar_version:MARKET_SESSION_CALENDAR_VERSION,
    timeframe:String(timeframe || '').toUpperCase() || null,
    from_utc_msc:start, to_utc_msc:end,
    missing_bar_count:missing.length,
  }
}

export function classifyContinuityGap(startUtcMs, endUtcMs, timeframe, options = {}) {
  return classifyMarketClosure(startUtcMs, endUtcMs, timeframe, options)
}

export const __marketSessionCalendarTest = {
  utcDate, localDateParts, localDayKey, holidayClosure, weekendClosure, timezoneOffsetAt,
}
