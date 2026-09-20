import type { ChanBi, ChanDirection, ChanFeature } from './types.js'

const MIN_BIS_PER_SEGMENT = 3

function rangesOverlap(a: ChanFeature, b: ChanFeature) {
  return Math.max(a.low, b.low) <= Math.min(a.high, b.high)
}

export function normalizeFeatureSequence(elements: readonly ChanFeature[]) {
  if (elements.length < 2) return elements.map(item => ({ ...item }))
  const merged = [{ ...elements[0]! }]
  let direction = 0
  for (let i = 1; i < elements.length; i++) {
    const prev = merged[merged.length - 1]!
    const cur = elements[i]!
    const included = (prev.high >= cur.high && prev.low <= cur.low) || (cur.high >= prev.high && cur.low <= prev.low)
    if (!included) {
      direction = cur.high > prev.high && cur.low > prev.low ? 1 : -1
      merged.push({ ...cur })
      continue
    }
    if (direction === 0) {
      for (let j = i + 1; j < elements.length; j++) {
        if (elements[j]!.high > prev.high && elements[j]!.low > prev.low) { direction = 1; break }
        if (elements[j]!.high < prev.high && elements[j]!.low < prev.low) { direction = -1; break }
      }
      if (direction === 0) direction = cur.end_price >= prev.end_price ? 1 : -1
    }
    if (direction > 0) {
      merged[merged.length - 1] = {
        ...prev,
        high: Math.max(prev.high, cur.high),
        low: Math.max(prev.low, cur.low),
        high_source_index: prev.high >= cur.high ? prev.high_source_index : cur.high_source_index,
        low_source_index: prev.low >= cur.low ? prev.low_source_index : cur.low_source_index,
        source_end_index: cur.source_end_index,
      }
    } else {
      merged[merged.length - 1] = {
        ...prev,
        high: Math.min(prev.high, cur.high),
        low: Math.min(prev.low, cur.low),
        high_source_index: prev.high <= cur.high ? prev.high_source_index : cur.high_source_index,
        low_source_index: prev.low <= cur.low ? prev.low_source_index : cur.low_source_index,
        source_end_index: cur.source_end_index,
      }
    }
  }
  return merged
}

export function findFeatureFractals(rawFeatures: readonly ChanFeature[], segmentDirection: ChanDirection) {
  const features = normalizeFeatureSequence(rawFeatures)
  const fractals = []
  for (let i = 1; i + 1 < features.length; i++) {
    const prev = features[i - 1]!
    const cur = features[i]!
    const next = features[i + 1]!
    const matched = segmentDirection === 'up'
      ? cur.high > prev.high && cur.high > next.high && cur.low > prev.low && cur.low > next.low
      : cur.low < prev.low && cur.low < next.low && cur.high < prev.high && cur.high < next.high
    if (matched) fractals.push({ prev, cur, next, features })
  }
  return fractals
}

