import { calculateEma34Evidence } from '../../strategies/index.js'
import { contentHash } from '../domain/inference.js'

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
/** MySQL JSON can round derived doubles. Recover only when frozen inputs reproduce the original full digest. */
export function restoreAnalysisSnapshot(payload: unknown, expectedHash: string): unknown {
  if (!object(payload) || contentHash(payload) === expectedHash) return payload
  const restored = structuredClone(payload)
  const market = restored.market
  if (!object(market) || !object(market.indicators) || !object(market.indicators.ema34)) return payload
  const ema = market.indicators.ema34
  const minutes = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 }[String(ema.timeframe)]
  if (ema.algorithmVersion !== 'ema34-evidence/v1' || ema.ready !== true || !minutes
    || typeof ema.reference_time !== 'string' || !Array.isArray(ema.input_bars) || ema.input_bars.length > 2000
    || ema.input_bars.some(bar => !object(bar) || typeof bar.open_time !== 'string' || typeof bar.close !== 'string' || typeof bar.closed !== 'boolean')) return payload
  const bars = ema.input_bars as Array<{ open_time: string; close: string; closed: boolean }>
  const computed = calculateEma34Evidence(bars.map(bar => ({ openTimeUtcMs: Date.parse(bar.open_time), close: bar.close, closed: bar.closed })),
    { timeframeMs: minutes * 60000, referenceTimeUtcMs: Date.parse(ema.reference_time), internalGapUnresolved: false })
  if (!computed.ready) return payload
  Object.assign(ema, computed)
  return contentHash(restored) === expectedHash ? restored : payload
}
