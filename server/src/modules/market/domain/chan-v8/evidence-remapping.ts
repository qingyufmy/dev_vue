import { DETERMINISTIC_NO_DIVERGENCE_REASONS, type DivergenceResult } from './divergence-result.js'
import type { EntryCandidate } from './entry-candidates.js'
import type { WindowCenter, WindowSegment, WindowEvidence } from './window-evidence.js'
import { stableCenterCoreKey } from './center-consensus-evidence.js'
import { round5 } from './rounding.js'
type SegmentReference = Omit<Partial<NonNullable<DivergenceResult['entry_segment']>>, 'id'> & { id: number | null }
export type DivergenceEvidence = Omit<DivergenceResult, 'entry_segment' | 'departure_segment'> & {
  entry_segment: SegmentReference | null; departure_segment: SegmentReference | null; reference_scope?: string
}
export type EntryEvidence = Omit<EntryCandidate, 'center'> & { center: WindowCenter | null }

export const CONCLUSIVE_FORMING_NONE_REASONS = new Set([
  ...DETERMINISTIC_NO_DIVERGENCE_REASONS, 'forming_departure_not_confirmed', 'no_forming_segment',
])

export function stableDivergenceEvidenceKey(divergence: DivergenceEvidence | null | undefined, forming = false) {
  const hasDirectionalEvidence = divergence?.type === 'top' || divergence?.type === 'bottom'
  if (!hasDirectionalEvidence) {
    const conclusiveReasons = forming ? CONCLUSIVE_FORMING_NONE_REASONS : DETERMINISTIC_NO_DIVERGENCE_REASONS
    return conclusiveReasons.has(String(divergence?.reason || '')) ? 'none' : null
  }
  if (!forming && divergence?.confirmed !== true) return null
  if (forming && divergence?.confirmed === true) return null
  const entry = divergence!.entry_segment?.stable_id
    || (divergence!.entry_segment_id == null ? null : `unlocated:${divergence!.entry_segment_id}`)
  const departure = divergence!.departure_segment?.stable_id
    || (divergence!.departure_segment_id == null ? null : `unlocated:${divergence!.departure_segment_id}`)
  if (!entry || !departure) return null
  return JSON.stringify({
    type:divergence!.type,
    entry,
    departure,
  })
}

export function stableFormingCandidateEvidenceKey(candidate: (WindowEvidence & { forming_divergence?: DivergenceEvidence | null }) | null | undefined) {
  const key = stableDivergenceEvidenceKey(candidate?.forming_divergence, true)
  if (!key || key === 'none') return key
  const center = centerStableIdentity(candidate?.latest_center)
  return center ? `${key}|center:${center}` : null
}

export function stableEntryEvidenceKey(item: Partial<EntryEvidence> = {}) {
  return JSON.stringify({
    key:item.candidate_key || `${item.type || 'unknown'}:${item.segment?.stable_id || item.segment_id || 'unknown'}`,
    type:item.type || null,
    side:item.side || null,
    source:item.source || null,
    segment:item.segment?.stable_id || (item.segment_id == null ? null : `unlocated:${item.segment_id}`),
    center:centerStableIdentity(item.center) || null,
    reference:Number.isFinite(Number(item.reference_price)) ? round5(Number(item.reference_price)) : null,
    invalidation:Number.isFinite(Number(item.invalidation_price)) ? round5(Number(item.invalidation_price)) : null,
    usable:item.usable_for_entry === true,
  })
}

export function centerStableIdentity(center: WindowCenter | null | undefined) {
  if (center?.core_stable_id) return center.core_stable_id
  if (Array.isArray(center?.core_segment_stable_ids) && center.core_segment_stable_ids.length === 3) {
    return center.core_segment_stable_ids.join('|')
  }
  if (center?.stable_id) return center.stable_id
  return center?.start_segment_stable_id && center?.end_segment_stable_id
    ? `${center.start_segment_stable_id}|${center.end_segment_stable_id}`
    : null
}

