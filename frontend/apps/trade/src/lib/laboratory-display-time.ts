import { formatDisplayTime } from '@aurum/ui/lib/time'
import { accountSnapshot, tradingContext } from './trading-runtime'
import { terminalDisplayTimezone } from './terminal-display-time'

export function activeTerminalDisplayTimezone() {
  const snapshot = accountSnapshot.value
  const offset = snapshot && snapshot.id === tradingContext.value?.accountId
    ? snapshot.timezoneOffsetMinutes : null
  return terminalDisplayTimezone(offset, snapshot?.id === tradingContext.value?.accountId ? snapshot?.clockStatus : null)
}

export function activeTerminalDisplayOffset() {
  return activeTerminalDisplayTimezone().offsetMinutes
}

export function formatLaboratoryTime(value: string | null | undefined, offset: number | null | undefined = activeTerminalDisplayOffset()) {
  return formatDisplayTime(value, terminalDisplayTimezone(offset).offsetMinutes)
}
