import type { ChanBi, ChanRate, EvidenceSegment } from './types.js'
import { round5 } from './rounding.js'

export function segmentLocation(segment: EvidenceSegment | null | undefined, bis: readonly ChanBi[], rates: readonly ChanRate[] = []) {
  if (!segment) return null
  const price = (value: unknown) => Number.isFinite(Number(value)) ? round5(Number(value)) : null
  const segmentBis = (segment.bi_ids || []).map(id => bis.find(b => b.id === id)).filter((item): item is ChanBi => item !== undefined)
  const startIndex = Number.isFinite(Number(segment.raw_start_idx))
    ? Number(segment.raw_start_idx)
    : segmentBis.length ? Math.min(...segmentBis.map(b => Number(b.raw_start_idx))) : null
  const endIndex = segment.endpoint_raw_idx != null && Number.isFinite(Number(segment.endpoint_raw_idx))
    ? Number(segment.endpoint_raw_idx)
    : Number.isFinite(Number(segment.raw_end_idx))
    ? Number(segment.raw_end_idx)
    : segmentBis.length ? Math.max(...segmentBis.map(b => Number(b.raw_end_idx))) : null
  const observationEndIndex = Number.isFinite(Number(segment.raw_end_idx))
    ? Number(segment.raw_end_idx)
    : segmentBis.length ? Math.max(...segmentBis.map(b => Number(b.raw_end_idx))) : endIndex
  const startUtcMs = startIndex != null && Number.isFinite(Number(rates[startIndex]?.time_utc_msc)) ? Number(rates[startIndex]!.time_utc_msc) : null
  const endUtcMs = endIndex != null && Number.isFinite(Number(rates[endIndex]?.time_utc_msc)) ? Number(rates[endIndex]!.time_utc_msc) : null
  const observationEndUtcMs = observationEndIndex != null && Number.isFinite(Number(rates[observationEndIndex]?.time_utc_msc))
    ? Number(rates[observationEndIndex]!.time_utc_msc) : null
  const startBrokerTime = startIndex != null ? rates[startIndex]?.time ?? null : null
  const endBrokerTime = endIndex != null ? rates[endIndex]?.time ?? null : null
  const observationEndBrokerTime = observationEndIndex != null ? rates[observationEndIndex]?.time ?? null : null
  const stableId = startUtcMs != null && endUtcMs != null
    ? `${segment.dir || 'unknown'}:${startUtcMs}:${endUtcMs}`
    : startBrokerTime != null && endBrokerTime != null ? `${segment.dir || 'unknown'}:${startBrokerTime}:${endBrokerTime}` : null
  return {
    id: segment.id ?? null,
    stable_id: stableId,
    dir: segment.dir || null,
    start_index: startIndex,
    end_index: endIndex,
    start_time: startBrokerTime,
    end_time: endBrokerTime,
    start_broker_time: startBrokerTime,
    end_broker_time: endBrokerTime,
    start_time_utc_msc: startUtcMs,
    end_time_utc_msc: endUtcMs,
    observation_end_index: observationEndIndex,
    observation_end_broker_time: observationEndBrokerTime,
    observation_end_time_utc_msc: observationEndUtcMs,
    last_included_bi_id: segmentBis.at(-1)?.id ?? segment.bi_ids?.at?.(-1) ?? null,
    start_price: price(segment.start_price),
    end_price: price(segment.end_price),
    high: price(segment.high),
    low: price(segment.low),
  }
}
