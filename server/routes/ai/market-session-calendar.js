// Market-session closure classification is deliberately fail-closed.  A gap
// is expected only when every theoretical missing bar opens inside an explicit
// closure from the exact, versioned policy for the current market source.

import {
  MARKET_SESSION_POLICY_ENGINE_VERSION,
  getMarketSessionPolicyMode,
  resolveMarketSessionPolicy,
} from './market-session-policy.js'

// Keep the legacy calendar identifier stable for existing snapshots and
// consumers.  The new policy engine has its own explicit engine version and
// policy hash, so a calendar-version bump is not needed for compatibility.
export const MARKET_SESSION_CALENDAR_VERSION = 'xauusd-session-v2'
export const MARKET_SESSION_ENGINE_VERSION = MARKET_SESSION_POLICY_ENGINE_VERSION
const SUPPORTED_SYMBOLS = new Set(['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD'])
const MINUTE_MS = 60 * 1000
const MAX_MISSING_BARS = 100000
const VALID_CLOCK_STATUSES = new Set(['calibrated', 'verified', 'observer_bootstrap', 'mt4_current_offset'])

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
    weekday:date.getUTCDay(), isoWeekday:date.getUTCDay() || 7,
    minutes:date.getUTCHours() * 60 + date.getUTCMinutes(),
  }
}

function localDayKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function holidayClosure(parts) {
  // Compatibility-only holidays.  New deployments must define their holidays
  // in the exact market-session policy instead of relying on this fallback.
  if (parts.month === 12 && parts.day === 24 && parts.minutes >= 17 * 60) return { code:'christmas_closure', name:'Christmas' }
  if (parts.month === 12 && parts.day === 25 && parts.minutes < 21 * 60) return { code:'christmas_closure', name:'Christmas' }
  if (parts.month === 12 && parts.day === 31 && parts.minutes >= 17 * 60) return { code:'new_year_closure', name:'New Year' }
  if (parts.month === 1 && parts.day === 1 && parts.minutes < 21 * 60) return { code:'new_year_closure', name:'New Year' }
  return null
}

function weekendClosure(parts) {
  // Compatibility-only generic weekend.  Strict enforce mode never infers a
  // weekend rule without a matching policy.
  return parts.weekday === 6
    || (parts.weekday === 5 && parts.minutes >= 22 * 60)
    || (parts.weekday === 0 && parts.minutes < 22 * 60)
}

function knownLegacyPolicy(options = {}) {
  const symbol = normalizeSymbol(options.standardSymbol || options.symbol)
  const supportedSymbols = options.supportedSymbols instanceof Set
    ? options.supportedSymbols : SUPPORTED_SYMBOLS
  const policyVersion = String(options.policyVersion || options.marketSessionPolicyVersion
    || options.market_session_policy_version || MARKET_SESSION_CALENDAR_VERSION)
  if (!supportedSymbols.has(symbol) || policyVersion !== MARKET_SESSION_CALENDAR_VERSION) return false
  const strict = options.strict === true || options.strictSessionPolicy === true
  const clockStatus = String(options.clockStatus || options.clock_status || '').trim().toLowerCase()
  if (clockStatus && !VALID_CLOCK_STATUSES.has(clockStatus)) return false
  if (strict && (!clockStatus || !VALID_CLOCK_STATUSES.has(clockStatus))) return false
  if (strict) {
    const timezone = String(options.sessionTimezone || options.session_timezone || '').trim()
    const explicitOffset = validOffset(options.sessionTimezoneOffsetMinutes
      ?? options.timezoneOffsetMinutes ?? options.timezone_offset_minutes)
    if (!timezone && explicitOffset == null) return false
  }
  return timezoneOffsetAt(Date.now(), options) != null
}

function classifyLegacyBar(openUtcMs, options = {}) {
  const offset = timezoneOffsetAt(openUtcMs, options)
  if (offset == null) return null
  const parts = localDateParts(openUtcMs, offset)
  const holiday = holidayClosure(parts)
  if (holiday) return { classification:'holiday_closure', reason:holiday.code, ...holiday, offset_minutes:offset }
  if (weekendClosure(parts)) return { classification:'weekend_closure', reason:'weekend', offset_minutes:offset }
  return null
}

function parseBrokerTime(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/)
  if (!match) return null
  const [, year, month, day, hour, minute, second = '0', fraction = '0'] = match
  const localAsUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0')))
  if (!Number.isFinite(localAsUtc)) return null
  return { localAsUtc, year:Number(year), month:Number(month), day:Number(day), hour:Number(hour), minute:Number(minute), second:Number(second) }
}

