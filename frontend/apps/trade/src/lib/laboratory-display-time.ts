import { publicDisplayClock } from '~/features/trading-context'
import { formatDisplayTime } from '@aurum/ui/lib/time'
import { terminalDisplayTimezone } from './terminal-display-time'

export function activeTerminalDisplayTimezone() {
  return terminalDisplayTimezone(publicDisplayClock.value?.offset_minutes, publicDisplayClock.value?.status)
}

export function activeTerminalDisplayOffset() {
  return activeTerminalDisplayTimezone().offsetMinutes
}

export function formatLaboratoryTime(value: string | null | undefined, offset: number | null | undefined = activeTerminalDisplayOffset()) {
  return formatDisplayTime(value, terminalDisplayTimezone(offset).offsetMinutes)
}
