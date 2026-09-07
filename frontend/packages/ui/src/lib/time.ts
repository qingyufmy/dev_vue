/** Display an instant without depending on the browser or SSR process timezone. */
export function formatDisplayTime(value: string | null | undefined, offsetMinutes = 480) {
  if (!value || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return '--'
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 840) return '--'
  const instant = new Date(value).getTime()
  if (!Number.isFinite(instant)) return '--'
  return new Date(instant + offsetMinutes * 60_000).toISOString().slice(0, 19).replace('T', ' ')
}

/** Non-laboratory surfaces display Beijing time. Inputs remain UTC instants. */
export function formatBeijingTime(value: string | null | undefined) {
  return formatDisplayTime(value, 480)
}
