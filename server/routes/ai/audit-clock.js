import { trustedTerminalClock } from './terminal-clock.js'

const positiveId = value => {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

const payloadObjects = (request = {}, result = {}) => [
  request,
  result,
  request?.account,
  result?.account,
  request?.market_meta,
  result?.market_meta,
  request?.clock,
  result?.clock,
].filter(value => value && typeof value === 'object' && !Array.isArray(value))

export function auditTradingAccountId(request = {}, result = {}) {
  for (const value of payloadObjects(request, result)) {
    const id = positiveId(value.trading_account_id ?? value.account_id)
    if (id) return id
  }
  return null
}

export function auditPayloadClock(request = {}, result = {}) {
  for (const value of payloadObjects(request, result)) {
    const clock = {
      timezone_offset_minutes:value.mt5_timezone_offset_minutes
        ?? value.timezone_offset_minutes ?? value.runtime_timezone_offset_minutes,
      clock_status:value.mt5_clock_status ?? value.clock_status ?? value.runtime_clock_status,
      clock_source:value.mt5_clock_source ?? value.clock_source ?? value.runtime_clock_source ?? 'audit_payload',
    }
    if (trustedTerminalClock(clock)) return clock
  }
  return null
}

export function buildAuditClockSnapshot({
  request = {}, result = {}, accountClock = null, tradingAccountId = null,
  createdAtUtcMsc = Date.now(),
} = {}) {
  const payloadClock = auditPayloadClock(request, result)
  const effectiveClock = payloadClock || (trustedTerminalClock(accountClock || {}) ? accountClock : null)
  const timestamp = Number(createdAtUtcMsc)
  return {
    trading_account_id:positiveId(tradingAccountId) || auditTradingAccountId(request, result),
    created_at_utc_msc:Number.isFinite(timestamp) && timestamp > 0 ? Math.trunc(timestamp) : null,
    terminal_timezone_offset_minutes:effectiveClock
      ? Math.trunc(Number(effectiveClock.timezone_offset_minutes)) : null,
    terminal_clock_status:effectiveClock ? String(effectiveClock.clock_status || '').trim().toLowerCase() : null,
    terminal_clock_source:effectiveClock ? String(effectiveClock.clock_source || 'account_terminal').trim() : null,
  }
}
