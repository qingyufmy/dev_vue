import type { ChanBi, ChanRate, EvidenceSegment } from './types.js'
import type { Center } from './centers.js'
import { segmentLocation } from './segment-location.js'
import { round5 } from './rounding.js'

export function summarizeBiCenter(center: Center | null | undefined, timeframe: string | null, bis: readonly ChanBi[] = [], rates: readonly ChanRate[] = []) {
  if (!center) return null
  const startBi = bis.find(item => item.id === center.start_component_id)
  const endBi = bis.find(item => item.id === center.end_component_id)
  const startIndex = Number(startBi?.raw_start_idx)
  const endIndex = Number(endBi?.raw_end_idx)
  return {
    id: center.id,
    zl: round5(center.zl),
    zh: round5(center.zh),
    gg: round5(center.fluctuation_high),
    dd: round5(center.fluctuation_low),
    status: center.status,
    source_timeframe: timeframe,
    structure_level: 'bi',
    start_bi_id: center.start_component_id,
    end_bi_id: center.end_component_id,
    closed_by_bi_id: center.departure_component_id,
    start_index: Number.isFinite(startIndex) ? startIndex : null,
    end_index: Number.isFinite(endIndex) ? endIndex : null,
    start_time: Number.isFinite(startIndex) ? rates[startIndex]?.time ?? null : null,
    end_time: Number.isFinite(endIndex) ? rates[endIndex]?.time ?? null : null,
    start_time_utc_msc: Number.isFinite(startIndex) && Number.isFinite(Number(rates[startIndex]?.time_utc_msc))
      ? Number(rates[startIndex]!.time_utc_msc) : null,
    end_time_utc_msc: Number.isFinite(endIndex) && Number.isFinite(Number(rates[endIndex]?.time_utc_msc))
      ? Number(rates[endIndex]!.time_utc_msc) : null,
  }
}


export function summarizeCenter(center: Center | null | undefined, timeframe: string | null, segments: readonly EvidenceSegment[] = [], bis: readonly ChanBi[] = [], rates: readonly ChanRate[] = []) {
  if (!center) return null
  const entrySegment = segments.find(segment => segment.id === center.entry_segment_id)
  const startSegment = segments.find(segment => segment.id === center.start_segment_id)
  const endSegment = segments.find(segment => segment.id === center.end_segment_id)
  const departureSegment = segments.find(segment => segment.id === center.departure_segment_id)
  const entryLocation = segmentLocation(entrySegment, bis, rates)
  const startLocation = segmentLocation(startSegment, bis, rates)
  const endLocation = segmentLocation(endSegment, bis, rates)
  const departureLocation = segmentLocation(departureSegment, bis, rates)
  const coreSegmentStableIds = (center.segment_ids || [])
    .slice(0, 3)
    .map(id => segmentLocation(segments.find(segment => segment.id === id), bis, rates)?.stable_id || null)
  const completeCoreSegmentStableIds = coreSegmentStableIds.length === 3 && coreSegmentStableIds.every(Boolean)
    ? coreSegmentStableIds
    : null
  const stableId = startLocation?.stable_id && endLocation?.stable_id
    ? `${startLocation.stable_id}|${endLocation.stable_id}`
    : null
  return {
    id: center.id,
    stable_id: stableId,
    core_stable_id:completeCoreSegmentStableIds ? completeCoreSegmentStableIds.join('|') : null,
    core_segment_stable_ids:completeCoreSegmentStableIds,
    zl: round5(center.zl),
    zh: round5(center.zh),
    gg: round5(center.fluctuation_high),
    dd: round5(center.fluctuation_low),
    status: center.status,
    source_timeframe: timeframe,
    structure_level: 'segment',
    level: timeframe,
    component_level: center.component_level || 'segment',
    entry_segment_id: center.entry_segment_id ?? null,
    entry_segment_stable_id: entryLocation?.stable_id ?? null,
    entry_segment_start_time_utc_msc: entryLocation?.start_time_utc_msc ?? null,
    entry_segment_end_time_utc_msc: entryLocation?.end_time_utc_msc ?? null,
    start_segment_id: center.start_segment_id,
    start_segment_stable_id: startLocation?.stable_id ?? null,
    end_segment_id: center.end_segment_id,
    end_segment_stable_id: endLocation?.stable_id ?? null,
    departure_segment_id: center.departure_segment_id ?? null,
    departure_segment_stable_id: departureLocation?.stable_id ?? null,
    closed_by_segment_id: center.closed_by_segment_id,
    start_index: startLocation?.start_index ?? null,
    end_index: endLocation?.end_index ?? null,
    start_time: startLocation?.start_time ?? null,
    end_time: endLocation?.end_time ?? null,
    start_broker_time: startLocation?.start_broker_time ?? null,
    end_broker_time: endLocation?.end_broker_time ?? null,
    start_time_utc_msc: startLocation?.start_time_utc_msc ?? null,
    end_time_utc_msc: endLocation?.end_time_utc_msc ?? null,
  }
}