function historicalOffset(utcMs, brokerTime) {
  const parsed = parseBrokerTime(brokerTime)
  if (!parsed || !Number.isFinite(Number(utcMs))) return null
  const offset = Math.round((parsed.localAsUtc - Number(utcMs)) / MINUTE_MS)
  return validOffset(offset)
}

function policyMeta(policyMatch, mode) {
  return {
    mode,
    matched:Boolean(policyMatch?.matched),
    policy_id:policyMatch?.policy_id || null,
    policy_version:policyMatch?.policy_version || null,
    policy_hash:policyMatch?.policy_hash || null,
    reason:policyMatch?.reason || null,
  }
}

function transitionAt(policy, startUtcMs, endUtcMs, startOffset, endOffset) {
  const transitions = Array.isArray(policy?.dst_transitions) ? policy.dst_transitions : []
  return transitions.find(transition => Number(transition.at_utc_msc) >= Number(startUtcMs)
    && Number(transition.at_utc_msc) <= Number(endUtcMs)
    && Number(transition.from_offset_minutes) === Number(startOffset)
    && Number(transition.to_offset_minutes) === Number(endOffset)) || null
}

function offsetsForGap(startUtcMs, endUtcMs, options, policy) {
  const startOffset = historicalOffset(startUtcMs, options.startBrokerTime ?? options.start_broker_time)
  const endOffset = historicalOffset(endUtcMs, options.endBrokerTime ?? options.end_broker_time)
  if (startOffset != null && endOffset != null && startOffset === endOffset) {
    return { offsets:[{ from:startUtcMs, to:endUtcMs, offset:startOffset }], source:'broker_time' }
  }
  if (startOffset != null && endOffset != null && startOffset !== endOffset) {
    const transition = transitionAt(policy, startUtcMs, endUtcMs, startOffset, endOffset)
    if (!transition) return null
    return {
      offsets:[
        { from:startUtcMs, to:Number(transition.at_utc_msc), offset:startOffset },
        { from:Number(transition.at_utc_msc), to:endUtcMs, offset:endOffset },
      ],
      source:'broker_time_dst', transition,
    }
  }
  const explicit = validOffset(options.sessionTimezoneOffsetMinutes
    ?? options.timezoneOffsetMinutes ?? options.timezone_offset_minutes)
  if (explicit != null && String(options.clockStatus || options.clock_status || '').trim()) {
    if ((startOffset != null && startOffset !== explicit) || (endOffset != null && endOffset !== explicit)) return null
    return { offsets:[{ from:startUtcMs, to:endUtcMs, offset:explicit }], source:'configured_offset' }
  }
  return null
}

function offsetAtCursor(cursor, offsetInfo) {
  const segment = offsetInfo?.offsets?.find(item => cursor >= item.from && cursor < item.to)
  return segment?.offset ?? null
}

function previousLocalDate(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - 86400000)
  return { year:date.getUTCFullYear(), month:date.getUTCMonth() + 1, day:date.getUTCDate(), isoWeekday:date.getUTCDay() || 7 }
}

function matchesWindow(parts, rule, { date = null } = {}) {
  const candidateMinutes = parts.minutes
  const from = Number(rule.from_minutes)
  const to = Number(rule.to_minutes)
  const overnight = to < from
  let activeDate = { year:parts.year, month:parts.month, day:parts.day, isoWeekday:parts.isoWeekday }
  let inWindow = candidateMinutes >= from && candidateMinutes < to
  if (!overnight) {
    inWindow = candidateMinutes >= from && candidateMinutes < to
  } else if (candidateMinutes >= from) {
    inWindow = true
  } else if (candidateMinutes < to) {
    activeDate = previousLocalDate(parts)
    inWindow = true
  } else {
    inWindow = false
  }
  if (!inWindow) return false
  if (date && `${activeDate.year}-${String(activeDate.month).padStart(2, '0')}-${String(activeDate.day).padStart(2, '0')}` !== date) return false
  if (Array.isArray(rule.weekdays) && !rule.weekdays.includes(activeDate.isoWeekday)) return false
  return true
}

