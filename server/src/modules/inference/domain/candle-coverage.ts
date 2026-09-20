import type { JsonObject } from './inference.js'

// Counts only the requested model candles. It does not prove freshness,
// continuity, closed-bar status or indicator readiness.
export function candleCoverage(requests: Array<{ timeframe: string; count: number }>, candles: Record<string, JsonObject[]>): JsonObject {
  if (!requests.length || new Set(requests.map(item => item.timeframe)).size !== requests.length
    || requests.some(item => !['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].includes(item.timeframe)
      || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > 1000)) throw new Error('candle_coverage_plan_invalid')
  const frames = requests.map(item => {
    const rows = candles[item.timeframe]
    if (!Array.isArray(rows)) throw new Error('candle_coverage_frame_missing')
    return { timeframe: item.timeframe, requested_bars: item.count, available_bars: rows.length }
  })
  return { version: 1, status: frames.every(frame => frame.available_bars >= frame.requested_bars) ? 'complete' : 'partial', frames }
}
