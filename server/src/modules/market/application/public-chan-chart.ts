import { calculateChanChartStructure, chanHistoryTarget } from './chan-market-evidence.js'

interface Candle {
  openTime: string
  open: string
  high: string
  low: string
  close: string
  closed: boolean
}

interface PublicSourceClock {
  offset: number
  checkedAt: string
}

export type PublicChanLineKind = 'bi' | 'segment' | 'forming_segment' | 'center' | 'fractal_top' | 'fractal_bottom'

export interface PublicChanLine {
  kind: PublicChanLineKind
  from: string
  to: string
  start: number
  end: number
}

const timeframeMs: Record<string, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function number(value: unknown) {
  return typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
}

function iso(value: unknown) {
  const parsed = number(value)
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null
}

/** Projects the existing Chan engine into a small, display-only chart payload.
 * It never emits entries or trade instructions and only accepts closed bars. */
export function publicChanChart(input: {
  accountId: string
  platform: 'mt4' | 'mt5'
  timeframe: string
  candles: readonly Candle[]
  clock: PublicSourceClock | null
  referenceTime: string
}) {
  const target = chanHistoryTarget(input.timeframe)
  const duration = timeframeMs[input.timeframe]
  if (!target || !duration) return null
  const closed = input.candles.filter(candle => candle.closed).slice(-target)
  if (closed.length < 30) return {
    algorithm: 'chan_structure_v8' as const,
    status: 'insufficient_klines',
    reliability: 'low',
    based_on_closed_bars: closed.length,
    lines: [] as PublicChanLine[],
  }
  const result = calculateChanChartStructure(closed, {
    timeframe: input.timeframe,
    timeframeMs: duration,
    referenceTime: input.referenceTime,
    accountId: input.accountId,
    platform: input.platform,
    clock: input.clock ? {
      clockStatus: 'calibrated',
      timezoneOffsetMinutes: input.clock.offset,
      observedAt: input.clock.checkedAt,
      dailyCalibration: true,
    } : null,
  })
  const lines: PublicChanLine[] = []
  const add = (kind: PublicChanLineKind, from: unknown, to: unknown, start: unknown, end: unknown, allowPoint = false) => {
    const fromIso = typeof from === 'string' ? from : iso(from)
    const toIso = typeof to === 'string' ? to : iso(to)
    const startPrice = number(start)
    const endPrice = number(end)
    if (!fromIso || !toIso || !Number.isFinite(Date.parse(fromIso)) || !Number.isFinite(Date.parse(toIso))
      || (!allowPoint && Date.parse(fromIso) >= Date.parse(toIso))
      || (allowPoint && Date.parse(fromIso) !== Date.parse(toIso))
      || !Number.isFinite(startPrice) || !Number.isFinite(endPrice)) return
    lines.push({ kind, from: fromIso, to: toIso, start: startPrice, end: endPrice })
  }
  for (const bi of Array.isArray(result.recent_bis) ? result.recent_bis : []) {
    const row = object(bi)
    if (row.confirmed === true) add('bi', row.start_time_utc_msc, row.end_time_utc_msc, row.start_price, row.end_price)
  }
  const confirmedSegments = (result as unknown as { _confirmed_segments?: readonly unknown[] })._confirmed_segments
  for (const segment of Array.isArray(confirmedSegments) ? confirmedSegments.slice(-4) : []) {
    const row = object(segment)
    add('segment', row.start_time_utc_msc ?? row.start_time, row.end_time_utc_msc ?? row.end_time, row.start_price, row.end_price)
  }
  const candidate = object(result.candidate_segment)
  if (candidate.active_for_current_state !== false) {
    add('forming_segment', candidate.start_time_utc_msc ?? candidate.start_time, candidate.end_time_utc_msc ?? candidate.end_time, candidate.start_price, candidate.end_price)
  }
  const center = object(result.active_center)
  const centerFrom = center.start_time_utc_msc ?? center.start_time
  const centerTo = center.end_time_utc_msc ?? center.end_time
  add('center', centerFrom, centerTo, center.zh, center.zh)
  add('center', centerFrom, centerTo, center.zl, center.zl)
  const fractal = object(object(result.latest_structure).latest_confirmed_fractal)
  if (fractal.confirmed === true && (fractal.type === 'top' || fractal.type === 'bottom')) {
    const at = fractal.time_utc_msc ?? fractal.time
    add(`fractal_${fractal.type}`, at, at, fractal.price, fractal.price, true)
  }
  return {
    algorithm: 'chan_structure_v8' as const,
    status: String(result.status || 'unavailable'),
    reliability: ['high', 'medium', 'low'].includes(String(result.reliability)) ? String(result.reliability) as 'high' | 'medium' | 'low' : 'low' as const,
    based_on_closed_bars: closed.length,
    lines,
  }
}
