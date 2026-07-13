const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const START_HOUR = 4
const DEADLINE_HOUR = 5

export function weeklyFlattenEnabled() {
  return process.env.WEEKLY_SYSTEM_FLATTEN_ENABLED !== 'false'
}

export function beijingWeeklyParts(now = new Date()) {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

export function isWeeklyFlattenWindow(now = new Date()) {
  if (!weeklyFlattenEnabled()) return false
  const p = beijingWeeklyParts(now)
  return p.weekday === 6 && p.hour >= START_HOUR && p.hour < DEADLINE_HOUR
}

export function isWeeklyFlattenPrimaryWindow(now = new Date()) {
  return isWeeklyFlattenWindow(now)
}

export function nextWeeklyFlattenStart(now = new Date()) {
  const p = beijingWeeklyParts(now)
  let daysAhead = (6 - p.weekday + 7) % 7
  if (daysAhead === 0 && p.hour >= START_HOUR) daysAhead = 7
  return new Date(Date.UTC(p.year, p.month, p.day + daysAhead, START_HOUR) - BEIJING_OFFSET_MS)
}

export function currentWeeklyFlattenEnd(now = new Date()) {
  const p = beijingWeeklyParts(now)
  return new Date(Date.UTC(p.year, p.month, p.day, DEADLINE_HOUR) - BEIJING_OFFSET_MS)
}

export function weeklyFlattenCycleId(now = new Date()) {
  const p = beijingWeeklyParts(now)
  let daysBack = 0
  if (p.weekday === 0) daysBack = 1
  else if (p.weekday === 1) daysBack = 2
  const shifted = new Date(Date.UTC(p.year, p.month, p.day) - daysBack * 24 * 60 * 60 * 1000)
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
}

export function weeklyRiskLockResult(now = new Date()) {
  if (!isWeeklyFlattenWindow(now)) return null
  return {
    status: 'rejected',
    code: 'weekly_market_close_risk_lock',
    message: '周末风险控制期间禁止新增交易',
    details: {
      reason: '北京时间周六04:00至05:00禁止本系统新增交易',
      cycle: weeklyFlattenCycleId(now),
    },
  }
}

export const WEEKLY_FLATTEN_SCHEDULE = {
  timezone: 'Asia/Shanghai',
  start: 'Saturday 04:00',
  deadline: 'Saturday 05:00',
  release: 'Saturday 05:00',
}