export function remapDivergenceToConsensus(divergence: DivergenceEvidence | null | undefined, segments: readonly WindowSegment[], centers: readonly WindowCenter[], fallbackCenter: WindowCenter | null = null) {
  if (!divergence || (divergence.type !== 'top' && divergence.type !== 'bottom')) return divergence || null
  const entryStableId = divergence.entry_segment?.stable_id || null
  const departureStableId = divergence.departure_segment?.stable_id || null
  if (!entryStableId || !departureStableId) return null
  const entrySegment = segments.find(segment => segment.stable_id === entryStableId) || null
  const departureSegment = segments.find(segment => segment.stable_id === departureStableId) || null
  const centerMatches = (center: WindowCenter | null) => center
    && center.entry_segment_stable_id === entryStableId
    && center.departure_segment_stable_id === departureStableId
  const center = centers.find(centerMatches) || (centerMatches(fallbackCenter) ? fallbackCenter : null)
  if (!entrySegment || !departureSegment || !center) return null
  return {
    ...divergence,
    center_id:center.id,
    entry_segment_id:entrySegment.id,
    departure_segment_id:departureSegment.id,
    entry_segment:entrySegment,
    departure_segment:departureSegment,
  }
}

export function remapFormingDivergenceToConsensus(divergence: DivergenceEvidence | null | undefined, sourceCenter: WindowCenter | null | undefined, sourceCandidate: WindowEvidence | null | undefined, segments: readonly WindowSegment[], consensusCenter: WindowCenter | null) {
  if (!divergence || (divergence.type !== 'top' && divergence.type !== 'bottom')) return divergence || null
  const sourceCenterIdentity = stableCenterCoreKey(sourceCenter, sourceCandidate ?? null)
  if (!consensusCenter || !sourceCenterIdentity
    || sourceCenterIdentity !== stableCenterCoreKey(consensusCenter)) return null
  const entryStableId = divergence.entry_segment?.stable_id || null
  const departureStableId = divergence.departure_segment?.stable_id || null
  if (!entryStableId || !departureStableId) return null
  if (!consensusCenter.entry_segment_stable_id
    || consensusCenter.entry_segment_stable_id !== entryStableId) return null
  const entrySegment = segments.find(segment => segment.stable_id === entryStableId) || null
  if (!entrySegment) return null
  return {
    ...divergence,
    confirmed:false,
    state:'forming',
    center_id:consensusCenter.id,
    entry_segment_id:entrySegment.id,
    departure_segment_id:null,
    entry_segment:entrySegment,
    departure_segment:{ ...divergence.departure_segment, id:null },
    reference_scope:'forming_stable_refs',
  }
}

export function preserveHistoricalDivergenceReferences(divergence: DivergenceEvidence | null | undefined, segments: readonly WindowSegment[], centers: readonly WindowCenter[]) {
  if (!divergence || (divergence.type !== 'top' && divergence.type !== 'bottom')) return null
  const entryStableId = divergence.entry_segment?.stable_id || null
  const departureStableId = divergence.departure_segment?.stable_id || null
  if (!entryStableId || !departureStableId) return null
  const entrySegment = segments.find(segment => segment.stable_id === entryStableId) || null
  const departureSegment = segments.find(segment => segment.stable_id === departureStableId) || null
  const center = centers.find(candidate => (
    candidate.entry_segment_stable_id === entryStableId
    && candidate.departure_segment_stable_id === departureStableId
  )) || null
  return {
    ...divergence,
    center_id:center?.id ?? null,
    entry_segment_id:entrySegment?.id ?? null,
    departure_segment_id:departureSegment?.id ?? null,
    entry_segment:entrySegment || { ...divergence.entry_segment, id:null },
    departure_segment:departureSegment || { ...divergence.departure_segment, id:null },
    reference_scope:entrySegment && departureSegment ? 'consensus_chain' : 'stable_history',
  }
}

export function remapEntryCandidateToConsensus(item: EntryEvidence, segments: readonly WindowSegment[], centers: readonly WindowCenter[]) {
  const segment = segments.find(candidate => candidate.stable_id === item?.segment?.stable_id) || null
  if (!segment) return null
  const centerIdentity = centerStableIdentity(item?.center)
  const center = centerIdentity
    ? centers.find(candidate => centerStableIdentity(candidate) === centerIdentity) || null
    : null
  if (item.center_id != null && !center) return null
  return {
    ...item,
    segment_id:segment.id,
    center_id:center?.id ?? null,
    segment,
    center,
  }
}
