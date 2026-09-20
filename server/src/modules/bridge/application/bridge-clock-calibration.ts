import type { BridgeGatewayRoute } from '../domain/bridge-gateway.js'
import type { BridgeStreamEventEnvelope } from './bridge-stream-ingestor.js'

interface Sample { symbol: string; raw_time_msc: number; started_at_msc: number; sampled_at_msc: number; monotonic_msc: number; previous?: Sample }
const unavailable = { timezoneOffsetMinutes: null, clockStatus: 'unavailable' as const }

/** Samples are scoped to one authenticated connection; persisted offsets remain owned by trading. */
export class BridgeClockCalibration {
  private readonly previous = new Map<string, Sample>()
  observe(route: BridgeGatewayRoute, event: BridgeStreamEventEnvelope) {
    const key = JSON.stringify([route.userId, route.accountId, route.terminalProfileId, route.terminalInstanceId, route.connectionEpoch, route.connectionId])
    const sample = event.payload.upserts[0]?.clock_sample as Sample | undefined
    if (route.platform !== 'mt5' || !sample || typeof sample !== 'object'
      || Object.keys(sample).filter(k => k !== 'previous').sort().join(',') !== 'monotonic_msc,raw_time_msc,sampled_at_msc,started_at_msc,symbol'
      || typeof sample.symbol !== 'string' || !sample.symbol.length || sample.symbol.length > 64
      || [sample.raw_time_msc, sample.started_at_msc, sample.sampled_at_msc, sample.monotonic_msc].some(n => !Number.isSafeInteger(n) || n <= 0)
      || sample.sampled_at_msc < sample.started_at_msc || sample.sampled_at_msc - sample.started_at_msc > 5000
      || Math.abs(event.payload.observed_at_utc_msc - sample.sampled_at_msc) > 60000) {
      this.previous.delete(key)
      return unavailable
    }
    const previous = sample.previous ?? this.previous.get(key)
    if (sample.previous && (sample.previous.previous || typeof sample.previous !== 'object'
      || Object.keys(sample.previous).sort().join(',') !== 'monotonic_msc,raw_time_msc,sampled_at_msc,started_at_msc,symbol'
      || [sample.previous.raw_time_msc, sample.previous.started_at_msc, sample.previous.sampled_at_msc, sample.previous.monotonic_msc].some(n => !Number.isSafeInteger(n) || n <= 0)
      || sample.previous.sampled_at_msc < sample.previous.started_at_msc || sample.previous.sampled_at_msc - sample.previous.started_at_msc > 5000)) return unavailable
    this.previous.delete(key)
    if (this.previous.size >= 1024) this.previous.delete(this.previous.keys().next().value!)
    this.previous.set(key, { ...sample })
    if (!previous || previous.symbol !== sample.symbol) return unavailable
    const elapsed = sample.sampled_at_msc - previous.sampled_at_msc
    const progress = sample.raw_time_msc - previous.raw_time_msc
    const offset = (s: Sample) => Math.round((s.raw_time_msc - s.sampled_at_msc) / 900_000) * 15
    const candidate = offset(sample)
    if (elapsed < 500 || elapsed > 60_000 || progress <= 0
      || Math.abs(elapsed - (sample.monotonic_msc - previous.monotonic_msc)) > 250
      || Math.abs(progress - elapsed) > 5000 || candidate < -720 || candidate > 840
      || candidate !== offset(previous)
      || [sample, previous].some(s => Math.abs(s.raw_time_msc - candidate * 60_000 - s.sampled_at_msc) > 5000)) return unavailable
    return { timezoneOffsetMinutes: candidate, clockStatus: 'calibrated' as const }
  }
}
