import type { ChanBi, ChanSegment } from './types.js'
import { findSegmentEndpoint, pendingSegmentConfirmation } from './features.js'

const MIN_BIS_PER_SEGMENT = 3
type SegmentOptions = { trustedStart?: boolean }
export type Candidate = ReturnType<typeof pendingSegmentConfirmation> & { dir: 'up' | 'down'; bi_ids: number[]; start_price: number; end_price: number; endpoint_raw_idx: number | null }
type AnchorResult = { segments: ChanSegment[]; candidate: Candidate | null; resynced: boolean }
type Validator = AnchorResult & { probeStart: number }

export function buildSegmentsFromAnchor(confirmedBis: readonly ChanBi[], options: SegmentOptions = {}): AnchorResult {
  if (confirmedBis.length < MIN_BIS_PER_SEGMENT) return { segments: [], candidate: null, resynced: false }
  const trustedStart = options.trustedStart !== false
  const segments: ChanSegment[] = []
  let startIndex = 0
  let resynced = false
  let resyncEndpointCount = 0
  while (startIndex + MIN_BIS_PER_SEGMENT <= confirmedBis.length) {
    const dir = confirmedBis[startIndex]!.dir
    const endpoint = findSegmentEndpoint(confirmedBis, startIndex, dir)
    if (!endpoint) break
    if (!trustedStart && resyncEndpointCount < 2 && segments.length === 0) {
      // A rolling rates window normally starts in the middle of an older
      // segment. The first apparent endpoint can itself depend on the missing
      // prefix, so consume two complete endpoint transitions before emitting
      // confirmation-grade segments.
      startIndex = endpoint.endpointIndex
      resyncEndpointCount++
      resynced = resyncEndpointCount >= 2
      continue
    }
    const segBis = confirmedBis.slice(startIndex, endpoint.endpointIndex)
    const startPrice = segBis[0]!.start_price
    const endPrice = segBis[segBis.length - 1]!.end_price
    if ((dir === 'up' && endPrice <= startPrice) || (dir === 'down' && endPrice >= startPrice)) break
    segments.push({
      id: segments.length + 1,
      dir,
      raw_start_idx: Math.min(...segBis.map(b => b.raw_start_idx)),
      raw_end_idx: Math.max(...segBis.map(b => b.raw_end_idx)),
      start_price: startPrice,
      end_price: endPrice,
      high: Math.max(...segBis.map(b => b.high)),
      low: Math.min(...segBis.map(b => b.low)),
      bi_ids: segBis.map(b => b.id),
      start_bi_id: segBis[0]!.id,
      end_bi_id: segBis[segBis.length - 1]!.id,
      broken: true,
      ended_reason: 'broken',
      weak: false,
      confirmation: endpoint.hasGap ? 'gap_reverse_confirmed' : 'feature_fractal',
    })
    startIndex = endpoint.endpointIndex
  }

  const tailBis = confirmedBis.slice(startIndex)
  let candidate: Candidate | null = null
  if (tailBis.length > 0) {
    const dir = tailBis[0]!.dir
    const lifecycle = pendingSegmentConfirmation(confirmedBis, startIndex, dir)
    const directionalBis = tailBis
      .filter(b => b.dir === dir)
      .filter(b => Number.isFinite(Number(b.end_price)))
    const endpointBi = directionalBis.reduce<ChanBi | null>((best, bi) => {
      if (!best) return bi
      return dir === 'up'
        ? (Number(bi.end_price) > Number(best.end_price) ? bi : best)
        : (Number(bi.end_price) < Number(best.end_price) ? bi : best)
    }, null)
    const endPrice = Number(endpointBi?.end_price)
    candidate = {
      dir,
      bi_ids: tailBis.map(b => b.id),
      start_price: tailBis[0]!.start_price,
      end_price: endPrice,
      // The candidate may already contain a reverse stroke after its price
      // extreme. Keep the full stroke span for structure calculations, while
      // pairing the displayed endpoint price with the bar where it occurred.
      endpoint_raw_idx: Number.isFinite(Number(endpointBi?.raw_end_idx)) ? Number(endpointBi!.raw_end_idx) : null,
      ...lifecycle,
    }
  }

  return { segments, candidate, resynced }
}

