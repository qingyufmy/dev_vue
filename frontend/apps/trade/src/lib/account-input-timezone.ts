import { accountSnapshot, tradingContext } from '~/features/trading-context'
import { terminalDisplayTimezone } from './terminal-display-time'

// Transaction inputs must use the selected account's calibrated clock.
export function accountInputTimezone() {
  const snapshot = accountSnapshot.value
  const valid = snapshot?.id === tradingContext.value?.accountId && snapshot?.clockStatus === 'calibrated'
  return terminalDisplayTimezone(valid ? snapshot?.timezoneOffsetMinutes : null, valid ? 'calibrated' : null)
}
