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

export type PublicChanLineKind = 'bi' | 'segment' | 'forming_segment' | 'center' | 'bi_center' | 'fractal_top' | 'fractal_bottom'

export interface PublicChanLine {
  kind: PublicChanLineKind
  from: string
  to: string
  start: number
  end: number
}

export interface PublicChanTrend {
  state: string
  direction: 'up' | 'down' | 'neutral'
  phase: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
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

function publicTrend(value: unknown): PublicChanTrend | null {
  const trend = object(value)
  const direction = ['up', 'down', 'neutral'].includes(String(trend.direction))
    ? trend.direction as PublicChanTrend['direction'] : 'neutral'
  const confidence = ['high', 'medium', 'low'].includes(String(trend.confidence))
    ? trend.confidence as PublicChanTrend['confidence'] : 'low'
  if (!String(trend.state || '').trim()) return null
  return {
    state: String(trend.state).slice(0, 64),
    direction,
    phase: String(trend.phase || 'unknown').slice(0, 64),
    confidence,
    reason: String(trend.reason || 'structure_unavailable').slice(0, 128),
  }
}

export function recentBiFractalLines(values: readonly unknown[]): PublicChanLine[] {
  const lines: PublicChanLine[] = []
  const keys = new Set<string>()
  const add = (kind: 'fractal_top' | 'fractal_bottom', at: unknown, price: unknown) => {
    const atIso = typeof at === 'string' ? at : iso(at)
    const numericPrice = number(price)
    if (!atIso || !Number.isFinite(Date.parse(atIso)) || !Number.isFinite(numericPrice)) return
    const key = `${kind}:${atIso}:${numericPrice}`
    if (keys.has(key)) return
    keys.add(key)
    lines.push({ kind, from: atIso, to: atIso, start: numericPrice, end: numericPrice })
  }
  for (const value of values) {
    const bi = object(value)
    if (bi.confirmed !== true || !['up', 'down'].includes(String(bi.dir))) continue
    add(bi.dir === 'up' ? 'fractal_bottom' : 'fractal_top', bi.start_time_utc_msc, bi.start_price)
    add(bi.dir === 'up' ? 'fractal_top' : 'fractal_bottom', bi.end_time_utc_msc, bi.end_price)
  }
  return lines
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
  includeDeveloping?: boolean
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
    trend: null,
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
  const lineKeys = new Set<string>()
  const add = (kind: PublicChanLineKind, from: unknown, to: unknown, start: unknown, end: unknown, allowPoint = false) => {
    const fromIso = typeof from === 'string' ? from : iso(from)
    const toIso = typeof to === 'string' ? to : iso(to)
    const startPrice = number(start)
    const endPrice = number(end)
    if (!fromIso || !toIso || !Number.isFinite(Date.parse(fromIso)) || !Number.isFinite(Date.parse(toIso))
      || (!allowPoint && Date.parse(fromIso) >= Date.parse(toIso))
      || (allowPoint && Date.parse(fromIso) !== Date.parse(toIso))
      || !Number.isFinite(startPrice) || !Number.isFinite(endPrice)) return
    const key = `${kind}:${fromIso}:${toIso}:${startPrice}:${endPrice}`
    if (lineKeys.has(key)) return
    lineKeys.add(key)
    lines.push({ kind, from: fromIso, to: toIso, start: startPrice, end: endPrice })
  }
  const recentBis = Array.isArray(result.recent_bis) ? result.recent_bis : []
  for (const bi of recentBis) {
    const row = object(bi)
    if (row.confirmed === true) add('bi', row.start_time_utc_msc, row.end_time_utc_msc, row.start_price, row.end_price)
  }
  const confirmedSegments = (result as unknown as { _confirmed_segments?: readonly unknown[] })._confirmed_segments
  for (const segment of Array.isArray(confirmedSegments) ? confirmedSegments.slice(-4) : []) {
    const row = object(segment)
    add('segment', row.start_time_utc_msc ?? row.start_time, row.end_time_utc_msc ?? row.end_time, row.start_price, row.end_price)
  }
  const includeDeveloping = input.includeDeveloping !== false
  const candidate = object(result.candidate_segment)
  if (includeDeveloping && candidate.active_for_current_state !== false) {
    add('forming_segment', candidate.start_time_utc_msc ?? candidate.start_time, candidate.end_time_utc_msc ?? candidate.end_time, candidate.start_price, candidate.end_price)
  }
  const confirmedCenters = (result as unknown as { _confirmed_centers?: readonly unknown[] })._confirmed_centers
  const centers = Array.isArray(confirmedCenters) ? confirmedCenters.slice(-3) : []
  if (includeDeveloping && result.active_center) centers.push(result.active_center)
  for (const value of centers) {
    const center = object(value)
    const centerFrom = center.start_time_utc_msc ?? center.start_time
    const centerTo = center.end_time_utc_msc ?? center.end_time
    add('center', centerFrom, centerTo, center.zh, center.zh)
    add('center', centerFrom, centerTo, center.zl, center.zl)
  }
  const biCenter = object(result.latest_bi_center)
  const biCenterFrom = biCenter.start_time_utc_msc ?? biCenter.start_time
  const biCenterTo = biCenter.end_time_utc_msc ?? biCenter.end_time
  add('bi_center', biCenterFrom, biCenterTo, biCenter.zh, biCenter.zh)
  add('bi_center', biCenterFrom, biCenterTo, biCenter.zl, biCenter.zl)
  for (const line of recentBiFractalLines(recentBis)) add(line.kind, line.from, line.to, line.start, line.end, true)
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
    trend: publicTrend(result.trend_state),
    lines,
  }
}