function classifyPolicyBar(openUtcMs, offset, policy) {
  const parts = localDateParts(openUtcMs, offset)
  const matches = []
  for (const rule of policy?.daily_closures || []) {
    if (matchesWindow(parts, rule)) matches.push(rule)
  }
  for (const rule of policy?.weekly_closures || []) {
    if (matchesWindow(parts, rule)) matches.push(rule)
  }
  for (const rule of policy?.holiday_closures || []) {
    if (matchesWindow(parts, rule, { date:rule.date })) matches.push(rule)
  }
  return { parts, matches }
}

function addClosureComponent(components, rule) {
  const key = `${rule.kind}:${rule.reason}`
  const existing = components.find(component => component.key === key)
  if (existing) {
    existing.count += 1
    return
  }
  components.push({ key, kind:rule.kind, reason:rule.reason, count:1 })
}

function classifyWithPolicy(start, end, timeframe, intervalMs, options, policyMatch) {
  const policy = policyMatch.policy
  const offsetInfo = offsetsForGap(start, end, options, policy)
  const base = {
    calendar_version:MARKET_SESSION_CALENDAR_VERSION,
    engine_version:MARKET_SESSION_ENGINE_VERSION,
    engine:MARKET_SESSION_ENGINE_VERSION,
    timeframe:String(timeframe || '').toUpperCase() || null,
    from_utc_msc:start,
    to_utc_msc:end,
    policy:policyMeta(policyMatch, policyMatch.mode),
    policy_match:true,
  }
  if ((end - start) % intervalMs !== 0) return {
    ...base,
    classification:'suspicious_gap', known:true, expected:false,
    reason:'market_open_bars_missing', missing_bar_count:Math.max(1, Math.ceil((end - start) / intervalMs) - 1),
    components:[], uncovered_ranges:[{ from_utc_msc:start + intervalMs, to_utc_msc:end - intervalMs,
      missing_bar_count:Math.max(1, Math.ceil((end - start) / intervalMs) - 1) }],
    uncovered:[{ from_utc_msc:start + intervalMs, to_utc_msc:end - intervalMs,
      missing_bar_count:Math.max(1, Math.ceil((end - start) / intervalMs) - 1) }],
  }
  if (!offsetInfo) return {
    ...base,
    classification:'unknown_session', known:false,
    reason:'market_session_clock_unknown',
  }
  const missing = []
  for (let cursor = start + intervalMs; cursor < end; cursor += intervalMs) {
    missing.push(cursor)
    if (missing.length > MAX_MISSING_BARS) return {
      ...base, classification:'unknown_session', known:false, reason:'gap_too_large',
    }
  }
  if (!missing.length) return null
  const components = []
  const uncovered = []
  for (const cursor of missing) {
    const offset = offsetAtCursor(cursor, offsetInfo)
    const result = offset == null ? { matches:[] } : classifyPolicyBar(cursor, offset, policy)
    if (!result.matches.length) {
      uncovered.push(cursor)
      continue
    }
    result.matches.forEach(rule => addClosureComponent(components, rule))
  }
  const uncoveredRanges = []
  for (const cursor of uncovered) {
    const last = uncoveredRanges.at(-1)
    if (last && cursor === last.to_utc_msc + intervalMs) {
      last.to_utc_msc = cursor
      last.missing_bar_count += 1
    } else {
      uncoveredRanges.push({ from_utc_msc:cursor, to_utc_msc:cursor, missing_bar_count:1 })
    }
  }
  const result = {
    ...base,
    known:true,
    expected:uncovered.length === 0,
    missing_bar_count:missing.length,
    components:components.map(({ key, ...component }) => component),
    uncovered_ranges:uncoveredRanges,
    uncovered:uncoveredRanges,
    offset_source:offsetInfo.source,
    ...(offsetInfo.transition ? { dst_transition:offsetInfo.transition } : {}),
  }
  if (uncovered.length) {
    return { ...result, classification:'suspicious_gap', reason:'market_open_bars_missing' }
  }
  const componentKinds = [...new Set(components.map(component => component.kind))]
  return {
    ...result,
    classification:componentKinds.length > 1 ? 'composite_closure' : (componentKinds[0] || 'expected_closure'),
    reason:componentKinds.length > 1 ? 'composite_closure' : (components[0]?.reason || 'expected_closure'),
  }
}

