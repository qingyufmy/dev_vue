import { TradingAccessError, type AccountSnapshot } from './trading.js'

export type AccountClock = Pick<AccountSnapshot, 'timezoneOffsetMinutes' | 'clockStatus'>

// The caller must establish provenance equality before supplying previous evidence.
export function resolveAccountClock(incoming: AccountClock, previous: AccountClock | null): AccountClock {
  const validOffset = (value: unknown): value is number => Number.isInteger(value) && Math.abs(Number(value)) <= 840
  if (!['calibrated', 'observer_bootstrap', 'stale', 'unavailable'].includes(incoming.clockStatus)
    || (incoming.timezoneOffsetMinutes !== null && !validOffset(incoming.timezoneOffsetMinutes))) {
    throw new TradingAccessError('trading_context_invalid', 400)
  }
  if (incoming.clockStatus === 'calibrated' || incoming.clockStatus === 'observer_bootstrap') {
    if (!validOffset(incoming.timezoneOffsetMinutes)) throw new TradingAccessError('trading_context_invalid', 400)
    return { ...incoming }
  }
  if (previous && (previous.clockStatus === 'calibrated' || previous.clockStatus === 'stale')
    && validOffset(previous.timezoneOffsetMinutes)) {
    return { timezoneOffsetMinutes: previous.timezoneOffsetMinutes, clockStatus: 'stale' }
  }
  return { timezoneOffsetMinutes: null, clockStatus: 'unavailable' }
}
