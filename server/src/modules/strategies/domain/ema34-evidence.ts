export interface EmaBar {
  openTimeUtcMs: number
  close: string
  closed: boolean
}

export interface EmaSource {
  timeframeMs: number
  referenceTimeUtcMs: number
  internalGapUnresolved: boolean
}

export const ema34HistoryRequirement = Object.freeze({ minimumBars: 34, warmupBars: 60, evidenceWindow: 5 })

// Technical indicator arithmetic matches the legacy SMA seed / double EMA.
// Raw candle prices remain decimal strings; these values are not money ledgers.
export function calculateEma34Evidence(bars: readonly EmaBar[], source: EmaSource) {
  const unavailable = (reason: string, barsUsed = 0) => ({ algorithmVersion: 'ema34-evidence/v1' as const, ready: false as const,
    reason, value: null, barsUsed, analysis: null })
  if (!Number.isSafeInteger(source.timeframeMs) || source.timeframeMs <= 0 || !Number.isSafeInteger(source.referenceTimeUtcMs)
    || source.referenceTimeUtcMs <= 0 || typeof source.internalGapUnresolved !== 'boolean') return unavailable('indicator_source_invalid')
  if (source.internalGapUnresolved) return unavailable('indicator_internal_gap_unresolved')
  if (bars.some((bar, i) => !Number.isSafeInteger(bar.openTimeUtcMs) || bar.openTimeUtcMs <= 0
    || (i > 0 && bar.openTimeUtcMs <= bars[i - 1]!.openTimeUtcMs))) return unavailable('indicator_bar_time_invalid')
  if (bars.some(bar => typeof bar.closed !== 'boolean')) return unavailable('indicator_bar_close_state_unknown')
  if (bars.some((bar, i) => !bar.closed && i !== bars.length - 1)) return unavailable('indicator_internal_open_bar')
  if (bars.some(bar => typeof bar.close !== 'string' || !/^\d+(?:\.\d+)?$/.test(bar.close) || !Number.isFinite(Number(bar.close)) || Number(bar.close) <= 0)) return unavailable('indicator_non_finite_value')
  const rows = bars.at(-1)?.closed === false ? bars.slice(0, -1) : bars
  if (rows.some(bar => bar.openTimeUtcMs + source.timeframeMs > source.referenceTimeUtcMs)) return unavailable('indicator_future_closed_bar')
  const latest = rows.at(-1)
  if (latest && source.referenceTimeUtcMs - (latest.openTimeUtcMs + source.timeframeMs) > Math.max(120_000, source.timeframeMs * 2)) return unavailable('indicator_source_stale', rows.length)
  if (rows.length < 34) return unavailable('indicator_history_insufficient', rows.length)
  const prices = rows.map(bar => Number(bar.close))
  const averages: number[] = []
  let value = prices.slice(0, 34).reduce((sum, price) => sum + price, 0) / 34
  averages.push(value)
  for (let i = 34; i < prices.length; i++) {
    value = (prices[i]! - value) * (2 / 35) + value
    averages.push(value)
  }
  if (averages.some(value => !Number.isFinite(value))) return unavailable('indicator_numeric_overflow', rows.length)
  const previous = averages.length > 1 ? averages.at(-2)! : null
  const relation = (price: number, average: number) => price > average ? 'above' : price < average ? 'below' : 'at_average'
  const observations = averages.slice(-5).map((average, i, selected) => relation(prices[prices.length - selected.length + i]!, average))
  let latestCross = 'none', crossBarsAgo: number | null = null
  for (let i = observations.length - 1; i > 0; i--) {
    if (observations[i] === 'above' && observations[i - 1] !== 'above') { latestCross = 'crossed_above'; crossBarsAgo = observations.length - 1 - i; break }
    if (observations[i] === 'below' && observations[i - 1] !== 'below') { latestCross = 'crossed_below'; crossBarsAgo = observations.length - 1 - i; break }
  }
  const fieldValue = prices.at(-1)!, distance = fieldValue - value, slope = previous === null ? null : value - previous
  return { algorithmVersion: 'ema34-evidence/v1' as const, ready: true as const, reason: 'ready', value, barsUsed: rows.length,
    analysis: { warmup_complete: rows.length >= 60, evidence_quality: rows.length >= 60 ? 'reliable' : 'limited',
      field_value: fieldValue, previous_value: previous, relation: relation(fieldValue, value), distance,
      distance_pct: value !== 0 ? distance / Math.abs(value) * 100 : null, slope,
      slope_pct: previous !== null && previous !== 0 && slope !== null ? slope / Math.abs(previous) * 100 : null,
      slope_direction: slope === null ? 'unavailable' : slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat',
      observation_window: observations.length, bars_above: observations.filter(item => item === 'above').length,
      bars_below: observations.filter(item => item === 'below').length, bars_at_average: observations.filter(item => item === 'at_average').length,
      latest_cross: latestCross, cross_bars_ago: crossBarsAgo } }
}

export interface Ema34Plan { version: 1; timeframe: 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1' }

export function parseEma34Plan(value: unknown): Ema34Plan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ema34_plan_invalid')
  const plan = value as Record<string, unknown>
  if (Object.keys(plan).length !== 2 || plan.version !== 1 || typeof plan.timeframe !== 'string'
    || !['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].includes(plan.timeframe)) throw new Error('ema34_plan_invalid')
  return { version: 1, timeframe: plan.timeframe as Ema34Plan['timeframe'] }
}