export function classifyMarketClosure(startUtcMs, endUtcMs, timeframe, options = {}) {
  const start = Number(startUtcMs)
  const end = Number(endUtcMs)
  const intervalMs = Math.max(1, Number(options.intervalMs || options.interval_ms) || 0)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !intervalMs) return null
  const mode = options.marketSessionPolicyMode || options.market_session_policy_mode || getMarketSessionPolicyMode(options.env || process.env)
  const identity = {
    platform:options.platform,
    broker_server:options.brokerServer || options.broker_server,
    standard_symbol:normalizeSymbol(options.standardSymbol || options.standard_symbol || options.symbol),
  }
  const policyMatch = resolveMarketSessionPolicy(identity, { env:options.env || process.env })
  if ((mode === 'audit' || mode === 'enforce') && policyMatch.matched) {
    const clockStatus = String(options.clockStatus || options.clock_status || '').trim().toLowerCase()
    if ((options.strictSessionPolicy === true || mode === 'enforce') && !VALID_CLOCK_STATUSES.has(clockStatus)) {
      return {
        classification:'unknown_session', known:false, reason:'market_session_clock_unverified',
        calendar_version:MARKET_SESSION_CALENDAR_VERSION, engine_version:MARKET_SESSION_ENGINE_VERSION,
        engine:MARKET_SESSION_ENGINE_VERSION, timeframe:String(timeframe || '').toUpperCase() || null,
        policy:policyMeta(policyMatch, mode), policy_match:true, policy_enforced:mode === 'enforce',
      }
    }
    const policyResult = classifyWithPolicy(start, end, timeframe, intervalMs, options, policyMatch)
    if (policyResult) {
      return {
        ...policyResult,
        policy_enforced:mode === 'enforce',
        audit_only:mode === 'audit',
      }
    }
  }
  if (mode === 'enforce' && !policyMatch.matched) {
    return {
      classification:'unknown_session', reason:policyMatch.reason || 'market_session_policy_unavailable', known:false,
      calendar_version:MARKET_SESSION_CALENDAR_VERSION, engine_version:MARKET_SESSION_ENGINE_VERSION,
      engine:MARKET_SESSION_ENGINE_VERSION,
      timeframe:String(timeframe || '').toUpperCase() || null,
      policy:policyMeta(policyMatch, mode), policy_match:false, policy_enforced:true,
    }
  }
  if (!knownLegacyPolicy(options)) {
    return {
      classification:'unknown_session', reason:'market_session_policy_unavailable', known:false,
      calendar_version:MARKET_SESSION_CALENDAR_VERSION, engine_version:MARKET_SESSION_ENGINE_VERSION,
      engine:MARKET_SESSION_ENGINE_VERSION,
      timeframe:String(timeframe || '').toUpperCase() || null,
      policy:policyMeta(policyMatch, mode), policy_match:Boolean(policyMatch.matched),
      policy_enforced:false,
    }
  }
  const missing = []
  for (let cursor = start + intervalMs; cursor < end; cursor += intervalMs) {
    missing.push(cursor)
    if (missing.length > MAX_MISSING_BARS) return { classification:'unknown_session', reason:'gap_too_large', known:false,
      calendar_version:MARKET_SESSION_CALENDAR_VERSION, engine_version:MARKET_SESSION_ENGINE_VERSION }
  }
  if (!missing.length) return null
  const closures = missing.map(cursor => classifyLegacyBar(cursor, options))
  // A known calendar with at least one open-session missing bar returns null
  // for compatibility.  The continuity inspector supplies the stable
  // `market_open_bars_missing` reason and keeps this distinct from an unknown
  // session policy.
  if (closures.some(closure => !closure)) return null
  const distinct = [...new Set(closures.map(closure => closure.classification))]
  return {
    ...closures[0], known:true, expected:true,
    classification:distinct.length > 1 ? 'composite_closure' : closures[0].classification,
    calendar_version:MARKET_SESSION_CALENDAR_VERSION, engine_version:MARKET_SESSION_ENGINE_VERSION,
    engine:MARKET_SESSION_ENGINE_VERSION,
    timeframe:String(timeframe || '').toUpperCase() || null,
    from_utc_msc:start, to_utc_msc:end,
    missing_bar_count:missing.length,
    components:[], uncovered_ranges:[], uncovered:[],
    policy:policyMeta(policyMatch, mode), policy_match:Boolean(policyMatch.matched), policy_enforced:false,
  }
}

export function classifyContinuityGap(startUtcMs, endUtcMs, timeframe, options = {}) {
  return classifyMarketClosure(startUtcMs, endUtcMs, timeframe, options)
}

export const __marketSessionCalendarTest = {
  utcDate, localDateParts, localDayKey, holidayClosure, weekendClosure, timezoneOffsetAt,
  parseBrokerTime, historicalOffset, matchesWindow, offsetsForGap,
}
