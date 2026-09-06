import { hash } from './v4-backfill-contract.mjs'

export const scheduleSourceFields = Object.freeze(['schedule_enabled', 'schedule_timezone', 'schedule_weekdays_json', 'schedule_windows_json', 'outside_window_behavior'])

// A conversion candidate, not permission to activate a subscription. The V4
// scheduler and execution consumers must implement this contract before cutover.
export function convertSubscriptionSchedule(row) {
  const source = Object.fromEntries(scheduleSourceFields.map(field => [field, row[field]]))
  if (Object.values(source).some(value => value !== null && typeof value !== 'string')) throw new Error('schedule_source_shape_invalid')
  const problems = [], defaultsApplied = []
  const issue = field => problems.push({ code: 'subscription_schedule_source_invalid', field })
  if (!['0', '1'].includes(source.schedule_enabled)) issue('schedule_enabled')
  const parse = (field, fallback) => {
    if (source[field] === null) { defaultsApplied.push(field); return fallback }
    try { return JSON.parse(source[field]) } catch { issue(field); return null }
  }
  const weekdays = parse('schedule_weekdays_json', [1, 2, 3, 4, 5])
  const windows = parse('schedule_windows_json', [{ start: '00:00', end: '23:59' }])
  if (!Array.isArray(weekdays) || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)
    || (source.schedule_enabled === '1' && !weekdays.length)) issue('schedule_weekdays_json')
  const time = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
  if (!Array.isArray(windows) || windows.length > 6 || (source.schedule_enabled === '1' && !windows.length)
    || windows.some(window => !window || typeof window !== 'object' || Array.isArray(window)
      || Object.keys(window).sort().join(',') !== 'end,start' || !time(window.start) || !time(window.end))) issue('schedule_windows_json')
  const outsideBehavior = source.outside_window_behavior ?? 'pause_all'
  if (source.outside_window_behavior === null) defaultsApplied.push('outside_window_behavior')
  if (!['pause_all', 'signals_only'].includes(outsideBehavior)) issue('outside_window_behavior')
  return { sourceHash: hash(source), status: problems.length ? 'blocked' : 'converted', problems, defaultsApplied,
    // Legacy runtime always used terminal_server even if an IANA name was stored.
    timezoneNormalized: source.schedule_timezone !== 'terminal_server',
    candidate: problems.length ? null : { version: 1, timezone: 'terminal_server', enabled: source.schedule_enabled === '1',
      weekdays: [...new Set(weekdays)].sort((a, b) => a - b), windows, outsideBehavior },
    executable: false, blockers: ['schedule_runtime_consumers', 'terminal_clock_trust_policy'] }
}
