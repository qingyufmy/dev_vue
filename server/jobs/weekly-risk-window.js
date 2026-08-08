const START_WEEKDAY = 5
const START_HOUR = 23
const WINDOW_MS = 60 * 60 * 1000

function validOffset(value) {
  if (value === null || value === undefined || value === '') return null
  const offset = Number(value)
  return Number.isInteger(offset) && offset >= -720 && offset <= 840 ? offset : null
}

export function weeklyFlattenEnabled() {
  return process.env.WEEKLY_SYSTEM_FLATTEN_ENABLED !== 'false'
}

export function marketWeeklyParts(now = new Date(), timezoneOffsetMinutes = null) {
  const offset = validOffset(timezoneOffsetMinutes)
  if (offset == null) return null
  const shifted = new Date(now.getTime() + offset * 60_000)
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(),
  }
}

export function beijingWeeklyParts(now = new Date(), timezoneOffsetMinutes = null) {
  return marketWeeklyParts(now, timezoneOffsetMinutes)
}

function localStartUtc(parts, timezoneOffsetMinutes, daysAhead = 0) {
  return new Date(Date.UTC(parts.year, parts.month, parts.day + daysAhead, START_HOUR)
    - timezoneOffsetMinutes * 60_000)
}

export function isWeeklyFlattenWindow(now = new Date(), timezoneOffsetMinutes = null) {
  if (!weeklyFlattenEnabled()) return false
  const p = marketWeeklyParts(now, timezoneOffsetMinutes)
  if (!p) return false
  return p.weekday === START_WEEKDAY && p.hour === START_HOUR
}

export function isWeeklyFlattenPrimaryWindow(now = new Date(), timezoneOffsetMinutes = null) {
  return isWeeklyFlattenWindow(now, timezoneOffsetMinutes)
}

export function nextWeeklyFlattenStart(now = new Date(), timezoneOffsetMinutes = null) {
  const offset = validOffset(timezoneOffsetMinutes)
  const p = marketWeeklyParts(now, offset)
  if (!p) return null
  let daysAhead = (START_WEEKDAY - p.weekday + 7) % 7
  if (daysAhead === 0 && (p.hour > START_HOUR || (p.hour === START_HOUR && p.minute >= 0))) daysAhead = 7
  return localStartUtc(p, offset, daysAhead)
}

export function currentWeeklyFlattenEnd(now = new Date(), timezoneOffsetMinutes = null) {
  const offset = validOffset(timezoneOffsetMinutes)
  const p = marketWeeklyParts(now, offset)
  if (!p) return null
  const daysBack = (p.weekday - START_WEEKDAY + 7) % 7
  return new Date(localStartUtc(p, offset, -daysBack).getTime() + WINDOW_MS)
}

export function weeklyFlattenCycleId(now = new Date(), timezoneOffsetMinutes = null) {
  const p = marketWeeklyParts(now, timezoneOffsetMinutes)
  if (!p) return null
  const daysBack = (p.weekday - START_WEEKDAY + 7) % 7
  // Keep the cycle key anchored to the Saturday on which the lock window ends.
  // This preserves existing Redis/audit identifiers while the UTC instant is
  // derived from the calibrated MT5 timezone.
  const shifted = new Date(Date.UTC(p.year, p.month, p.day - daysBack + 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
}

export function weeklyRiskLockResult(now = new Date(), timezoneOffsetMinutes = null, clockStatus = '') {
  if (!weeklyFlattenEnabled()) return null
  const offset = validOffset(timezoneOffsetMinutes)
  const status = String(clockStatus || '').trim().toLowerCase()
  if (offset == null || !status
    || ['unknown', 'unavailable', 'unverified', 'calibrating', 'fallback'].includes(status)) {
    return { status:'rejected', code:'terminal_clock_unverified', message:'交易平台时间尚未校准' }
  }
  if (!isWeeklyFlattenWindow(now, offset)) return null
  return {
    status: 'rejected', code: 'weekly_market_close_risk_lock',
    message: '周末风险控制期间禁止新增交易',
    details: {
      reason: `交易平台时间周五23:00至周六00:00禁止本系统新增交易（UTC${offset >= 0 ? '+' : ''}${offset / 60}）`,
      cycle: weeklyFlattenCycleId(now, offset), timezone_offset_minutes: offset,
    },
  }
}

export const WEEKLY_FLATTEN_SCHEDULE = {
  timezone: 'MT5', start: 'Friday 23:00', deadline: 'Saturday 00:00', release: 'Saturday 00:00',
}
