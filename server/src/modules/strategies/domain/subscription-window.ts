export interface SubscriptionWindowClock {
  timezoneOffsetMinutes: number | null
  clockStatus: string
}

export interface SubscriptionWindowDecision {
  inferenceAllowed: boolean
  executionAllowed: boolean
  reason: 'disabled' | 'inside' | 'outside' | 'clock_unverified'
}

// Version 1 uses terminal wall-clock minutes, Sunday=0, exclusive end points.
// This controls subscription timing only; ownership and risk remain independent.
export function evaluateSubscriptionWindow(raw: unknown, timezone: string, now: Date, clock: SubscriptionWindowClock | null): SubscriptionWindowDecision {
  const invalid = () => { throw new Error('subscription_window_invalid') }
  let value: unknown = raw
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return invalid() } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const window = value as Record<string, unknown>
  if (typeof window.enabled !== 'boolean' || !Number.isFinite(now.getTime())) return invalid()
  // Existing V4 subscriptions have this minimal disabled representation.
  if (window.enabled === false && Object.keys(window).length === 1) return { inferenceAllowed: true, executionAllowed: true, reason: 'disabled' }
  if (window.version !== 1 || window.timezone !== 'terminal_server' || timezone !== window.timezone
    || !Array.isArray(window.weekdays) || window.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)
    || !Array.isArray(window.windows) || window.windows.length > 6
    || (window.enabled && (!window.weekdays.length || !window.windows.length))
    || !['pause_all', 'signals_only'].includes(String(window.outsideBehavior))) return invalid()
  const minutes = (value: unknown): number => {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return invalid()
    return Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  }
  const windows = window.windows.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid()
    return { start: minutes(item.start), end: minutes(item.end) }
  })
  if (!window.enabled) return { inferenceAllowed: true, executionAllowed: true, reason: 'disabled' }
  const offset = clock?.timezoneOffsetMinutes
  if (clock?.clockStatus !== 'calibrated' || typeof offset !== 'number' || !Number.isInteger(offset) || offset < -720 || offset > 840) {
    return { inferenceAllowed: window.outsideBehavior === 'signals_only', executionAllowed: false, reason: 'clock_unverified' }
  }
  const local = new Date(now.getTime() + offset * 60_000)
  const day = local.getUTCDay(), minute = local.getUTCHours() * 60 + local.getUTCMinutes()
  const selected = new Set(window.weekdays)
  const inside = windows.some(({ start, end }) => start === end ? selected.has(day)
    : start < end ? selected.has(day) && minute >= start && minute < end
      : (selected.has(day) && minute >= start) || (selected.has((day + 6) % 7) && minute < end))
  return { inferenceAllowed: inside || window.outsideBehavior === 'signals_only', executionAllowed: inside, reason: inside ? 'inside' : 'outside' }
}