function sameSegmentBoundary(a: ChanSegment | undefined, b: ChanSegment | undefined) {
  return Boolean(a && b && a.dir === b.dir && a.start_bi_id === b.start_bi_id && a.end_bi_id === b.end_bi_id)
}

function sameCandidate(a: Candidate | null, b: Candidate | null) {
  if (!a || !b || a.dir !== b.dir || a.start_price !== b.start_price || a.end_price !== b.end_price) return false
  return a.bi_ids.length === b.bi_ids.length && a.bi_ids.every((id, index) => id === b.bi_ids[index])
}

function validatorEndsWithSegmentChain(validator: AnchorResult, chain: readonly ChanSegment[]) {
  const candidateSegments = Array.isArray(validator?.segments) ? validator.segments : []
  const start = candidateSegments.length - chain.length
  return start >= 0 && chain.every((segment, index) => (
    sameSegmentBoundary(segment, candidateSegments[start + index])
  ))
}

export function buildSegments(confirmedBis: readonly ChanBi[], options: SegmentOptions = {}) {
  const primary = buildSegmentsFromAnchor(confirmedBis, options)
  if (options.trustedStart !== false) {
    return {
      ...primary,
      stable: true,
      supportCount: primary.segments.length >= 2 ? 1 : 0,
      validatorCount: primary.segments.length >= 2 ? 1 : 0,
      supportRatio: primary.segments.length >= 2 ? 1 : 0,
      pairSupport: primary.segments.slice(0, -1).map((segment, index) => ({
        previous_start_bi_id: segment.start_bi_id,
        previous_end_bi_id: segment.end_bi_id,
        current_start_bi_id: primary.segments[index + 1]!.start_bi_id,
        current_end_bi_id: primary.segments[index + 1]!.end_bi_id,
        support_count: 1,
      })),
      historicalSegmentRuns: primary.segments.length >= 2 ? [primary.segments] : [],
    }
  }

  // A rates window can begin in any phase of an older segment. Decompose from
  // every viable internal start, discard each truncated prefix via resync, and
  // vote only on the last two complete segment boundaries. This keeps the
  // anti-repaint guarantee without allowing one arbitrary start to veto every
  // otherwise identical terminal structure.
  const validators: Validator[] = []
  const latestStart = Math.max(0, confirmedBis.length - (MIN_BIS_PER_SEGMENT * 2 + 1))
  for (let start = 0; start <= latestStart; start++) {
    const result = start === 0
      ? primary
      : buildSegmentsFromAnchor(confirmedBis.slice(start), { trustedStart: false })
    if (result.resynced && result.segments.length >= 2) validators.push({ ...result, probeStart: start })
  }
  if (validators.length < 2) {
    return {
      segments: [], candidate: null, resynced: primary.resynced,
      stable: false, supportCount: validators.length, validatorCount: validators.length,
      supportRatio: validators.length === 1 ? 1 : 0,
      pairSupport: [],
      historicalSegmentRuns: [],
    }
  }

  const groups: Array<{ previous: ChanSegment | undefined; current: ChanSegment | undefined; validators: Validator[] }> = []
  for (const validator of validators) {
    const previous = validator.segments.at(-2)
    const current = validator.segments.at(-1)
    let group = groups.find(item => sameSegmentBoundary(item.previous, previous) && sameSegmentBoundary(item.current, current))
    if (!group) {
      group = { previous, current, validators: [] }
      groups.push(group)
    }
    group.validators.push(validator)
  }
  groups.sort((a, b) => (
    b.validators.length - a.validators.length
    || Math.max(...b.validators.map(item => item.segments.length)) - Math.max(...a.validators.map(item => item.segments.length))
    || Math.min(...a.validators.map(item => item.probeStart)) - Math.min(...b.validators.map(item => item.probeStart))
  ))
  const winner = groups[0]!
  const supportCount = winner?.validators.length || 0
  const validatorCount = validators.length
  const supportRatio = validatorCount > 0 ? supportCount / validatorCount : 0
  const hasMajority = supportCount >= 2 && supportCount * 2 > validatorCount
  if (!hasMajority) {
    return {
      segments: [], candidate: null, resynced: primary.resynced,
      stable: false, supportCount, validatorCount, supportRatio,
      pairSupport: [], historicalSegmentRuns: [],
    }
  }

  const representative = [...winner.validators].sort((a, b) => (
    b.segments.length - a.segments.length || a.probeStart - b.probeStart
  ))[0]!
  let confirmedChain: { segments: ChanSegment[]; supportCount: number; validatorCount: number; pairEvidence: Array<{ segment: ChanSegment; next: ChanSegment; supportCount: number; eligibleCount: number; supported: boolean }> } | null = null
  for (let start = 0; start <= representative.segments.length - 2; start++) {
    const chain = representative.segments.slice(start)
    // A validator whose first emitted segment starts after this chain cannot
    // observe it. Confirmation requires one coherent validator cohort to end
    // with the entire chain; separate pair majorities cannot be stitched into
    // a synthetic center.
    const eligibleValidators = validators.filter(result => (
      Number(result.segments[0]?.raw_start_idx) <= Number(chain[0]?.raw_start_idx)
      && Number(result.segments.at(-1)?.raw_end_idx) >= Number(chain.at(-1)?.raw_end_idx)
    ))
    const chainSupport = eligibleValidators.filter(result => validatorEndsWithSegmentChain(result, chain)).length
    const pairEvidence = chain.slice(0, -1).map((segment, index) => {
      const suffix = chain.slice(index)
      const next = suffix[1]!
      const pairEligible = validators.filter(result => (
        Number(result.segments[0]?.raw_start_idx) <= Number(segment.raw_start_idx)
        && Number(result.segments.at(-1)?.raw_end_idx) >= Number(next.raw_end_idx)
      ))
      const pairSupportCount = pairEligible.filter(result => validatorEndsWithSegmentChain(result, suffix)).length
      return {
        segment,
        next,
        supportCount:pairSupportCount,
        eligibleCount:pairEligible.length,
        supported:pairSupportCount >= 2 && pairSupportCount * 2 > pairEligible.length,
      }
    })
    const chainSupported = chainSupport >= 2 && chainSupport * 2 > eligibleValidators.length
    if (chainSupported && pairEvidence.every(item => item.supported)) {
      confirmedChain = {
        segments:chain,
        supportCount:chainSupport,
        validatorCount:eligibleValidators.length,
        pairEvidence,
      }
      break
    }
  }
  const segments = confirmedChain?.segments || []
  const pairSupport = (confirmedChain?.pairEvidence || []).map(item => ({
    previous_start_bi_id: item.segment.start_bi_id,
    previous_end_bi_id: item.segment.end_bi_id,
    current_start_bi_id: item.next.start_bi_id,
    current_end_bi_id: item.next.end_bi_id,
    support_count: item.supportCount,
    validator_count: item.eligibleCount,
  }))
  const historicalSegmentRuns = segments.length >= 2 ? [segments] : []
  const candidateGroups: Array<{ candidate: Candidate | null; count: number }> = []
  const derivedValidators = segments.length >= 2
    ? winner.validators.filter(item => item.candidate && validatorEndsWithSegmentChain(item, segments))
    : []
  for (const validator of derivedValidators) {
    let group = candidateGroups.find(item => sameCandidate(item.candidate, validator.candidate))
    if (!group) {
      group = { candidate: validator.candidate, count: 0 }
      candidateGroups.push(group)
    }
    group.count++
  }
  candidateGroups.sort((a, b) => b.count - a.count)
  const candidateWinner = candidateGroups[0]
  const candidate = candidateWinner && candidateWinner.count >= 2 && candidateWinner.count * 2 > derivedValidators.length
    ? candidateWinner.candidate
    : null
  return {
    segments,
    candidate,
    resynced: true,
    stable: segments.length >= 2,
    supportCount:confirmedChain?.supportCount || 0,
    validatorCount:confirmedChain?.validatorCount || 0,
    supportRatio:confirmedChain?.validatorCount
      ? confirmedChain.supportCount / confirmedChain.validatorCount : 0,
    pairSupport,
    historicalSegmentRuns,
  }
}
