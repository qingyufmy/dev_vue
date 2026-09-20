import type { ChanBi, ChanRate, EvidenceSegment } from './types.js'
import type { Candidate } from './segments.js'
import { segmentLocation } from './segment-location.js'
import { round5 } from './rounding.js'
import { inspectSegmentCandidateLifecycle } from './forming-divergence.js'
const MIN_BIS_PER_SEGMENT = 3
export type SummarySegmentInput = EvidenceSegment & Partial<Candidate>

export function summarizeSegment(segment: SummarySegmentInput | null | undefined, bis: readonly ChanBi[] = [], rates: readonly ChanRate[] = []) {
  if (!segment) return null
  const location = segmentLocation(segment, bis, rates)
  const lifecycle = segment.confirmation_state ? {
    confirmation_state:segment.confirmation_state,
    confirmation_required:segment.confirmation_required || null,
    pending_endpoint_feature_gap:segment.pending_endpoint_feature_gap ?? null,
    pending_endpoint_feature_bi_id:segment.pending_endpoint_feature_bi_id ?? null,
    pending_endpoint_segment_bi_id:segment.pending_endpoint_segment_bi_id ?? null,
    pending_endpoint_price:segment.pending_endpoint_price != null
      && Number.isFinite(Number(segment.pending_endpoint_price))
      ? round5(segment.pending_endpoint_price) : null,
    pending_endpoint_raw_idx:segment.pending_endpoint_raw_idx != null
      && Number.isFinite(Number(segment.pending_endpoint_raw_idx))
      ? Number(segment.pending_endpoint_raw_idx) : null,
    invalidated_endpoint_count:Number(segment.invalidated_endpoint_count || 0),
  } : {}
  return {
    id: segment.id,
    stable_id: location?.stable_id ?? null,
    dir: segment.dir,
    confirmed: !segment.confirmation_state,
    lifecycle_state: segment.confirmation_state ? 'forming_unconfirmed' : 'confirmed',
    endpoint_semantics: segment.confirmation_state ? 'directional_extreme' : 'confirmed_boundary',
    start_price: round5(segment.start_price),
    end_price: round5(segment.end_price),
    high: round5(segment.high),
    low: round5(segment.low),
    bi_count: segment.bi_ids.length,
    ended_reason: segment.ended_reason,
    broken: segment.broken,
    start_index: location?.start_index ?? null,
    end_index: location?.end_index ?? null,
    start_time: location?.start_time ?? null,
    end_time: location?.end_time ?? null,
    start_broker_time: location?.start_broker_time ?? null,
    end_broker_time: location?.end_broker_time ?? null,
    start_time_utc_msc: location?.start_time_utc_msc ?? null,
    end_time_utc_msc: location?.end_time_utc_msc ?? null,
    observation_end_index: location?.observation_end_index ?? null,
    observation_end_broker_time: location?.observation_end_broker_time ?? null,
    observation_end_time_utc_msc: location?.observation_end_time_utc_msc ?? null,
    last_included_bi_id: location?.last_included_bi_id ?? null,
    ...lifecycle,
  }
}


export function summarizeSegmentCandidate(candidate: Candidate | null, bis: readonly ChanBi[], rates: readonly ChanRate[], nextId: number) {
  if (!candidate || !Array.isArray(candidate.bi_ids) || candidate.bi_ids.length === 0) return null
  const lifecycle = inspectSegmentCandidateLifecycle(candidate, bis)
  const candidateBis = lifecycle.candidateBis
  if (candidateBis.length === 0) return null
  const observedCandidate = {
    ...candidate,
    id:nextId,
    high:Math.max(...candidateBis.map(b => b.high)),
    low:Math.min(...candidateBis.map(b => b.low)),
    raw_start_idx:Math.min(...candidateBis.map(b => b.raw_start_idx)),
    raw_end_idx:Math.max(...candidateBis.map(b => b.raw_end_idx)),
  }
  return {
    ...summarizeSegment(observedCandidate, bis, rates)!,
    confirmed:false,
    lifecycle_state:lifecycle.invalidated
      ? 'invalidated'
      : candidate.bi_ids.length >= MIN_BIS_PER_SEGMENT
        ? 'forming_unconfirmed' : 'early_forming_unconfirmed',
    active_for_current_state:!lifecycle.invalidated,
    invalidated_reason:lifecycle.reason,
    invalidated_by_bi_id:lifecycle.invalidatedByBiId,
    structure_role:lifecycle.invalidated ? 'historical_invalidated_candidate' : 'forming_candidate',
  }
}
