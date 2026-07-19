const START_WEEKDAY = 5
const START_HOUR = 23
const WINDOW_MS = 60 * 60 * 1000

let mt5TimezoneOffsetMinutes = 180

export function setWeeklyMarketTimezoneOffset(value) {
  const offset = Number(value)
  if (Number.isFinite(offset) && offset >= -720 && offset <= 840) mt5TimezoneOffsetMinutes = Math.trunc(offset)
  return mt5TimezoneOffsetMinutes
}

export function getWeeklyMarketTimezoneOffset() {
  return mt5TimezoneOffsetMinutes
}

export function weeklyFlattenEnabled() {
  return process.env.WEEKLY_SYSTEM_FLATTEN_ENABLED !== 'false'
}

export function marketWeeklyParts(now = new Date()) {
  const shifted = new Date(now.getTime() + mt5TimezoneOffsetMinutes * 60_000)
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(),
  }
}

export function beijingWeeklyParts(now = new Date()) {
  return marketWeeklyParts(now)
}

function localStartUtc(parts, daysAhead = 0) {
  return new Date(Date.UTC(parts.year, parts.month, parts.day + daysAhead, START_HOUR) - mt5TimezoneOffsetMinutes * 60_000)
}

export function isWeeklyFlattenWindow(now = new Date()) {
  if (!weeklyFlattenEnabled()) return false
  const p = marketWeeklyParts(now)
  return p.weekday === START_WEEKDAY && p.hour === START_HOUR
}

export function isWeeklyFlattenPrimaryWindow(now = new Date()) {
  return isWeeklyFlattenWindow(now)
}

export function nextWeeklyFlattenStart(now = new Date()) {
  const p = marketWeeklyParts(now)
  let daysAhead = (START_WEEKDAY - p.weekday + 7) % 7
  if (daysAhead === 0 && (p.hour > START_HOUR || (p.hour === START_HOUR && p.minute >= 0))) daysAhead = 7
  return localStartUtc(p, daysAhead)
}

export function currentWeeklyFlattenEnd(now = new Date()) {
  const p = marketWeeklyParts(now)
  const daysBack = (p.weekday - START_WEEKDAY + 7) % 7
  return new Date(localStartUtc(p, -daysBack).getTime() + WINDOW_MS)
}

export function weeklyFlattenCycleId(now = new Date()) {
  const p = marketWeeklyParts(now)
  const daysBack = (p.weekday - START_WEEKDAY + 7) % 7
  // Keep the cycle key anchored to the Saturday on which the lock window ends.
  // This preserves existing Redis/audit identifiers while the UTC instant is
  // derived from the calibrated MT5 timezone.
  const shifted = new Date(Date.UTC(p.year, p.month, p.day - daysBack + 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
}

export function weeklyRiskLockResult(now = new Date()) {
  if (!isWeeklyFlattenWindow(now)) return null
  return {
    status: 'rejected', code: 'weekly_market_close_risk_lock',
    message: '周末风险控制期间禁止新增交易',
    details: {
      reason: `MT5 时间周五23:00至周六00:00禁止本系统新增交易（UTC${mt5TimezoneOffsetMinutes >= 0 ? '+' : ''}${mt5TimezoneOffsetMinutes / 60}）`,
      cycle: weeklyFlattenCycleId(now), timezone_offset_minutes: mt5TimezoneOffsetMinutes,
    },
  }
}

export const WEEKLY_FLATTEN_SCHEDULE = {
  timezone: 'MT5', start: 'Friday 23:00', deadline: 'Saturday 00:00', release: 'Saturday 00:00',
}