// Evaluate each standard-sequence prefix as it becomes confirmable. Once a
// fractal confirms an endpoint, later elements belong to the next segment and
// must not be merged back across that boundary.
export function findFeatureFractalCandidates(rawFeatures: readonly ChanFeature[], segmentDirection: ChanDirection) {
  const candidates = []
  const seen = new Set()
  for (let length = 3; length <= rawFeatures.length; length++) {
    for (const fractal of findFeatureFractals(rawFeatures.slice(0, length), segmentDirection)) {
      const endpointIndex = segmentDirection === 'up' ? fractal.cur.high_source_index : fractal.cur.low_source_index
      const key = `${fractal.prev.source_start_index}:${endpointIndex}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(fractal)
    }
  }
  return candidates
}

function makeFeature(bi: ChanBi, index: number) {
  return {
    source_start_index: index,
    source_end_index: index,
    high_source_index: index,
    low_source_index: index,
    high: bi.high,
    low: bi.low,
    start_price: bi.start_price,
    end_price: bi.end_price,
  }
}

// In the gap case, the first feature fractal is only a candidate. The segment
// ends there after the new reverse segment's standard feature sequence forms
// its own opposite fractal. A new old-direction extreme invalidates it first.
export function evaluateGapEndpointConfirmation(bis: readonly ChanBi[], endpointIndex: number, oldDirection: ChanDirection) {
  const endpointBi = bis[endpointIndex]
  if (!endpointBi) return { confirmed:false, state:'endpoint_missing' }
  const reverseDirection = oldDirection === 'up' ? 'down' : 'up'
  const secondFeatures = []
  for (let i = endpointIndex + 1; i < bis.length; i += 2) {
    const bi = bis[i]
    if (!bi || bi.dir !== oldDirection) break
    if (oldDirection === 'up' && bi.high > endpointBi.high) {
      return { confirmed:false, state:'invalidated_by_old_direction_extreme', invalidated_by_bi_id:bi.id }
    }
    if (oldDirection === 'down' && bi.low < endpointBi.low) {
      return { confirmed:false, state:'invalidated_by_old_direction_extreme', invalidated_by_bi_id:bi.id }
    }
    secondFeatures.push(makeFeature(bi, i))
    if (findFeatureFractals(secondFeatures, reverseDirection).length > 0) {
      return { confirmed:true, state:'reverse_feature_fractal_confirmed', confirmed_by_bi_id:bi.id }
    }
  }
  return { confirmed:false, state:'awaiting_reverse_feature_fractal' }
}

export function confirmGapEndpoint(bis: readonly ChanBi[], endpointIndex: number, oldDirection: ChanDirection) {
  return evaluateGapEndpointConfirmation(bis, endpointIndex, oldDirection).confirmed
}

export function pendingSegmentConfirmation(bis: readonly ChanBi[], startIndex: number, segmentDirection: ChanDirection) {
  const featureDirection = segmentDirection === 'up' ? 'down' : 'up'
  const rawFeatures = []
  for (let i = startIndex + 1; i < bis.length; i += 2) {
    const bi = bis[i]
    if (!bi || bi.dir !== featureDirection) break
    rawFeatures.push(makeFeature(bi, i))
  }
  let invalidatedEndpointCount = 0
  for (const { prev, cur } of findFeatureFractalCandidates(rawFeatures, segmentDirection)) {
    const endpointIndex = segmentDirection === 'up' ? cur.high_source_index : cur.low_source_index
    const strokeCount = endpointIndex - startIndex
    if (strokeCount < MIN_BIS_PER_SEGMENT || strokeCount % 2 === 0) continue
    const hasGap = !rangesOverlap(prev, cur)
    if (!hasGap) continue
    const confirmation = evaluateGapEndpointConfirmation(bis, endpointIndex, segmentDirection)
    if (confirmation.confirmed) continue
    if (confirmation.state === 'invalidated_by_old_direction_extreme') {
      invalidatedEndpointCount++
      continue
    }
    const endpointFeatureBi = bis[endpointIndex]
    const endpointSegmentBi = bis[endpointIndex - 1]
    return {
      confirmation_state:'awaiting_reverse_feature_fractal',
      confirmation_required:'reverse_feature_fractal',
      pending_endpoint_feature_gap:true,
      pending_endpoint_feature_bi_id:endpointFeatureBi?.id ?? null,
      pending_endpoint_segment_bi_id:endpointSegmentBi?.id ?? null,
      pending_endpoint_price:segmentDirection === 'up'
        ? Number(endpointFeatureBi?.high) : Number(endpointFeatureBi?.low),
      pending_endpoint_raw_idx:Number.isFinite(Number(endpointFeatureBi?.raw_start_idx))
        ? Number(endpointFeatureBi!.raw_start_idx) : null,
      invalidated_endpoint_count:invalidatedEndpointCount,
    }
  }
  return {
    confirmation_state:'awaiting_first_feature_fractal',
    confirmation_required:'first_feature_fractal',
    pending_endpoint_feature_gap:null,
    pending_endpoint_feature_bi_id:null,
    pending_endpoint_segment_bi_id:null,
    pending_endpoint_price:null,
    pending_endpoint_raw_idx:null,
    invalidated_endpoint_count:invalidatedEndpointCount,
  }
}

export function findSegmentEndpoint(bis: readonly ChanBi[], startIndex: number, segmentDirection: ChanDirection) {
  const featureDirection = segmentDirection === 'up' ? 'down' : 'up'
  const rawFeatures = []
  for (let i = startIndex + 1; i < bis.length; i += 2) {
    const bi = bis[i]!
    if (bi.dir !== featureDirection) break
    rawFeatures.push(makeFeature(bi, i))
  }
  for (const { prev, cur, features } of findFeatureFractalCandidates(rawFeatures, segmentDirection)) {
    const endpointIndex = segmentDirection === 'up' ? cur.high_source_index : cur.low_source_index
    const strokeCount = endpointIndex - startIndex
    if (strokeCount < MIN_BIS_PER_SEGMENT || strokeCount % 2 === 0) continue
    const hasGap = !rangesOverlap(prev, cur)
    if (hasGap && !confirmGapEndpoint(bis, endpointIndex, segmentDirection)) continue
    return { endpointIndex, hasGap, feature_count: features.length }
  }
  return null
}
