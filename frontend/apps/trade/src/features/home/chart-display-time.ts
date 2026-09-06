import { TickMarkType, type Time } from 'lightweight-charts'
import { terminalDisplayDate } from '~/lib/terminal-display-time'

export function chartDisplayTime(time: Time, offset?: number | null, tick?: TickMarkType) {
  const date = typeof time === 'number' ? new Date(time * 1000)
    : typeof time === 'string' ? new Date(time)
      : new Date(Date.UTC(time.year, time.month - 1, time.day))
  const text = terminalDisplayDate(date, offset).toISOString()
  if (tick === TickMarkType.Year) return text.slice(0, 4)
  if (tick === TickMarkType.Month) return text.slice(5, 7)
  if (tick === TickMarkType.DayOfMonth) return text.slice(5, 10)
  if (tick === TickMarkType.Time) return text.slice(11, 16)
  if (tick === TickMarkType.TimeWithSeconds) return text.slice(11, 19)
  return `${text.slice(0, 10)} ${text.slice(11, 19)}`
}
