import { round5 } from './rounding.js'
import { confirmedSegmentEvidence, type WindowEvidence, type WindowSegment, type WindowCenter } from './window-evidence.js'
type RebuiltCenter = NonNullable<ReturnType<typeof rebuildConsensusCenterFromCore>>['center']

export function summarizeConsensusCenter(center: RebuiltCenter | null, segments: readonly WindowSegment[], timeframe: string | null, supportCount: number, validatorCount: number) {
  if (!center) return null
  const byId = (id: number | null) => segments.find(segment => segment.id === id) || null
  const entry = byId(center.entry_segment_id)
  const start = byId(center.start_segment_id)
  const end = byId(center.end_segment_id)
  const departure = byId(center.departure_segment_id)
  const core = (center.segment_ids || []).slice(0, 3).map(byId)
  const coreStableIds = core.length === 3 && core.every(segment => segment?.stable_id)
    ? core.map(segment => segment!.stable_id)
    : null
  return {
    id:center.id,
    stable_id:`${start?.stable_id || 'unknown'}|${end?.stable_id || 'unknown'}`,
    core_stable_id:coreStableIds ? coreStableIds.join('|') : null,
    core_segment_stable_ids:coreStableIds,
    zl:round5(center.zl), zh:round5(center.zh),
    gg:round5(center.fluctuation_high), dd:round5(center.fluctuation_low),
    status:center.status,
    source_timeframe:timeframe || null,
    structure_level:'segment', level:timeframe || null, component_level:'segment',
    entry_segment_id:entry?.id ?? null,
    entry_segment_stable_id:entry?.stable_id ?? null,
    entry_segment_start_time_utc_msc:entry?.start_time_utc_msc ?? null,
    entry_segment_end_time_utc_msc:entry?.end_time_utc_msc ?? null,
    start_segment_id:start?.id ?? null,
    start_segment_stable_id:start?.stable_id ?? null,
    end_segment_id:end?.id ?? null,
    end_segment_stable_id:end?.stable_id ?? null,
    departure_segment_id:departure?.id ?? null,
    departure_segment_stable_id:departure?.stable_id ?? null,
    closed_by_segment_id:departure?.id ?? null,
    start_index:start?.start_index ?? null,
    end_index:end?.end_index ?? null,
    start_time:start?.start_time ?? null,
    end_time:end?.end_time ?? null,
    start_broker_time:start?.start_broker_time ?? start?.start_time ?? null,
    end_broker_time:end?.end_broker_time ?? end?.end_time ?? null,
    start_time_utc_msc:start?.start_time_utc_msc ?? null,
    end_time_utc_msc:end?.end_time_utc_msc ?? null,
    consensus_mode:'independent_center_quorum',
    cross_window_support_count:supportCount,
    cross_window_validator_count:validatorCount,
  }
}

export function confirmedCenterEvidence(candidate: WindowEvidence | null | undefined): readonly WindowCenter[] {
  if (Object.prototype.hasOwnProperty.call(candidate || {}, '_confirmed_centers')) {
    return Array.isArray(candidate?._confirmed_centers) ? candidate._confirmed_centers : []
  }
  return [candidate?.latest_center].filter((value): value is WindowCenter => Boolean(value))
}

export function centerCoreStableIds(center: WindowCenter | null | undefined, candidate: WindowEvidence | null = null): string[] {
  const explicit = Array.isArray(center?.core_segment_stable_ids)
    ? center.core_segment_stable_ids.filter((value): value is string => Boolean(value))
    : []
  if (explicit.length === 3) return explicit
  if (typeof center?.core_stable_id === 'string') {
    const values = center.core_stable_id.split('|').filter(Boolean)
    if (values.length === 3) return values
  }
  const startStableId = center?.start_segment_stable_id || null
  if (!startStableId || !candidate) return []
  const segments = confirmedSegmentEvidence(candidate)
  const startIndex = segments.findIndex(segment => segment?.stable_id === startStableId)
  if (startIndex < 0 || startIndex + 2 >= segments.length) return []
  const values = segments.slice(startIndex, startIndex + 3).map(segment => segment?.stable_id || null)
  return values.every(Boolean) ? values as string[] : []
}

export function stableCenterCoreKey(center: WindowCenter | null | undefined, candidate: WindowEvidence | null = null) {
  const coreStableIds = centerCoreStableIds(center, candidate)
  return coreStableIds.length === 3 ? JSON.stringify(coreStableIds) : null
}

export function rebuildConsensusCenterFromCore(coreStableIds: readonly string[], segments: readonly WindowSegment[]) {
  if (!Array.isArray(coreStableIds) || coreStableIds.length !== 3) return null
  const startIndex = segments.findIndex(segment => segment?.stable_id === coreStableIds[0])
  if (startIndex < 0 || startIndex + 2 >= segments.length) return null
  const initial = segments.slice(startIndex, startIndex + 3)
  if (!initial.every((segment, index) => segment?.stable_id === coreStableIds[index])) return null
  const range = (segment: WindowSegment | undefined): [number, number] | null => {
    const low = Number.isFinite(Number(segment?.low))
      ? Number(segment!.low) : Math.min(Number(segment?.start_price), Number(segment?.end_price))
    const high = Number.isFinite(Number(segment?.high))
      ? Number(segment!.high) : Math.max(Number(segment?.start_price), Number(segment?.end_price))
    return Number.isFinite(low) && Number.isFinite(high) && low <= high ? [low, high] : null
  }
  const initialRanges = initial.map(range)
  if (initialRanges.some(item => !item)) return null
  const zl = Math.max(...initialRanges.map(item => item![0]))
  const zh = Math.min(...initialRanges.map(item => item![1]))
  if (!(zl < zh)) return null
  let fluctuationLow = Math.min(...initialRanges.map(item => item![0]))
  let fluctuationHigh = Math.max(...initialRanges.map(item => item![1]))
  let endIndex = startIndex + 2
  let departureIndex = null
  for (let index = startIndex + 3; index < segments.length; index++) {
    const currentRange = range(segments[index])
    if (!currentRange) return null
    if (Math.max(zl, currentRange[0]) >= Math.min(zh, currentRange[1])) {
      departureIndex = index
      break
    }
    fluctuationLow = Math.min(fluctuationLow, currentRange[0])
    fluctuationHigh = Math.max(fluctuationHigh, currentRange[1])
    endIndex = index
  }
  const entry = segments[startIndex - 1] || null
  const departure = departureIndex == null ? null : segments[departureIndex]
  const centerSegments = segments.slice(startIndex, endIndex + 1)
  return {
    center:{
      id:null as number | null,
      component_level:'segment',
      component_ids:centerSegments.map(segment => segment.id),
      segment_ids:centerSegments.map(segment => segment.id),
      zl,
      zh,
      fluctuation_low:fluctuationLow,
      fluctuation_high:fluctuationHigh,
      start_segment_id:initial[0]!.id,
      end_segment_id:segments[endIndex]!.id,
      entry_segment_id:entry?.id ?? null,
      departure_segment_id:departure?.id ?? null,
      closed_by_segment_id:departure?.id ?? null,
      status:departure ? 'closed' : endIndex > startIndex + 2 ? 'extended' : 'confirmed',
    },
    startIndex,
    endIndex,
    departureIndex,
  }
}
