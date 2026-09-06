// Presentation only: never write this fallback into account or risk evidence.
export const DEFAULT_DISPLAY_OFFSET_MINUTES = 180

export function terminalDisplayTimezone(offset: number | null | undefined, status?: string | null) {
  const isDefault = typeof offset !== 'number' || !Number.isInteger(offset) || Math.abs(offset) > 840
  const offsetMinutes = isDefault ? DEFAULT_DISPLAY_OFFSET_MINUTES : offset
  const absolute = Math.abs(offsetMinutes)
  const label = `UTC${offsetMinutes >= 0 ? '+' : '-'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
  const statusLabel = isDefault ? '默认时区，待校准'
    : status === 'calibrated' ? '已校准'
      : status === 'stale' ? '沿用最近时区，待更新'
        : status === 'observer_bootstrap' ? '观摩源临时时区'
          : '账户时区，待校准'
  return { offsetMinutes, label, statusLabel, isDefault }
}

export function terminalDisplayDate(date: Date, offset?: number | null) {
  return new Date(date.getTime() + terminalDisplayTimezone(offset).offsetMinutes * 60_000)
}
