import type { ChanBi, ChanRate, EvidenceSegment } from './types.js'
import type { Center } from './centers.js'
import type { DivergenceResult } from './divergence-result.js'
import { summarizeSegment } from './segment-summary.js'
import { summarizeCenter } from './center-summary.js'
import { round5 } from './rounding.js'
import { capStructureConfidence } from './trend.js'
const MIN_BIS_PER_SEGMENT = 3
const CHAN_ENTRY_MAX_AGE_BARS = 20
type Evidence = DivergenceResult & { bi_run_id?: number | string | null }
export interface EntryCandidate {
  type: string
  side: string
  state: string
  source: string
  candidate_key: string
  confidence: string
  usable_for_entry: boolean
  freshness: string
  bars_since_point: number | null
  max_age_bars: number
  segment_id: number | null
  center_id: number | null
  reference_price: number | null
  invalidation_price: number | null
  segment: ReturnType<typeof summarizeSegment>
  center: ReturnType<typeof summarizeCenter>
}

export function detectChanEntryCandidates(segments: readonly EvidenceSegment[], centers: readonly Center[], divergence: Evidence | null, recentDivergences: readonly Evidence[], bis: readonly ChanBi[], rates: readonly ChanRate[], reliability: string, structureTimeKeyReliable: boolean, activeBiRunId: number | string | null = null) {
  const validSegments = segments.filter(segment => !segment.weak && Array.isArray(segment.bi_ids) && segment.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  const latestSegment = validSegments.at(-1)
  if (!latestSegment) return []
  const locatedSegments = validSegments.map(segment => ({
    segment,
    location:summarizeSegment(segment, bis, rates),
  }))
  const segmentByStableId = new Map(locatedSegments
    .filter(item => item.location?.stable_id)
    .map(item => [item.location!.stable_id, item.segment]))
  const segmentIndexByStableId = new Map(locatedSegments
    .filter(item => item.location?.stable_id)
    .map((item, index) => [item.location!.stable_id, index]))
  const locatedCenters = centers.map(center => ({
    center,
    location:summarizeCenter(center, null, validSegments, bis, rates),
  }))
  const stableSegmentId = (evidence: { stable_id: string | null } | null | undefined) => evidence?.stable_id || null
  const resolveEvidenceSegment = (evidence: { stable_id: string | null } | null | undefined) => {
    const stableId = stableSegmentId(evidence)
    return stableId ? segmentByStableId.get(stableId) || null : null
  }
  const resolveEvidenceCenter = (evidence: Evidence | null | undefined) => {
    const entryStableId = stableSegmentId(evidence?.entry_segment)
    const departureStableId = stableSegmentId(evidence?.departure_segment)
    if (!entryStableId || !departureStableId) return null
    return locatedCenters.find(item => (
      item.location?.entry_segment_stable_id === entryStableId
      && item.location?.departure_segment_stable_id === departureStableId
    ))?.center || null
  }
  const structurallyUsable = reliability !== 'low' && structureTimeKeyReliable === true
  const confidence = (preferred: string) => capStructureConfidence(reliability, preferred)
  const results: EntryCandidate[] = []
  const add = ({ type, side, source, segment, center = null, referencePrice, invalidationPrice, preferredConfidence = 'medium' }: { type: string; side: string; source: string; segment: EvidenceSegment; center?: Center | null; referencePrice: number; invalidationPrice: number; preferredConfidence?: string }) => {
    const location = summarizeSegment(segment, bis, rates)
    const centerLocation = summarizeCenter(center, null, validSegments, bis, rates)
    const stablePart = location?.stable_id || `segment-${segment?.id ?? 'unknown'}`
    const pointEndIndex = Number(location?.end_index)
    const barsSincePoint = Number.isFinite(pointEndIndex) && rates.length > 0 ? Math.max(0, rates.length - 1 - pointEndIndex) : null
    const freshness = barsSincePoint == null ? 'unknown' : barsSincePoint <= CHAN_ENTRY_MAX_AGE_BARS ? 'fresh' : 'stale'
    results.push({
      type, side, state: 'confirmed_candidate', source,
      candidate_key: `${type}:${stablePart}`,
      confidence: confidence(preferredConfidence),
      usable_for_entry: structurallyUsable && freshness !== 'stale',
      freshness,
      bars_since_point: barsSincePoint,
      max_age_bars: CHAN_ENTRY_MAX_AGE_BARS,
      segment_id: segment?.id ?? null,
      center_id: center?.id ?? null,
      reference_price: Number.isFinite(Number(referencePrice)) ? round5(Number(referencePrice)) : null,
      invalidation_price: Number.isFinite(Number(invalidationPrice)) ? round5(Number(invalidationPrice)) : null,
      segment: location,
      center: centerLocation,
    })
  }

  if (divergence?.confirmed && divergence.type === 'bottom') {
    const segment = resolveEvidenceSegment(divergence.departure_segment)
    const center = resolveEvidenceCenter(divergence)
    if (segment && center) add({
      type: 'first_buy', side: 'buy', source: 'confirmed_bottom_divergence', segment,
      center, referencePrice: segment.end_price,
      invalidationPrice: divergence.price_extreme_cur, preferredConfidence: divergence.strength === 'strong' ? 'high' : 'medium',
    })
  } else if (divergence?.confirmed && divergence.type === 'top') {
    const segment = resolveEvidenceSegment(divergence.departure_segment)
    const center = resolveEvidenceCenter(divergence)
    if (segment && center) add({
      type: 'first_sell', side: 'sell', source: 'confirmed_top_divergence', segment,
      center, referencePrice: segment.end_price,
      invalidationPrice: divergence.price_extreme_cur, preferredConfidence: divergence.strength === 'strong' ? 'high' : 'medium',
    })
  }

  const priorDivergences = (Array.isArray(recentDivergences) ? recentDivergences : [])
    .filter(item => activeBiRunId == null
      ? item?.bi_run_id == null
      : String(item?.bi_run_id) === String(activeBiRunId))
  const lastBottom = [...priorDivergences].reverse().find(item => item.type === 'bottom' && item.confirmed)
  const lastTop = [...priorDivergences].reverse().find(item => item.type === 'top' && item.confirmed)
  const latestStableId = locatedSegments.at(-1)?.location?.stable_id || null
  const latestSegmentIndex = latestStableId ? segmentIndexByStableId.get(latestStableId) : null
  const bottomDepartureStableId = stableSegmentId(lastBottom?.departure_segment)
  const bottomDepartureIndex = bottomDepartureStableId ? segmentIndexByStableId.get(bottomDepartureStableId) : null
  const bottomCenter = resolveEvidenceCenter(lastBottom)
  const topDepartureStableId = stableSegmentId(lastTop?.departure_segment)
  const topDepartureIndex = topDepartureStableId ? segmentIndexByStableId.get(topDepartureStableId) : null
  const topCenter = resolveEvidenceCenter(lastTop)
  if (lastBottom && latestSegment.dir === 'down'
    && bottomCenter
    && Number.isInteger(bottomDepartureIndex) && Number.isInteger(latestSegmentIndex)
    && latestSegmentIndex! >= bottomDepartureIndex! + 2
    && latestSegment.low > Number(lastBottom.price_extreme_cur)) {
    add({
      type: 'second_buy', side: 'buy', source: 'higher_low_after_first_buy', segment: latestSegment,
      center: bottomCenter, referencePrice: latestSegment.end_price,
      invalidationPrice: lastBottom.price_extreme_cur,
    })
  }
  if (lastTop && latestSegment.dir === 'up'
    && topCenter
    && Number.isInteger(topDepartureIndex) && Number.isInteger(latestSegmentIndex)
    && latestSegmentIndex! >= topDepartureIndex! + 2
    && latestSegment.high < Number(lastTop.price_extreme_cur)) {
    add({
      type: 'second_sell', side: 'sell', source: 'lower_high_after_first_sell', segment: latestSegment,
      center: topCenter, referencePrice: latestSegment.end_price,
      invalidationPrice: lastTop.price_extreme_cur,
    })
  }

  const closedCenter = [...centers].reverse().find(center => center.status === 'closed' && center.closed_by_segment_id != null)
  if (closedCenter) {
    const breakoutSegment = validSegments.find(segment => segment.id === closedCenter.closed_by_segment_id)
    if (breakoutSegment?.dir === 'up' && latestSegment.id > breakoutSegment.id && latestSegment.dir === 'down' && latestSegment.low > closedCenter.zh) {
      add({
        type: 'third_buy', side: 'buy', source: 'pullback_holds_above_center', segment: latestSegment,
        center: closedCenter, referencePrice: latestSegment.end_price, invalidationPrice: closedCenter.zh,
      })
    }
    if (breakoutSegment?.dir === 'down' && latestSegment.id > breakoutSegment.id && latestSegment.dir === 'up' && latestSegment.high < closedCenter.zl) {
      add({
        type: 'third_sell', side: 'sell', source: 'rebound_holds_below_center', segment: latestSegment,
        center: closedCenter, referencePrice: latestSegment.end_price, invalidationPrice: closedCenter.zl,
      })
    }
  }

  return [...new Map(results.map(item => [item.candidate_key, item])).values()].slice(-6)
}
