import type { ChanBi, ChanRate, ChanDirection, EvidenceSegment } from './types.js'
import type { Center } from './centers.js'
import { segmentLocation } from './segment-location.js'
import { divergenceResult, type DivergenceResult } from './divergence-result.js'
import { calculateMacdSeries, roundMacdEvidence } from './macd.js'
import { round2, round3, round5 } from './rounding.js'
const ENABLE_DIVERGENCE = true
const MIN_BIS_PER_SEGMENT = 3
const MACD_WARMUP_BARS = 40
const DIVERGENCE_MIN_LINE_RATIO = 0.95
const DIVERGENCE_MIN_AREA_RATIO = 0.85
const DIVERGENCE_MIN_PEAK_RATIO = 0.95
const DIVERGENCE_ZERO_AXIS_TOLERANCE_RATIO = 0.25
const FEED_LAST_N_DIVERGENCES = 6
type MacdLines = { difSeries: number[]; deaSeries: number[] }

export function evaluateDivergence(current: EvidenceSegment | null | undefined, segments: readonly EvidenceSegment[], bis: readonly ChanBi[], macdHist: readonly number[], centers: readonly Center[] = [], rates: readonly ChanRate[] = [], state: 'confirmed' | 'forming' = 'confirmed', suppliedMacdSeries: MacdLines | null = null) {
  const emptyResult = (reason: string) => divergenceResult(reason, { state: state === 'forming' ? 'forming' : 'unavailable' })
  if (!ENABLE_DIVERGENCE || !macdHist || macdHist.length === 0) return emptyResult('no_macd_data')
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  if (!current || !Array.isArray(current.bi_ids) || current.bi_ids.length < MIN_BIS_PER_SEGMENT) return emptyResult('insufficient_valid_segments')
  if (validSegs.length < (state === 'forming' ? 1 : 2)) return emptyResult('insufficient_valid_segments')
  if (centers.length === 0) return emptyResult('no_valid_center')

  function calcMacdStats(biIds: readonly number[], dir: ChanDirection) {
    let area = 0
    let peak = 0
    const seenIndexes = new Set()
    for (const bid of biIds) {
      const bi = bis.find(b => b.id === bid)
      if (!bi) continue
      for (let j = bi.raw_start_idx; j <= bi.raw_end_idx && j < macdHist.length; j++) {
        if (seenIndexes.has(j)) continue
        seenIndexes.add(j)
        const v = macdHist[j] || 0
        if (dir === 'up' && v > 0) {
          area += v
          peak = Math.max(peak, v)
        } else if (dir === 'down' && v < 0) {
          const magnitude = Math.abs(v)
          area += magnitude
          peak = Math.max(peak, magnitude)
        }
      }
    }
    return { area, peak }
  }

  const derivedMacdSeries = suppliedMacdSeries && typeof suppliedMacdSeries === 'object'
    ? suppliedMacdSeries
    : rates.length > 0
      ? calculateMacdSeries(rates.map(rate => Number(rate?.close)))
      : null
  const difSeries = Array.isArray(derivedMacdSeries?.difSeries) ? derivedMacdSeries.difSeries : []
  const deaSeries = Array.isArray(derivedMacdSeries?.deaSeries) ? derivedMacdSeries.deaSeries : []

  function calcLineStats(biIds: readonly number[], dir: ChanDirection) {
    let difPeak = 0
    let deaPeak = 0
    const seenIndexes = new Set()
    for (const bid of biIds) {
      const bi = bis.find(b => b.id === bid)
      if (!bi) continue
      for (let j = bi.raw_start_idx; j <= bi.raw_end_idx; j++) {
        if (seenIndexes.has(j)) continue
        seenIndexes.add(j)
        const dif = Number(difSeries[j])
        const dea = Number(deaSeries[j])
        if (dir === 'up') {
          if (Number.isFinite(dif) && dif > 0) difPeak = Math.max(difPeak, dif)
          if (Number.isFinite(dea) && dea > 0) deaPeak = Math.max(deaPeak, dea)
        } else {
          if (Number.isFinite(dif) && dif < 0) difPeak = Math.max(difPeak, Math.abs(dif))
          if (Number.isFinite(dea) && dea < 0) deaPeak = Math.max(deaPeak, Math.abs(dea))
        }
      }
    }
    return { difPeak, deaPeak }
  }

  // Compare the center's explicit entry/departure references. Inferring these
  // as id +/- 1 fails after resync, discontinuities, and for the first center
  // in a retained window.
  const departureId = (center: Center) => center.departure_segment_id
    ?? center.closed_by_segment_id
    ?? (center.component_level ? null : (center.end_segment_id || 0) + 1)
  const eligibleCenters = centers.filter(c => current.id === departureId(c))
  if (eligibleCenters.length === 0) return emptyResult('not_after_center')
  const lastCenter = eligibleCenters[eligibleCenters.length - 1]!
  const centerIndex = centers.indexOf(lastCenter)
  const previousCenter = centerIndex > 0 ? centers[centerIndex - 1] : null
  const entrySegmentId = lastCenter.entry_segment_id
    ?? (lastCenter.component_level ? null : lastCenter.start_segment_id - 1)
  const prev = validSegs.find(s => s.id === entrySegmentId)
  if (!prev || prev.dir !== current.dir) return emptyResult('no_entry_segment')
  const cur = current
  const entryLocation = segmentLocation(prev, bis, rates)
  const departureLocation = segmentLocation(cur, bis, rates)
  const context: Partial<DivergenceResult> = {
    state,
    confirmed: false,
    segment_confirmed: state === 'confirmed',
    category: 'center_departure',
    center_id: lastCenter.id ?? null,
    entry_segment_id: prev.id ?? null,
    departure_segment_id: cur.id ?? null,
    entry_segment: entryLocation,
    departure_segment: departureLocation,
  }

  const structureClass = previousCenter && (
    (cur.dir === 'up' && Number(lastCenter.zl) > Number(previousCenter.zh))
    || (cur.dir === 'down' && Number(lastCenter.zh) < Number(previousCenter.zl))
  ) ? 'trend' : 'consolidation'
  context.structure_class = structureClass

  const comparisonBis = [...prev.bi_ids, ...cur.bi_ids]
    .map(id => bis.find(b => b.id === id))
    .filter((item): item is ChanBi => item !== undefined)
  if (comparisonBis.some(b => Number(b.raw_start_idx) < MACD_WARMUP_BARS)) {
    return divergenceResult('macd_warmup_overlap', context)
  }

  const prevMacd = calcMacdStats(prev.bi_ids, cur.dir)
  const curMacd = calcMacdStats(cur.bi_ids, cur.dir)
  const prevLines = calcLineStats(prev.bi_ids, cur.dir)
  const curLines = calcLineStats(cur.bi_ids, cur.dir)
  const areaPrev = prevMacd.area
  const areaCur = curMacd.area
  const peakPrev = prevMacd.peak
  const peakCur = curMacd.peak
  const difRatio = prevLines.difPeak > 0 ? curLines.difPeak / prevLines.difPeak : null
  const deaRatio = prevLines.deaPeak > 0 ? curLines.deaPeak / prevLines.deaPeak : null
  const difDeaDiverged = difRatio != null && deaRatio != null
    && difRatio <= DIVERGENCE_MIN_LINE_RATIO && deaRatio <= DIVERGENCE_MIN_LINE_RATIO

  const centerSegments = validSegs.filter(segment => Number(segment.id) >= Number(lastCenter.start_segment_id)
    && Number(segment.id) <= Number(lastCenter.end_segment_id))
  const centerIndexes = centerSegments.flatMap(segment => segment.bi_ids || [])
    .map(id => bis.find(bi => bi.id === id)).filter((item): item is ChanBi => item !== undefined)
    .flatMap(bi => {
      const result = []
      for (let index = Number(bi.raw_start_idx); index <= Number(bi.raw_end_idx); index++) result.push(index)
      return result
    })
  const centerDif = centerIndexes.map(index => Number(difSeries[index])).filter(Number.isFinite)
  const centerDea = centerIndexes.map(index => Number(deaSeries[index])).filter(Number.isFinite)
  const comparisonLinePeak = Math.max(prevLines.difPeak, prevLines.deaPeak, curLines.difPeak, curLines.deaPeak)
  const zeroAxisTolerance = comparisonLinePeak > 0
    ? comparisonLinePeak * DIVERGENCE_ZERO_AXIS_TOLERANCE_RATIO : null
  const centerDifMinAbs = centerDif.length ? Math.min(...centerDif.map(Math.abs)) : null
  const centerDeaMinAbs = centerDea.length ? Math.min(...centerDea.map(Math.abs)) : null
  const crossedZero = (values: readonly number[]) => values.some((value, index) => index > 0 && (
    (value >= 0 && values[index - 1]! <= 0) || (value <= 0 && values[index - 1]! >= 0)))
  const zeroAxisReset = zeroAxisTolerance != null && centerDifMinAbs != null && centerDeaMinAbs != null
    && ((centerDifMinAbs <= zeroAxisTolerance && centerDeaMinAbs <= zeroAxisTolerance)
      || (crossedZero(centerDif) && crossedZero(centerDea)))

  if (areaCur === 0 || areaPrev === 0) return divergenceResult('invalid_macd_area', {
    ...context,
    area_cur:roundMacdEvidence(areaCur), area_prev:roundMacdEvidence(areaPrev),
    peak_cur:roundMacdEvidence(peakCur), peak_prev:roundMacdEvidence(peakPrev),
  })

  const areaRatio = areaPrev > 0 ? areaCur / areaPrev : null
  const peakRatio = peakPrev > 0 ? peakCur / peakPrev : null
  const areaDiverged = areaRatio != null && areaRatio <= DIVERGENCE_MIN_AREA_RATIO
  const heightDiverged = peakRatio != null && peakRatio <= DIVERGENCE_MIN_PEAK_RATIO
  const strength = areaDiverged && heightDiverged ? 'strong' : 'weak'
  const reason = areaDiverged && heightDiverged
    ? 'macd_area_and_height_divergence'
    : areaDiverged
      ? 'macd_area_divergence_only'
      : heightDiverged
        ? 'macd_height_divergence_only'
        : 'macd_no_divergence'
  const macdFields = {
    area_cur:roundMacdEvidence(areaCur), area_prev:roundMacdEvidence(areaPrev),
    peak_cur:roundMacdEvidence(peakCur), peak_prev:roundMacdEvidence(peakPrev),
    area_ratio: areaRatio == null ? null : round3(areaRatio),
    peak_ratio: peakRatio == null ? null : round3(peakRatio),
    area_reduction_pct: areaRatio == null ? null : round2((1 - areaRatio) * 100),
    peak_reduction_pct: peakRatio == null ? null : round2((1 - peakRatio) * 100),
    dif_peak_cur:roundMacdEvidence(curLines.difPeak), dif_peak_prev:roundMacdEvidence(prevLines.difPeak),
    dea_peak_cur:roundMacdEvidence(curLines.deaPeak), dea_peak_prev:roundMacdEvidence(prevLines.deaPeak),
    dif_ratio:difRatio == null ? null : round3(difRatio),
    dea_ratio:deaRatio == null ? null : round3(deaRatio),
    zero_axis_reset:zeroAxisReset,
    zero_axis_tolerance:zeroAxisTolerance == null ? null : roundMacdEvidence(zeroAxisTolerance),
    center_dif_min_abs:centerDifMinAbs == null ? null : roundMacdEvidence(centerDifMinAbs),
    center_dea_min_abs:centerDeaMinAbs == null ? null : roundMacdEvidence(centerDeaMinAbs),
  }
  const divergenceKey = (type: string) => departureLocation?.stable_id ? `${type}:${departureLocation.stable_id}` : null
  const divergenceClassification = () => {
    if (structureClass === 'trend' && areaDiverged && heightDiverged && difDeaDiverged && zeroAxisReset) {
      return 'trend_divergence_confirmed'
    }
    if (structureClass === 'consolidation' && areaDiverged && heightDiverged) {
      return 'consolidation_divergence_confirmed'
    }
    return 'segment_momentum_divergence'
  }

  if (cur.dir === 'up') {
    if (cur.high <= prev.high) return divergenceResult('no_price_extreme_break', { ...context, ...macdFields, price_extreme_cur: round5(cur.high), price_extreme_prev: round5(prev.high) })
    if (areaDiverged || heightDiverged) {
      const divergenceClass = divergenceClassification()
      const trendConfirmed = state === 'confirmed' && divergenceClass === 'trend_divergence_confirmed'
      return divergenceResult(reason, { ...context, type: 'top', divergence_key: divergenceKey('top'), confirmed: state === 'confirmed', divergence_class:divergenceClass, trend_confirmed:trendConfirmed, qualified_for_reversal_watch:trendConfirmed, strength, ...macdFields, price_extreme_cur: round5(cur.high), price_extreme_prev: round5(prev.high) })
    }
    return divergenceResult(reason, { ...context, ...macdFields, price_extreme_cur: round5(cur.high), price_extreme_prev: round5(prev.high) })
  } else {
    if (cur.low >= prev.low) return divergenceResult('no_price_extreme_break', { ...context, ...macdFields, price_extreme_cur: round5(cur.low), price_extreme_prev: round5(prev.low) })
    if (areaDiverged || heightDiverged) {
      const divergenceClass = divergenceClassification()
      const trendConfirmed = state === 'confirmed' && divergenceClass === 'trend_divergence_confirmed'
      return divergenceResult(reason, { ...context, type: 'bottom', divergence_key: divergenceKey('bottom'), confirmed: state === 'confirmed', divergence_class:divergenceClass, trend_confirmed:trendConfirmed, qualified_for_reversal_watch:trendConfirmed, strength, ...macdFields, price_extreme_cur: round5(cur.low), price_extreme_prev: round5(prev.low) })
    }
    return divergenceResult(reason, { ...context, ...macdFields, price_extreme_cur: round5(cur.low), price_extreme_prev: round5(prev.low) })
  }
}

export function detectDivergence(segments: readonly EvidenceSegment[], bis: readonly ChanBi[], macdHist: readonly number[], centers: readonly Center[] = [], rates: readonly ChanRate[] = [], macdSeries: MacdLines | null = null) {
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  return evaluateDivergence(validSegs[validSegs.length - 1], validSegs, bis, macdHist, centers, rates, 'confirmed', macdSeries)
}

export function detectDivergenceHistory(segments: readonly EvidenceSegment[], bis: readonly ChanBi[], macdHist: readonly number[], centers: readonly Center[] = [], rates: readonly ChanRate[] = []) {
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  return validSegs
    .map(segment => evaluateDivergence(segment, validSegs, bis, macdHist, centers, rates, 'confirmed'))
    .filter(result => result.type === 'top' || result.type === 'bottom')
    .slice(-FEED_LAST_N_DIVERGENCES)
}
