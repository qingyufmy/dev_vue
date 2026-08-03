export const TERMINAL_SERVER_TIMEZONE = 'terminal_server'
const DEFAULT_TIMEZONE = TERMINAL_SERVER_TIMEZONE
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5]
const DEFAULT_WINDOWS = [{ start: '00:00', end: '23:59' }]
const VALID_OUTSIDE_BEHAVIORS = new Set(['pause_all', 'signals_only'])

function parseJson(value, fallback) {
  if (Array.isArray(value)) return value
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function normalizeTime(value) {
  const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  if (!match) throw new Error('invalid_schedule_time')
  return `${match[1]}:${match[2]}`
}

function timeToMinutes(value) {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

export function normalizeSubscriptionSchedule(payload = {}, existing = {}) {
  const enabled = payload.schedule_enabled === undefined
    ? Boolean(Number(existing.schedule_enabled || 0))
    : Boolean(payload.schedule_enabled)
  const requestedTimezone = String(
    payload.schedule_timezone ?? existing.schedule_timezone ?? DEFAULT_TIMEZONE).trim()
  // All AI trading schedules follow the bound MT4/MT5 terminal. Legacy IANA
  // values remain readable during migration but are normalized on the next save.
  const timezone = requestedTimezone === TERMINAL_SERVER_TIMEZONE
    ? TERMINAL_SERVER_TIMEZONE : TERMINAL_SERVER_TIMEZONE

  const rawWeekdays = payload.schedule_weekdays ?? parseJson(existing.schedule_weekdays_json, DEFAULT_WEEKDAYS)
  const weekdays = [...new Set((Array.isArray(rawWeekdays) ? rawWeekdays : []).map(Number))]
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b)
  if (enabled && !weekdays.length) throw new Error('schedule_weekdays_required')

  const rawWindows = payload.schedule_windows ?? parseJson(existing.schedule_windows_json, DEFAULT_WINDOWS)
  const windows = (Array.isArray(rawWindows) ? rawWindows : []).map(window => ({
    start: normalizeTime(window?.start),
    end: normalizeTime(window?.end),
  }))
  if (enabled && !windows.length) throw new Error('schedule_windows_required')
  if (windows.length > 6) throw new Error('schedule_windows_limit_exceeded')

  const outsideBehavior = String(payload.outside_window_behavior ?? existing.outside_window_behavior ?? 'pause_all')
  if (!VALID_OUTSIDE_BEHAVIORS.has(outsideBehavior)) throw new Error('invalid_outside_window_behavior')
  return { enabled, timezone, weekdays, windows, outsideBehavior }
}

function terminalScheduleParts(now, subscription, options = {}) {
  const rawOffset = options.timezoneOffsetMinutes
    ?? subscription.runtime_timezone_offset_minutes
    ?? subscription.timezone_offset_minutes
  if (rawOffset === null || rawOffset === undefined || rawOffset === '') return null
  const offset = Number(rawOffset)
  const status = String(options.clockStatus
    ?? subscription.runtime_clock_status
    ?? subscription.clock_status
    ?? '').trim().toLowerCase()
  if (!Number.isInteger(offset) || offset < -720 || offset > 840 || !status
    || ['unavailable', 'unverified', 'unknown', 'calibrating', 'fallback'].includes(status)) {
    return null
  }
  const shifted = new Date(now.getTime() + offset * 60_000)
  return {
    weekday:shifted.getUTCDay(),
    hour:shifted.getUTCHours(),
    minute:shifted.getUTCMinutes(),
  }
}

export function isSubscriptionScheduleActive(subscription = {}, now = new Date(), options = {}) {
  if (!Number(subscription.schedule_enabled)) return true
  const schedule = normalizeSubscriptionSchedule({}, subscription)
  const terminalParts = terminalScheduleParts(now, subscription, options)
  if (!terminalParts) return false
  const weekday = terminalParts.weekday
  const minute = terminalParts.hour * 60 + terminalParts.minute
  const selected = new Set(schedule.weekdays)
  const previousWeekday = (weekday + 6) % 7

  return schedule.windows.some(window => {
    const start = timeToMinutes(window.start)
    const end = timeToMinutes(window.end)
    if (start === end) return selected.has(weekday)
    if (start < end) return selected.has(weekday) && minute >= start && minute < end
    return (selected.has(weekday) && minute >= start) || (selected.has(previousWeekday) && minute < end)
  })
}

export function subscriptionAllowsInference(subscription = {}, now = new Date(), options = {}) {
  const inWindow = isSubscriptionScheduleActive(subscription, now, options)
  return inWindow || subscription.outside_window_behavior === 'signals_only'
}

export function subscriptionAllowsExecution(subscription = {}, now = new Date(), options = {}) {
  return isSubscriptionScheduleActive(subscription, now, options)
}

export const SUBSCRIPTION_SCHEDULE_DEFAULTS = {
  timezone: DEFAULT_TIMEZONE,
  weekdays: DEFAULT_WEEKDAYS,
  windows: DEFAULT_WINDOWS,
  outsideBehavior: 'pause_all',
}
