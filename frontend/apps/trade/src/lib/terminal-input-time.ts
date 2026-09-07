import { formatDisplayTime } from '@aurum/ui/lib/time'

export function terminalInputTime(value: string, offset: number) {
  const text = formatDisplayTime(value, offset)
  return text === '--' ? '' : text.replace(' ', 'T')
}

// Transaction input requires an explicit offset, never the presentation fallback.
export function terminalInputUtc(value: string, offset: number | null) {
  if (offset === null || !Number.isInteger(offset) || Math.abs(offset) > 840) return NaN
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return NaN
  const normalized = value.length === 16 ? `${value}:00` : value
  const wall = Date.parse(`${normalized}Z`)
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== normalized) return NaN
  return wall - offset * 60_000
}
