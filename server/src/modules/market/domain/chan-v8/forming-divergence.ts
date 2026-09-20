import type { ChanBi, ChanRate, EvidenceSegment } from './types.js'
import type { Candidate } from './segments.js'
import type { Center } from './centers.js'
import { divergenceResult } from './divergence-result.js'
import { evaluateDivergence } from './divergence.js'
const MIN_BIS_PER_SEGMENT = 3

export function inspectSegmentCandidateLifecycle(candidate: Candidate | null, bis: readonly ChanBi[]) {
  if (!candidate || !Array.isArray(candidate.bi_ids) || candidate.bi_ids.length === 0) {
    return { candidateBis:[], invalidated:false, invalidatedByBiId:null, reason:null }
  }
  const candidateBis = candidate.bi_ids.map(id => bis.find(b => b.id === id)).filter((item): item is ChanBi => item !== undefined)
  const startPrice = Number(candidate.start_price)
  if (!Number.isFinite(startPrice)) {
    return { candidateBis, invalidated:true, invalidatedByBiId:null, reason:'candidate_start_price_invalid' }
  }
  const originCrossingBi = candidate.dir === 'down'
    ? candidateBis.find(bi => Number(bi.high) > startPrice)
    : candidate.dir === 'up'
      ? candidateBis.find(bi => Number(bi.low) < startPrice)
      : null
  // A normal unconfirmed segment can temporarily cross its origin while its
  // feature sequence is still forming. Retire it from *current* direction
  // only after a full two-sided feature sequence (at least 2*3+1 bis) has
  // accumulated without producing a new confirmed boundary. This preserves
  // strict historical segment construction while preventing a long-lived
  // candidate from masquerading as the latest market judgement.
  const invalidatingBi = candidateBis.length >= MIN_BIS_PER_SEGMENT * 2 + 1
    ? originCrossingBi : null
  return {
    candidateBis,
    invalidated:Boolean(invalidatingBi),
    invalidatedByBiId:invalidatingBi?.id ?? null,
    reason:invalidatingBi ? 'candidate_origin_broken_by_opposite_extreme' : null,
  }
}


export function buildFormingSegment(candidate: Candidate | null, bis: readonly ChanBi[], nextId: number) {
  if (!candidate || !Array.isArray(candidate.bi_ids) || candidate.bi_ids.length < MIN_BIS_PER_SEGMENT) return null
  const lifecycle = inspectSegmentCandidateLifecycle(candidate, bis)
  if (lifecycle.invalidated) return null
  const candidateBis = lifecycle.candidateBis
  if (candidateBis.length < MIN_BIS_PER_SEGMENT) return null
  return {
    ...candidate,
    id: nextId,
    high: Math.max(...candidateBis.map(b => b.high)),
    low: Math.min(...candidateBis.map(b => b.low)),
    raw_start_idx: Math.min(...candidateBis.map(b => b.raw_start_idx)),
    raw_end_idx: Math.max(...candidateBis.map(b => b.raw_end_idx)),
    weak: false,
  }
}


export function detectFormingDivergence(candidate: Candidate | null, segments: readonly EvidenceSegment[], bis: readonly ChanBi[], macdHist: readonly number[], centers: readonly Center[] = [], rates: readonly ChanRate[] = []) {
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  const formingSegment = buildFormingSegment(candidate, bis, (validSegs[validSegs.length - 1]?.id || 0) + 1)
  if (!formingSegment) return divergenceResult('no_forming_segment')
  const provisionalCenters = centers.map(center => {
    if (center.departure_segment_id != null || center.closed_by_segment_id != null) return center
    if (center.component_level !== 'segment' || Number(formingSegment.id) !== Number(center.end_segment_id) + 1) return center
    const leavesCenter = Number(formingSegment.low) >= Number(center.zh) || Number(formingSegment.high) <= Number(center.zl)
    return leavesCenter
      ? { ...center, departure_segment_id:formingSegment.id, closed_by_segment_id:formingSegment.id }
      : center
  })
  const result = evaluateDivergence(formingSegment, validSegs, bis, macdHist, provisionalCenters, rates, 'forming')
  return result.reason === 'not_after_center'
    ? divergenceResult('forming_departure_not_confirmed', { state:'forming' })
    : result
}
