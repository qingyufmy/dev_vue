import { InferenceError, type JsonObject } from './inference.js'

export type FrozenAnalysisAtr =
  | { status: 'available'; value: string; timeframe: 'H1' | 'H4'; period: 14; method: 'closed-tr-sma14/v1'; lastBarOpenTime: string }
  | { status: 'unavailable'; reason: 'insufficient_closed_hourly_bars' }

const unit = 10n ** 18n
const invalid = (): never => { throw new InferenceError('frozen_analysis_atr_invalid', 409) }
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
function price(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(value)) return invalid()
  const [whole, fraction = ''] = value.split('.')
  const result = BigInt(whole!) * unit + BigInt(fraction.padEnd(18, '0'))
  return result > 0n ? result : invalid()
}
function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return invalid()
  const result = Date.parse(value)
  return Number.isFinite(result) && new Date(result).toISOString() === value ? result : invalid()
}
const abs = (value: bigint) => value < 0n ? -value : value

/** Uses only frozen closed bars. Session gaps are retained, never filled with fabricated bars. */
export function frozenAnalysisAtr(market: JsonObject, capturedAt: string): FrozenAnalysisAtr {
  const reference = instant(capturedAt)
  if (market.candles === undefined) return { status: 'unavailable', reason: 'insufficient_closed_hourly_bars' }
  if (!object(market.candles)) return invalid()
  for (const timeframe of ['H1', 'H4'] as const) {
    const source = market.candles[timeframe]
    if (source === undefined) continue
    if (!Array.isArray(source) || source.length > 1000) return invalid()
    const duration = (timeframe === 'H1' ? 1 : 4) * 3_600_000
    let previous = -Infinity
    const closed: JsonObject[] = []
    for (const bar of source) {
      if (!object(bar) || typeof bar.closed !== 'boolean') return invalid()
      const time = instant(bar.open_time)
      if (time <= previous || time > reference) return invalid()
      previous = time
      if (bar.closed) {
        if (time + duration > reference) return invalid()
        closed.push(bar)
      }
    }
    if (closed.length < 15) continue
    const bars = closed.slice(-15).map(bar => {
      const high = price(bar.high), low = price(bar.low), close = price(bar.close), open = price(bar.open)
      if (high < low || close < low || close > high || open < low || open > high) return invalid()
      return { high, low, close }
    })
    let total = 0n
    for (let i = 1; i < bars.length; i++) {
      const bar = bars[i]!, prior = bars[i - 1]!
      total += [bar.high - bar.low, abs(bar.high - prior.close), abs(bar.low - prior.close)].reduce((a, b) => a > b ? a : b)
    }
    // Deterministic half-up rounding to the execution comparator's 18 decimal places.
    const average = (total + 7n) / 14n
    const fraction = (average % unit).toString().padStart(18, '0').replace(/0+$/, '')
    return { status: 'available', value: `${average / unit}${fraction ? `.${fraction}` : ''}`, timeframe,
      period: 14, method: 'closed-tr-sma14/v1', lastBarOpenTime: closed.at(-1)!.open_time as string }
  }
  return { status: 'unavailable', reason: 'insufficient_closed_hourly_bars' }
}
