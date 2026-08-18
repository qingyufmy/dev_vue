import { getDefaultObserverSourceClock } from './observer-channels.js'

export const OBSERVER_BOOTSTRAP_CLOCK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const UNTRUSTED_CLOCK_STATUSES = new Set([
  'unknown', 'unavailable', 'unverified', 'calibrating', 'fallback',
])
export const EXECUTION_CLOCK_MAX_AGE_MS = 30_000

const normalizedBrokerServer = value => String(value || '').trim().toUpperCase()

export function trustedTerminalClock(clock = {}) {
  if (clock?.timezone_offset_minutes === null || clock?.timezone_offset_minutes === undefined
    || clock?.timezone_offset_minutes === '') return false
  const offset = Number(clock.timezone_offset_minutes)
  const status = String(clock.clock_status || clock.source_clock_status || '').trim().toLowerCase()
  return Number.isInteger(offset) && offset >= -720 && offset <= 840
    && Boolean(status) && !UNTRUSTED_CLOCK_STATUSES.has(status)
}

function normalizedText(value) {
  return String(value ?? '').trim()
}

function normalizedBroker(value) {
  return normalizedText(value).toUpperCase()
}

function normalizedLogin(value) {
  return normalizedText(value)
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function clockCaptureTime(context = {}) {
  const candidates = [
    context.captured_at_utc_msc,
    context.clock_captured_at_utc_msc,
    context.observed_at_utc_msc,
    context.last_calibrated_at_utc_msc,
  ]
  for (const value of candidates) {
    const number = Number(value)
    if (Number.isSafeInteger(number) && number > 0) return number
  }
  return null
}

export function buildExecutionClockContext({ userId, tradingAccountId, terminalInstanceId = null,
  brokerServer = null, login = null, clock = {}, capturedAtUtcMsc = null,
  source = 'risk_snapshot_terminal' } = {}) {
  const captured = Number(capturedAtUtcMsc) > 0 ? Number(capturedAtUtcMsc) : clockCaptureTime(clock)
  return Object.freeze({
    user_id:positiveInteger(userId),
    trading_account_id:positiveInteger(tradingAccountId),
    terminal_instance_id:normalizedText(terminalInstanceId) || null,
    broker_server:normalizedBroker(brokerServer || clock.broker_server),
    login:normalizedLogin(login || clock.login || clock.account_login),
    timezone_offset_minutes:clock.timezone_offset_minutes == null || clock.timezone_offset_minutes === ''
      ? null : Number(clock.timezone_offset_minutes),
    clock_status:normalizedText(clock.clock_status || clock.source_clock_status).toLowerCase(),
    clock_source:normalizedText(clock.clock_source || clock.source || source),
    captured_at_utc_msc:Number.isSafeInteger(captured) && captured > 0 ? captured : null,
    calibration_age_ms:Number.isFinite(Number(clock.clock_sample_age_ms))
      ? Math.max(0, Number(clock.clock_sample_age_ms)) : null,
  })
}

// Validate a clock captured by the same account risk snapshot immediately
// before an order. The terminal id may be supplied by the snapshot or by the
// already account-bound Bridge route; it is never inferred from another user.
export function validateExecutionClockContext(context = {}, expected = {}, now = Date.now()) {
  const value = context && typeof context === 'object' ? context : {}
  const userId = positiveInteger(value.user_id)
  const accountId = positiveInteger(value.trading_account_id)
  const expectedUserId = positiveInteger(expected.userId)
  const expectedAccountId = positiveInteger(expected.tradingAccountId)
  if (!userId || !accountId || !expectedUserId || !expectedAccountId
    || userId !== expectedUserId || accountId !== expectedAccountId) {
    return { valid:false, reason:'execution_clock_identity_mismatch' }
  }
  const expectedTerminal = normalizedText(expected.terminalInstanceId)
  const terminal = normalizedText(value.terminal_instance_id) || expectedTerminal
  if ((expected.requireTerminal !== false && !terminal)
    || (expectedTerminal && normalizedText(value.terminal_instance_id)
    && normalizedText(value.terminal_instance_id) !== expectedTerminal)) {
    return { valid:false, reason:'execution_clock_identity_mismatch' }
  }
  const expectedBroker = normalizedBroker(expected.brokerServer)
  const expectedLogin = normalizedLogin(expected.login)
  const broker = normalizedBroker(value.broker_server)
  const login = normalizedLogin(value.login)
  if (!broker || !login || !expectedBroker || !expectedLogin
    || broker !== expectedBroker || login !== expectedLogin) {
    return { valid:false, reason:'execution_clock_identity_mismatch' }
  }
  if (!trustedTerminalClock(value)) return { valid:false, reason:'terminal_clock_unverified' }
  const source = normalizedText(value.clock_source).toLowerCase()
  const status = normalizedText(value.clock_status).toLowerCase()
  if (!source || source === 'default_observer_source' || source === 'observer_bootstrap'
    || status === 'observer_bootstrap') {
    return { valid:false, reason:'execution_clock_untrusted_source' }
  }
  const captured = clockCaptureTime(value)
  if (!Number.isSafeInteger(captured) || captured <= 0
    || !Number.isFinite(Number(now)) || Number(now) - captured < -60_000
    || Number(now) - captured > EXECUTION_CLOCK_MAX_AGE_MS) {
    return { valid:false, reason:'execution_clock_stale' }
  }
  if (value.calibration_age_ms != null
    && (!Number.isFinite(Number(value.calibration_age_ms))
      || Number(value.calibration_age_ms) > EXECUTION_CLOCK_MAX_AGE_MS)) {
    return { valid:false, reason:'execution_clock_stale' }
  }
  return {
    valid:true,
    context:{
      ...value,
      user_id:userId,
      trading_account_id:accountId,
      terminal_instance_id:terminal,
      broker_server:broker,
      login,
      timezone_offset_minutes:Number(value.timezone_offset_minutes),
      clock_status:status,
      clock_source:source,
      captured_at_utc_msc:captured,
    },
  }
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
