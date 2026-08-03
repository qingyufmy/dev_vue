import { getDefaultObserverSourceClock } from './observer-channels.js'

export const OBSERVER_BOOTSTRAP_CLOCK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const UNTRUSTED_CLOCK_STATUSES = new Set([
  'unknown', 'unavailable', 'unverified', 'calibrating', 'fallback',
])

const normalizedBrokerServer = value => String(value || '').trim().toUpperCase()

export function trustedTerminalClock(clock = {}) {
  if (clock?.timezone_offset_minutes === null || clock?.timezone_offset_minutes === undefined
    || clock?.timezone_offset_minutes === '') return false
  const offset = Number(clock.timezone_offset_minutes)
  const status = String(clock.clock_status || clock.source_clock_status || '').trim().toLowerCase()
  return Number.isInteger(offset) && offset >= -720 && offset <= 840
    && Boolean(status) && !UNTRUSTED_CLOCK_STATUSES.has(status)
}

export function applyDefaultObserverClockBootstrap(targetClock = {}, observerClock = {}, now = Date.now()) {
  targetClock = targetClock || {}
  observerClock = observerClock || {}
  if (trustedTerminalClock(targetClock)) return targetClock
  const targetBroker = normalizedBrokerServer(targetClock.broker_server)
  const sourceBroker = normalizedBrokerServer(observerClock.broker_server)
  const calibratedAt = Number(observerClock.last_calibrated_at_utc_msc || 0)
  if (!targetBroker || targetBroker !== sourceBroker || !trustedTerminalClock(observerClock)
    || !Number.isFinite(calibratedAt) || calibratedAt <= 0
    || calibratedAt > Number(now) + 60_000
    || Number(now) - calibratedAt > OBSERVER_BOOTSTRAP_CLOCK_MAX_AGE_MS) return targetClock
  return {
    ...targetClock,
    timezone_offset_minutes:Number(observerClock.timezone_offset_minutes),
    clock_status:'observer_bootstrap',
    clock_source:'default_observer_source',
    source_clock_status:String(observerClock.clock_status || observerClock.source_clock_status || '').trim(),
    source_id:Number(observerClock.source_id) || null,
    source_bridge_user_id:Number(observerClock.bridge_user_id) || null,
    source_trading_account_id:Number(observerClock.trading_account_id) || null,
    source_last_calibrated_at_utc_msc:calibratedAt,
  }
}

export async function resolveDefaultObserverClockBootstrap(targetClock = {}, now = Date.now()) {
  if (trustedTerminalClock(targetClock)) return targetClock
  const observerClock = await getDefaultObserverSourceClock().catch(() => null)
  return applyDefaultObserverClockBootstrap(targetClock, observerClock, now)
}
