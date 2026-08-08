const DEFAULT_PROBE_SYMBOL = 'XAUUSD'
const MAX_WINDOWS = 128

function gateError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function minuteOfDay(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''))
  if (!match) throw gateError('bridge_maintenance_window_configuration_invalid')
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw gateError('bridge_maintenance_window_configuration_invalid')
  return hour * 60 + minute
}

function normalizeProbeSymbol(value) {
  const symbol = String(value || DEFAULT_PROBE_SYMBOL).trim().toUpperCase()
  if (!/^[A-Z0-9._-]{1,32}$/.test(symbol)) {
    throw gateError('bridge_maintenance_window_configuration_invalid')
  }
  return symbol
}

export function resolveBridgeUpdateMaintenanceWindows(raw = process.env.BRIDGE_UPDATE_MAINTENANCE_WINDOWS_JSON) {
  if (raw == null || String(raw).trim() === '') return Object.freeze([])
  let parsed
  try {
    parsed = JSON.parse(String(raw))
  } catch {
    throw gateError('bridge_maintenance_window_configuration_invalid')
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_WINDOWS) {
    throw gateError('bridge_maintenance_window_configuration_invalid')
  }
  const identities = new Set()
  const windows = parsed.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !exactKeys(value, [
        'platform', 'broker_server', 'timezone_offset_minutes',
        'start', 'end', 'probe_symbol',
      ])) {
      throw gateError('bridge_maintenance_window_configuration_invalid')
    }
    const platform = String(value.platform || '').trim().toLowerCase()
    const brokerServer = String(value.broker_server || '').trim()
    const timezoneOffsetMinutes = Number(value.timezone_offset_minutes)
    const startMinute = minuteOfDay(value.start)
    const endMinute = minuteOfDay(value.end)
    if (!['mt4', 'mt5'].includes(platform) || !brokerServer || brokerServer.length > 128
      || !Number.isInteger(timezoneOffsetMinutes)
      || timezoneOffsetMinutes < -840 || timezoneOffsetMinutes > 840
      || startMinute === endMinute) {
      throw gateError('bridge_maintenance_window_configuration_invalid')
    }
    const identity = `${platform}\n${brokerServer.toLowerCase()}`
    if (identities.has(identity)) throw gateError('bridge_maintenance_window_configuration_invalid')
    identities.add(identity)
    return Object.freeze({
      platform,
      broker_server:brokerServer,
      timezone_offset_minutes:timezoneOffsetMinutes,
      start_minute:startMinute,
      end_minute:endMinute,
      probe_symbol:normalizeProbeSymbol(value.probe_symbol),
    })
  })
  return Object.freeze(windows)
}

function windowForTerminal(windows, terminal) {
  return windows.find(window => window.platform === String(terminal.platform || '').toLowerCase()
    && window.broker_server.toLowerCase()
      === String(terminal.account_ref?.broker_server || '').trim().toLowerCase()) || null
}

function windowPosition(window, nowUtcMsc) {
  const shifted = new Date(nowUtcMsc + window.timezone_offset_minutes * 60_000)
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  const { start_minute:start, end_minute:end } = window
  const inside = start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end
  if (!inside) return { inside:false, remainingSeconds:0 }
  const remainingMinutes = start < end || minute < end
    ? end - minute
    : 1440 - minute + end
  const remainingSeconds = remainingMinutes * 60 - shifted.getUTCSeconds()
  return { inside:true, remainingSeconds }
}

function safelyClosedMarket(sample) {
  if (!sample || sample.status !== 'success' || sample.terminal_connected === false) return false
  if (!['closed', 'stale'].includes(String(sample.market_state || '').toLowerCase())) return false
  const tickAge = Number(sample.tick_age_seconds)
  const unchanged = Number(sample.tick_unchanged_seconds)
  return Number.isFinite(tickAge) && tickAge >= 90
    || Number.isFinite(unchanged) && unchanged >= 90
}

function denial(code, retryAfterSeconds) {
  return { allowed:false, code, retry_after_seconds:retryAfterSeconds }
}

export function createBridgeAutomaticMaintenanceWindowGate({
  windows = resolveBridgeUpdateMaintenanceWindows(),
  resolveTerminals,
  probeMarket,
  now = Date.now,
} = {}) {
  if (!Array.isArray(windows) || typeof resolveTerminals !== 'function'
    || typeof probeMarket !== 'function' || typeof now !== 'function') {
    throw new TypeError('bridge_maintenance_window_gate_invalid')
  }
  return async function check({ priority, manualRequest, authorizedUserIds, terminalInstanceIds }) {
    if (priority === 'urgent' || manualRequest === true) return { allowed:true, mode:'safe_idle' }
    if (priority !== 'normal' || manualRequest !== false) {
      throw gateError('bridge_maintenance_request_invalid')
    }
    if (!Array.isArray(authorizedUserIds) || !Array.isArray(terminalInstanceIds)
      || terminalInstanceIds.length < 1 || terminalInstanceIds.length > 64
      || new Set(terminalInstanceIds.map(String)).size !== terminalInstanceIds.length) {
      throw gateError('bridge_maintenance_request_invalid')
    }
    const terminals = await resolveTerminals(authorizedUserIds, terminalInstanceIds)
    if (!Array.isArray(terminals) || terminals.length !== terminalInstanceIds.length) {
      throw gateError('bridge_maintenance_terminal_forbidden')
    }
    const nowUtcMsc = Number(now())
    if (!Number.isSafeInteger(nowUtcMsc) || nowUtcMsc <= 0) {
      throw gateError('bridge_maintenance_clock_invalid')
    }
    const utcDay = new Date(nowUtcMsc).getUTCDay()
    const weekend = utcDay === 0 || utcDay === 6
    const planned = []
    for (const terminal of terminals) {
      const window = windowForTerminal(windows, terminal)
      if (!weekend && !window) {
        return denial('bridge_maintenance_window_unconfigured', 900)
      }
      if (!weekend) {
        const position = windowPosition(window, nowUtcMsc)
        if (!position.inside) return denial('bridge_maintenance_window_not_open', 300)
        if (position.remainingSeconds < 180) {
          return denial('bridge_maintenance_window_too_short', 300)
        }
      }
      planned.push({ terminal, window, symbol:window?.probe_symbol || DEFAULT_PROBE_SYMBOL })
    }
    for (const item of planned) {
      let sample
      try {
        sample = await probeMarket(item.terminal, item.symbol)
      } catch {
        return denial('bridge_maintenance_market_probe_failed', 30)
      }
      if (item.window
        && (!Number.isInteger(Number(sample?.timezone_offset_minutes))
          || Number(sample.timezone_offset_minutes) !== item.window.timezone_offset_minutes)) {
        return denial('bridge_maintenance_terminal_clock_unavailable', 300)
      }
      if (!safelyClosedMarket(sample)) {
        return denial('bridge_maintenance_market_not_closed', 30)
      }
    }
    return { allowed:true, mode:weekend ? 'weekend_closed' : 'daily_maintenance' }
  }
}
