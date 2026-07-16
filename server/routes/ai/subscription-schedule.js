// The terminal UI and market countdown use the broker's MT5 server clock
// (UTC+3). Etc/GMT signs are intentionally reversed by the IANA convention.
const DEFAULT_TIMEZONE = 'Etc/GMT-3'
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
  const timezone = String(payload.schedule_timezone ?? existing.schedule_timezone ?? DEFAULT_TIMEZONE).trim()
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()) } catch { throw new Error('invalid_schedule_timezone') }

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

export function isSubscriptionScheduleActive(subscription = {}, now = new Date()) {
  if (!Number(subscription.schedule_enabled)) return true
  const schedule = normalizeSubscriptionSchedule({}, subscription)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  const weekday = ({ Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 })[values.weekday]
  const minute = Number(values.hour) * 60 + Number(values.minute)
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

export function subscriptionAllowsInference(subscription = {}, now = new Date()) {
  const inWindow = isSubscriptionScheduleActive(subscription, now)
  return inWindow || subscription.outside_window_behavior === 'signals_only'
}

export function subscriptionAllowsExecution(subscription = {}, now = new Date()) {
  return isSubscriptionScheduleActive(subscription, now)
}

export const SUBSCRIPTION_SCHEDULE_DEFAULTS = {
  timezone: DEFAULT_TIMEZONE,
  weekdays: DEFAULT_WEEKDAYS,
  windows: DEFAULT_WINDOWS,
  outsideBehavior: 'pause_all',
}
