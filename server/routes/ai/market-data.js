// ai/market-data.js — 行情计算 + 桥接封装

import { beijingNow } from '../../db.js'
import { sendBridgeCommand } from '../../bridge-ws.js'
import { round2, round3, round5, clamp, compactRates } from './utils.js'

export function computeAtr14(rates) {
  if (!Array.isArray(rates) || rates.length < 2) return 0
  const highs = rates.map(r => r.high || r[2] || 0)
  const lows = rates.map(r => r.low || r[3] || 0)
  const closes = rates.map(r => r.close || r[4] || 0)
  const trueRanges = []
  for (let i = 1; i < rates.length; i++) {
    trueRanges.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])))
  }
  const atrWindow = trueRanges.length >= 14 ? trueRanges.slice(-14) : trueRanges
  return atrWindow.length > 0 ? atrWindow.reduce((a, b) => a + b, 0) / atrWindow.length : 0
}

const _bridgeLocks = new Map()

// === Chan Theory Constants ===
const MIN_BARS_PER_BI = 5
const MIN_BIS_PER_SEGMENT = 3
const FEED_LAST_N_BIS = 6
const FEED_LAST_N_DIVERGENCES = 6
const ENABLE_DIVERGENCE = true
const MIN_KLINES_FOR_CHAN = 30
const DIVERGENCE_MIN_AREA_RATIO = 0.85
const DIVERGENCE_MIN_PEAK_RATIO = 0.95
const MACD_WARMUP_BARS = 40
const CHAN_ENTRY_MAX_AGE_BARS = 20
const DEBUG_CHAN = process.env.DEBUG_CHAN === '1'

// === MACD Series Calculation ===
function calculateMacdSeries(closes) {
  const n = closes.length
  const ema12 = new Array(n).fill(0)
  const ema26 = new Array(n).fill(0)
  const dif = new Array(n).fill(0)
  const dea = new Array(n).fill(0)
  const hist = new Array(n).fill(0)
  if (n === 0) return { difSeries: dif, deaSeries: dea, histSeries: hist, latestDif: 0, latestDea: 0, latestHist: 0 }

  const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10
  ema12[0] = closes[0]
  ema26[0] = closes[0]
  dif[0] = 0
  dea[0] = 0
  hist[0] = 0

  for (let i = 1; i < n; i++) {
    ema12[i] = closes[i] * k12 + ema12[i - 1] * (1 - k12)
    ema26[i] = closes[i] * k26 + ema26[i - 1] * (1 - k26)
    dif[i] = ema12[i] - ema26[i]
    dea[i] = dif[i] * k9 + dea[i - 1] * (1 - k9)
    hist[i] = dif[i] - dea[i]
  }
  return { difSeries: dif, deaSeries: dea, histSeries: hist, latestDif: dif[n - 1], latestDea: dea[n - 1], latestHist: hist[n - 1] }
}

// === Chan Theory: Normalize bars (inclusion processing) ===
function normalizeBarsForChan(rates) {
  const bars = []
  for (let i = 0; i < rates.length; i++) {
    const h = parseFloat(rates[i].high)
    const l = parseFloat(rates[i].low)
    const o = parseFloat(rates[i].open)
    const c = parseFloat(rates[i].close)
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(o) || !Number.isFinite(c)) continue
    if (h < l) continue
    bars.push({ idx: bars.length, raw_idx: i, raw_start_idx: i, raw_end_idx: i, high: h, low: l, open: o, close: c, time: rates[i].time })
  }
  if (bars.length < 3) return bars.map((bar, idx) => ({ ...bar, idx }))

  const merged = [bars[0]]
  let direction = 0
  function inferInitialDirection(reference, fromIndex) {
    for (let j = fromIndex; j < bars.length; j++) {
      const probe = bars[j]
      if (probe.high > reference.high && probe.low > reference.low) return 1
      if (probe.high < reference.high && probe.low < reference.low) return -1
    }
    const last = bars[bars.length - 1]
    return last.close >= reference.close ? 1 : -1
  }
  for (let i = 1; i < bars.length; i++) {
    const prev = merged[merged.length - 1]
    const cur = bars[i]
    const prevContainsCur = prev.high >= cur.high && prev.low <= cur.low
    const curContainsPrev = cur.high >= prev.high && cur.low <= prev.low
    if (prevContainsCur || curContainsPrev) {
      if (direction === 0) {
        direction = inferInitialDirection(prev, i + 1)
      }
      if (direction > 0) {
        merged[merged.length - 1] = { ...prev, high: Math.max(prev.high, cur.high), low: Math.max(prev.low, cur.low), raw_end_idx: cur.raw_end_idx }
      } else {
        merged[merged.length - 1] = { ...prev, high: Math.min(prev.high, cur.high), low: Math.min(prev.low, cur.low), raw_end_idx: cur.raw_end_idx }
      }
    } else {
      direction = cur.high > prev.high ? 1 : -1
      merged.push({ ...cur })
    }
  }
  // Renumber idx after inclusion processing
  return merged.map((bar, idx) => ({ ...bar, idx, raw_start_idx: bar.raw_start_idx ?? bar.raw_idx, raw_end_idx: bar.raw_end_idx ?? bar.raw_idx }))
}

// === Chan Theory: Fractal Detection (strict) ===
function detectFractals(bars) {
  if (bars.length < 3) return []
  const fractals = []
  for (let i = 1; i < bars.length - 1; i++) {
    const p = bars[i - 1], c = bars[i], n = bars[i + 1]
    if (c.high > p.high && c.high > n.high && c.low > p.low && c.low > n.low) {
      fractals.push({ idx: c.idx, raw_start_idx: c.raw_start_idx, raw_end_idx: c.raw_end_idx, type: 'top', price: c.high, high: c.high, low: c.low, time: c.time })
    } else if (c.low < p.low && c.low < n.low && c.high < p.high && c.high < n.high) {
      fractals.push({ idx: c.idx, raw_start_idx: c.raw_start_idx, raw_end_idx: c.raw_end_idx, type: 'bottom', price: c.low, high: c.high, low: c.low, time: c.time })
    }
  }
  // Ensure alternating and deduplicate same-type
  const cleaned = []
  for (const f of fractals) {
    if (cleaned.length === 0) { cleaned.push(f); continue }
    const last = cleaned[cleaned.length - 1]
    if (f.type === last.type) {
      if ((f.type === 'top' && f.price > last.price) || (f.type === 'bottom' && f.price < last.price)) {
        cleaned[cleaned.length - 1] = f
      }
    } else {
      cleaned.push(f)
    }
  }
  return cleaned
}

// === Chan Theory: Bi (Stroke) Construction ===
function buildBis(fractals, bars) {
  const pivots = []
  for (const f of fractals) {
    if (pivots.length === 0) { pivots.push(f); continue }
    const last = pivots[pivots.length - 1]
    if (f.type === last.type) {
      if ((f.type === 'top' && f.price > last.price) || (f.type === 'bottom' && f.price < last.price)) {
        pivots[pivots.length - 1] = f
      }
    } else {
      if (f.idx - last.idx >= MIN_BARS_PER_BI - 1) {
        pivots.push(f)
      }
    }
  }
  const bis = []
  let invalidCount = 0
  let anchor = pivots[0]
  for (let i = 1; i < pivots.length; i++) {
    const s = anchor, e = pivots[i]
    const dir = s.type === 'bottom' ? 'up' : 'down'
    if ((dir === 'up' && e.price <= s.price) || (dir === 'down' && e.price >= s.price)) {
      invalidCount++
      // The price topology is discontinuous. Restart from the newer pivot so
      // confirmed bis before and after the break cannot enter one structure.
      bis.length = 0
      anchor = e
      continue
    }
    bis.push({
      id: bis.length + 1, dir,
      start_idx: s.idx, end_idx: e.idx,
      raw_start_idx: Math.min(s.raw_start_idx ?? s.raw_idx, e.raw_start_idx ?? e.raw_idx),
      raw_end_idx: Math.max(s.raw_end_idx ?? s.raw_idx, e.raw_end_idx ?? e.raw_idx),
      start_price: s.price, end_price: e.price,
      high: Math.max(s.high, e.high), low: Math.min(s.low, e.low),
      confirmed: true,
    })
    anchor = e
  }
  if (DEBUG_CHAN) console.log(`[Chan] Bis(${bis.length}, invalid=${invalidCount}): ${bis.map(b => `${b.id}${b.dir[0]} ${b.start_price}→${b.end_price}${b.confirmed ? '' : '*'}`).join(' | ')}`)
  return { bis, invalidCount, activePivot: anchor || null }
}

function buildDevelopingBi(activePivot, rates) {
  if (!activePivot || !Array.isArray(rates) || rates.length === 0) return null
  const pivotRawEnd = Number(activePivot.raw_end_idx ?? activePivot.raw_idx)
  const afterPivotIndex = Number.isFinite(pivotRawEnd) ? pivotRawEnd + 1 : rates.length - 1
  const developingRates = rates.slice(Math.max(afterPivotIndex, 0))
  if (activePivot.type === 'bottom') {
    const highs = developingRates.map(rate => Number(rate.high)).filter(Number.isFinite)
    const developingHigh = highs.length > 0 ? Math.max(...highs) : NaN
    return Number.isFinite(developingHigh) && developingHigh > activePivot.price
      ? { dir: 'up', start_price: round5(activePivot.price), end_price: round5(developingHigh), confirmed: false }
      : null
  }
  if (activePivot.type === 'top') {
    const lows = developingRates.map(rate => Number(rate.low)).filter(Number.isFinite)
    const developingLow = lows.length > 0 ? Math.min(...lows) : NaN
    return Number.isFinite(developingLow) && developingLow < activePivot.price
      ? { dir: 'down', start_price: round5(activePivot.price), end_price: round5(developingLow), confirmed: false }
      : null
  }
  return null
}

function rangesOverlap(a, b) {
  return Math.max(a.low, b.low) <= Math.min(a.high, b.high)
}

function normalizeFeatureSequence(elements) {
  if (elements.length < 2) return elements.map(item => ({ ...item }))
  const merged = [{ ...elements[0] }]
  let direction = 0
  for (let i = 1; i < elements.length; i++) {
    const prev = merged[merged.length - 1]
    const cur = elements[i]
    const included = (prev.high >= cur.high && prev.low <= cur.low) || (cur.high >= prev.high && cur.low <= prev.low)
    if (!included) {
      direction = cur.high > prev.high && cur.low > prev.low ? 1 : -1
      merged.push({ ...cur })
      continue
    }
    if (direction === 0) {
      for (let j = i + 1; j < elements.length; j++) {
        if (elements[j].high > prev.high && elements[j].low > prev.low) { direction = 1; break }
        if (elements[j].high < prev.high && elements[j].low < prev.low) { direction = -1; break }
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

function findFeatureFractals(rawFeatures, segmentDirection) {
  const features = normalizeFeatureSequence(rawFeatures)
  const fractals = []
  for (let i = 1; i + 1 < features.length; i++) {
    const prev = features[i - 1]
    const cur = features[i]
    const next = features[i + 1]
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
function findFeatureFractalCandidates(rawFeatures, segmentDirection) {
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

function makeFeature(bi, index) {
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
function confirmGapEndpoint(bis, endpointIndex, oldDirection) {
  const endpointBi = bis[endpointIndex]
  if (!endpointBi) return false
  const reverseDirection = oldDirection === 'up' ? 'down' : 'up'
  const secondFeatures = []
  for (let i = endpointIndex + 1; i < bis.length; i += 2) {
    const bi = bis[i]
    if (!bi || bi.dir !== oldDirection) break
    if (oldDirection === 'up' && bi.high > endpointBi.high) return false
    if (oldDirection === 'down' && bi.low < endpointBi.low) return false
    secondFeatures.push(makeFeature(bi, i))
    if (findFeatureFractals(secondFeatures, reverseDirection).length > 0) return true
  }
  return false
}

function findSegmentEndpoint(bis, startIndex, segmentDirection) {
  const featureDirection = segmentDirection === 'up' ? 'down' : 'up'
  const rawFeatures = []
  for (let i = startIndex + 1; i < bis.length; i += 2) {
    const bi = bis[i]
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

// === Chan Theory: Segment Construction from characteristic sequences ===
function buildSegmentsFromAnchor(confirmedBis, options = {}) {
  if (confirmedBis.length < MIN_BIS_PER_SEGMENT) return { segments: [], candidate: null, resynced: false }
  const trustedStart = options.trustedStart !== false
  const segments = []
  let startIndex = 0
  let resynced = false
  while (startIndex + MIN_BIS_PER_SEGMENT <= confirmedBis.length) {
    const dir = confirmedBis[startIndex].dir
    const endpoint = findSegmentEndpoint(confirmedBis, startIndex, dir)
    if (!endpoint) break
    if (!trustedStart && !resynced && segments.length === 0) {
      // A rolling rates window normally starts in the middle of an older
      // segment. Use its first detectable endpoint only as the structure
      // anchor; emitting the truncated prefix would repaint history.
      startIndex = endpoint.endpointIndex
      resynced = true
      continue
    }
    const segBis = confirmedBis.slice(startIndex, endpoint.endpointIndex)
    const startPrice = segBis[0].start_price
    const endPrice = segBis[segBis.length - 1].end_price
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
      start_bi_id: segBis[0].id,
      end_bi_id: segBis[segBis.length - 1].id,
      broken: true,
      ended_reason: 'broken',
      weak: false,
      confirmation: endpoint.hasGap ? 'gap_reverse_confirmed' : 'feature_fractal',
    })
    startIndex = endpoint.endpointIndex
  }

  const tailBis = confirmedBis.slice(startIndex)
  let candidate = null
  if (tailBis.length > 0) {
    const dir = tailBis[0].dir
    const directionalEnds = tailBis
      .filter(b => b.dir === dir)
      .map(b => Number(b.end_price))
      .filter(Number.isFinite)
    const endPrice = dir === 'up' ? Math.max(...directionalEnds) : Math.min(...directionalEnds)
    candidate = {
      dir,
      bi_ids: tailBis.map(b => b.id),
      start_price: tailBis[0].start_price,
      end_price: endPrice,
    }
  }

  if (DEBUG_CHAN) console.log(`[Chan] Segments(${segments.length}): ${segments.map(s => `#${s.id}(${s.dir}) bis=${s.bi_ids.length}`).join(' | ')}`)
  return { segments, candidate, resynced }
}

function sameSegmentBoundary(a, b) {
  return Boolean(a && b && a.dir === b.dir && a.start_bi_id === b.start_bi_id && a.end_bi_id === b.end_bi_id)
}

function sameCandidate(a, b) {
  if (!a || !b || a.dir !== b.dir || a.start_price !== b.start_price || a.end_price !== b.end_price) return false
  return a.bi_ids.length === b.bi_ids.length && a.bi_ids.every((id, index) => id === b.bi_ids[index])
}

function buildSegments(confirmedBis, options = {}) {
  const primary = buildSegmentsFromAnchor(confirmedBis, options)
  if (options.trustedStart !== false) return { ...primary, stable: true, historicalSegmentRuns: primary.segments.length >= 2 ? [primary.segments] : [] }
  if (!primary.resynced) return { ...primary, candidate: null, stable: false, historicalSegmentRuns: [] }

  const firstStructureBiId = primary.segments[0]?.start_bi_id ?? primary.candidate?.bi_ids?.[0]
  const firstStructureIndex = confirmedBis.findIndex(bi => bi.id === firstStructureBiId)
  const latestProbeStart = firstStructureIndex - MIN_BIS_PER_SEGMENT
  if (latestProbeStart < 1) return { segments: [], candidate: null, resynced: true, stable: false, historicalSegmentRuns: [] }

  // Validate the claimed terminal structure from every alternate start that
  // still leaves room to resync before that structure begins. Two arbitrary
  // truncated windows can agree on the same false internal endpoint; requiring
  // consensus across all eligible starts exposes that ambiguity.
  const decompositions = [primary]
  for (let start = 1; start <= latestProbeStart; start++) {
    const probe = buildSegmentsFromAnchor(confirmedBis.slice(start), { trustedStart: false })
    if (probe.resynced) decompositions.push(probe)
  }
  if (decompositions.length < 2) return { segments: [], candidate: null, resynced: true, stable: false, historicalSegmentRuns: [] }

  const segmentValidators = decompositions.filter(result => result.segments.length > 0)
  let commonCount = 0
  while (segmentValidators.length >= 2 && commonCount < primary.segments.length) {
    const primarySegment = primary.segments[primary.segments.length - 1 - commonCount]
    const agreed = segmentValidators.every(result => {
      const segment = result.segments[result.segments.length - 1 - commonCount]
      return sameSegmentBoundary(primarySegment, segment)
    })
    if (!agreed) break
    commonCount++
  }
  // One matching terminal segment can still share a false endpoint when every
  // available start is missing the same older context. Two consecutive common
  // segments are the minimum evidence that decomposition phase has recovered.
  const segments = commonCount >= 2 ? primary.segments.slice(-commonCount) : []
  const supportedPairs = primary.segments.slice(0, -1).map((segment, index) => {
    const next = primary.segments[index + 1]
    return decompositions.filter(result => result.segments.some((candidate, candidateIndex) => (
      sameSegmentBoundary(segment, candidate) && sameSegmentBoundary(next, result.segments[candidateIndex + 1])
    ))).length >= 2
  })
  const historicalSegmentRuns = []
  for (let index = 0; index < supportedPairs.length;) {
    if (!supportedPairs[index]) { index++; continue }
    const start = index
    while (index + 1 < supportedPairs.length && supportedPairs[index + 1]) index++
    historicalSegmentRuns.push(primary.segments.slice(start, index + 2))
    index++
  }
  const candidateValidators = decompositions.filter(result => result.candidate)
  const candidate = primary.candidate && candidateValidators.length >= 2 && candidateValidators.every(result => sameCandidate(primary.candidate, result.candidate))
    ? primary.candidate
    : null
  return { segments, candidate, resynced: true, stable: segments.length > 0 || candidate !== null, historicalSegmentRuns }
}

// === Chan Theory: Center (Zhongshu) Detection from confirmed segments ===
function buildCenters(components) {
  if (components.length < 3) return []
  const centers = []
  let i = 0
  while (i + 2 < components.length) {
    const initial = components.slice(i, i + 3)
    const ranges = initial.map(item => [
      Number.isFinite(item.low) ? item.low : Math.min(item.start_price, item.end_price),
      Number.isFinite(item.high) ? item.high : Math.max(item.start_price, item.end_price),
    ])
    const zl = Math.max(ranges[0][0], ranges[1][0], ranges[2][0])
    const zh = Math.min(ranges[0][1], ranges[1][1], ranges[2][1])
    if (!(zl < zh)) { i++; continue }

    const center = {
      id: centers.length + 1,
      zl,
      zh,
      start_segment_id: initial[0].id,
      end_segment_id: initial[2].id,
      segment_ids: initial.map(item => item.id),
      fluctuation_low: Math.min(...ranges.map(range => range[0])),
      fluctuation_high: Math.max(...ranges.map(range => range[1])),
      level: '',
      status: 'confirmed',
      closed_by_segment_id: null,
    }
    let j = i + 3
    while (j < components.length) {
      const item = components[j]
      const low = Number.isFinite(item.low) ? item.low : Math.min(item.start_price, item.end_price)
      const high = Number.isFinite(item.high) ? item.high : Math.max(item.start_price, item.end_price)
      if (Math.max(center.zl, low) >= Math.min(center.zh, high)) {
        center.closed_by_segment_id = item.id
        break
      }
      center.fluctuation_low = Math.min(center.fluctuation_low, low)
      center.fluctuation_high = Math.max(center.fluctuation_high, high)
      center.segment_ids.push(item.id)
      center.end_segment_id = item.id
      center.status = 'extended'
      j++
    }
    if (j < components.length) center.status = 'closed'
    centers.push(center)
    i = j < components.length ? j : components.length
  }
  return centers
}

// === Chan Theory: Divergence Detection (conservative) ===
function divergenceResult(reason, overrides = {}) {
  return {
    type: 'none', state: 'unavailable', confirmed: false, segment_confirmed: false, strength: 'none', reason,
    divergence_key: null,
    category: null, center_id: null, entry_segment_id: null, departure_segment_id: null,
    entry_segment: null, departure_segment: null,
    area_cur: 0, area_prev: 0, peak_cur: 0, peak_prev: 0,
    area_ratio: null, peak_ratio: null, area_reduction_pct: null, peak_reduction_pct: null,
    price_extreme_cur: 0, price_extreme_prev: 0,
    ...overrides,
  }
}

function segmentLocation(segment, bis, rates = []) {
  if (!segment) return null
  const price = value => Number.isFinite(Number(value)) ? round5(Number(value)) : null
  const segmentBis = (segment.bi_ids || []).map(id => bis.find(b => b.id === id)).filter(Boolean)
  const startIndex = Number.isFinite(Number(segment.raw_start_idx))
    ? Number(segment.raw_start_idx)
    : segmentBis.length ? Math.min(...segmentBis.map(b => Number(b.raw_start_idx))) : null
  const endIndex = Number.isFinite(Number(segment.raw_end_idx))
    ? Number(segment.raw_end_idx)
    : segmentBis.length ? Math.max(...segmentBis.map(b => Number(b.raw_end_idx))) : null
  const startUtcMs = startIndex != null && Number.isFinite(Number(rates[startIndex]?.time_utc_msc)) ? Number(rates[startIndex].time_utc_msc) : null
  const endUtcMs = endIndex != null && Number.isFinite(Number(rates[endIndex]?.time_utc_msc)) ? Number(rates[endIndex].time_utc_msc) : null
  const startBrokerTime = startIndex != null ? rates[startIndex]?.time ?? null : null
  const endBrokerTime = endIndex != null ? rates[endIndex]?.time ?? null : null
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
    start_price: price(segment.start_price),
    end_price: price(segment.end_price),
    high: price(segment.high),
    low: price(segment.low),
  }
}

function evaluateDivergence(current, segments, bis, macdHist, centers = [], rates = [], state = 'confirmed') {
  const emptyResult = reason => divergenceResult(reason, { state: state === 'forming' ? 'forming' : 'unavailable' })
  if (!ENABLE_DIVERGENCE || !macdHist || macdHist.length === 0) return emptyResult('no_macd_data')
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  if (!current || !Array.isArray(current.bi_ids) || current.bi_ids.length < MIN_BIS_PER_SEGMENT) return emptyResult('insufficient_valid_segments')
  if (validSegs.length < (state === 'forming' ? 1 : 2)) return emptyResult('insufficient_valid_segments')
  if (centers.length === 0) return emptyResult('no_valid_center')

  function calcMacdStats(biIds, dir) {
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

  // Compare the latest departure segment with the same-direction segment that
  // entered the same center. This prevents unrelated historical segments from
  // being paired solely because their direction matches.
  const eligibleCenters = centers.filter(c => current.id === (c.end_segment_id || 0) + 1)
  if (eligibleCenters.length === 0) return emptyResult('not_after_center')
  const lastCenter = eligibleCenters[eligibleCenters.length - 1]
  const prev = validSegs.find(s => s.id === lastCenter.start_segment_id - 1)
  if (!prev || prev.dir !== current.dir) return emptyResult('no_entry_segment')
  const cur = current
  const entryLocation = segmentLocation(prev, bis, rates)
  const departureLocation = segmentLocation(cur, bis, rates)
  const context = {
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

  const comparisonBis = [...prev.bi_ids, ...cur.bi_ids]
    .map(id => bis.find(b => b.id === id))
    .filter(Boolean)
  if (comparisonBis.some(b => Number(b.raw_start_idx) < MACD_WARMUP_BARS)) {
    return divergenceResult('macd_warmup_overlap', context)
  }

  const prevMacd = calcMacdStats(prev.bi_ids, cur.dir)
  const curMacd = calcMacdStats(cur.bi_ids, cur.dir)
  const areaPrev = prevMacd.area
  const areaCur = curMacd.area
  const peakPrev = prevMacd.peak
  const peakCur = curMacd.peak

  if (areaCur === 0 || areaPrev === 0) return divergenceResult('invalid_macd_area', { ...context, area_cur: round2(areaCur), area_prev: round2(areaPrev), peak_cur: round2(peakCur), peak_prev: round2(peakPrev) })

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
    area_cur: round2(areaCur), area_prev: round2(areaPrev), peak_cur: round2(peakCur), peak_prev: round2(peakPrev),
    area_ratio: areaRatio == null ? null : round3(areaRatio),
    peak_ratio: peakRatio == null ? null : round3(peakRatio),
    area_reduction_pct: areaRatio == null ? null : round2((1 - areaRatio) * 100),
    peak_reduction_pct: peakRatio == null ? null : round2((1 - peakRatio) * 100),
  }
  const divergenceKey = type => departureLocation?.stable_id ? `${type}:${departureLocation.stable_id}` : null

  if (cur.dir === 'up') {
    if (cur.high <= prev.high) return divergenceResult('no_price_extreme_break', { ...context, ...macdFields, price_extreme_cur: round5(cur.high), price_extreme_prev: round5(prev.high) })
    if (areaDiverged || heightDiverged) return divergenceResult(reason, { ...context, type: 'top', divergence_key: divergenceKey('top'), confirmed: state === 'confirmed', trend_confirmed: false, strength, ...macdFields, price_extreme_cur: round5(cur.high), price_extreme_prev: round5(prev.high) })
    return divergenceResult(reason, { ...context, ...macdFields, price_extreme_cur: round5(cur.high), price_extreme_prev: round5(prev.high) })
  } else {
    if (cur.low >= prev.low) return divergenceResult('no_price_extreme_break', { ...context, ...macdFields, price_extreme_cur: round5(cur.low), price_extreme_prev: round5(prev.low) })
    if (areaDiverged || heightDiverged) return divergenceResult(reason, { ...context, type: 'bottom', divergence_key: divergenceKey('bottom'), confirmed: state === 'confirmed', trend_confirmed: false, strength, ...macdFields, price_extreme_cur: round5(cur.low), price_extreme_prev: round5(prev.low) })
    return divergenceResult(reason, { ...context, ...macdFields, price_extreme_cur: round5(cur.low), price_extreme_prev: round5(prev.low) })
  }
}

function detectDivergence(segments, bis, macdHist, centers = [], rates = []) {
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  return evaluateDivergence(validSegs[validSegs.length - 1], validSegs, bis, macdHist, centers, rates, 'confirmed')
}

function detectDivergenceHistory(segments, bis, macdHist, centers = [], rates = []) {
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  return validSegs
    .map(segment => evaluateDivergence(segment, validSegs, bis, macdHist, centers, rates, 'confirmed'))
    .filter(result => result.type === 'top' || result.type === 'bottom')
    .slice(-FEED_LAST_N_DIVERGENCES)
}

function buildFormingSegment(candidate, bis, nextId) {
  if (!candidate || !Array.isArray(candidate.bi_ids) || candidate.bi_ids.length < MIN_BIS_PER_SEGMENT) return null
  const candidateBis = candidate.bi_ids.map(id => bis.find(b => b.id === id)).filter(Boolean)
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

function detectFormingDivergence(candidate, segments, bis, macdHist, centers = [], rates = []) {
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  const formingSegment = buildFormingSegment(candidate, bis, (validSegs[validSegs.length - 1]?.id || 0) + 1)
  return formingSegment
    ? evaluateDivergence(formingSegment, validSegs, bis, macdHist, centers, rates, 'forming')
    : emptyDivergence('no_forming_segment')
}

function summarizeSegment(segment, bis = [], rates = []) {
  if (!segment) return null
  const location = segmentLocation(segment, bis, rates)
  return {
    id: segment.id,
    stable_id: location?.stable_id ?? null,
    dir: segment.dir,
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
  }
}

function summarizeCenter(center, timeframe) {
  if (!center) return null
  return {
    id: center.id,
    zl: round5(center.zl),
    zh: round5(center.zh),
    gg: round5(center.fluctuation_high),
    dd: round5(center.fluctuation_low),
    status: center.status,
    source_timeframe: timeframe,
    structure_level: 'segment',
    level: timeframe,
    start_segment_id: center.start_segment_id,
    end_segment_id: center.end_segment_id,
    closed_by_segment_id: center.closed_by_segment_id,
  }
}

function emptyTrendState(reason = 'structure_unavailable') {
  return {
    state: 'unavailable',
    direction: 'neutral',
    phase: 'unknown',
    reversal_bias: 'none',
    confidence: 'low',
    reason,
    center_id: null,
    segment_id: null,
  }
}

function capStructureConfidence(reliability, preferred = 'medium') {
  if (reliability === 'low') return 'low'
  if (reliability === 'high') return preferred
  return preferred === 'high' ? 'medium' : preferred
}

function classifyChanTrend(segments, centers, latestPrice, divergence, reliability = 'low') {
  const validSegments = segments.filter(segment => !segment.weak && Array.isArray(segment.bi_ids) && segment.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  const latestSegment = validSegments.at(-1)
  const latestCenter = centers.at(-1)
  if (!latestSegment) return emptyTrendState('no_confirmed_segment')

  if (divergence?.confirmed && divergence.type === 'top') {
    return {
      state: 'upward_exhaustion', direction: 'up', phase: 'exhaustion', reversal_bias: 'down',
      confidence: capStructureConfidence(reliability, divergence.strength === 'strong' ? 'high' : 'medium'),
      reason: 'confirmed_top_divergence', center_id: divergence.center_id ?? latestCenter?.id ?? null,
      segment_id: divergence.departure_segment_id ?? latestSegment.id,
    }
  }
  if (divergence?.confirmed && divergence.type === 'bottom') {
    return {
      state: 'downward_exhaustion', direction: 'down', phase: 'exhaustion', reversal_bias: 'up',
      confidence: capStructureConfidence(reliability, divergence.strength === 'strong' ? 'high' : 'medium'),
      reason: 'confirmed_bottom_divergence', center_id: divergence.center_id ?? latestCenter?.id ?? null,
      segment_id: divergence.departure_segment_id ?? latestSegment.id,
    }
  }

  if (centers.length >= 2) {
    const previousCenter = centers.at(-2)
    if (latestCenter.zl > previousCenter.zh) {
      return {
        state: 'uptrend', direction: 'up', phase: 'trend', reversal_bias: 'none',
        confidence: capStructureConfidence(reliability, 'high'), reason: 'centers_rising_without_overlap',
        center_id: latestCenter.id, segment_id: latestSegment.id,
      }
    }
    if (latestCenter.zh < previousCenter.zl) {
      return {
        state: 'downtrend', direction: 'down', phase: 'trend', reversal_bias: 'none',
        confidence: capStructureConfidence(reliability, 'high'), reason: 'centers_falling_without_overlap',
        center_id: latestCenter.id, segment_id: latestSegment.id,
      }
    }
  }

  if (latestCenter) {
    const breakoutSegment = validSegments.find(segment => segment.id === latestCenter.closed_by_segment_id)
    if (latestCenter.status === 'closed' && breakoutSegment?.dir === 'up' && Number(latestPrice) > latestCenter.zh) {
      return {
        state: 'upward_breakout', direction: 'up', phase: 'breakout', reversal_bias: 'none',
        confidence: capStructureConfidence(reliability), reason: 'price_above_closed_center',
        center_id: latestCenter.id, segment_id: breakoutSegment.id,
      }
    }
    if (latestCenter.status === 'closed' && breakoutSegment?.dir === 'down' && Number(latestPrice) < latestCenter.zl) {
      return {
        state: 'downward_breakout', direction: 'down', phase: 'breakout', reversal_bias: 'none',
        confidence: capStructureConfidence(reliability), reason: 'price_below_closed_center',
        center_id: latestCenter.id, segment_id: breakoutSegment.id,
      }
    }
    return {
      state: 'consolidation', direction: 'neutral', phase: 'range', reversal_bias: 'none',
      confidence: capStructureConfidence(reliability), reason: latestCenter.status === 'closed' ? 'price_returned_to_center' : 'center_active',
      center_id: latestCenter.id, segment_id: latestSegment.id,
    }
  }

  return {
    state: latestSegment.dir === 'up' ? 'structural_rise' : 'structural_decline',
    direction: latestSegment.dir === 'up' ? 'up' : 'down',
    phase: 'structure', reversal_bias: 'none', confidence: 'low', reason: 'segments_without_center',
    center_id: null, segment_id: latestSegment.id,
  }
}

function detectChanEntryCandidates(segments, centers, divergence, recentDivergences, bis, rates, reliability, timeLocationReliable) {
  const validSegments = segments.filter(segment => !segment.weak && Array.isArray(segment.bi_ids) && segment.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  const latestSegment = validSegments.at(-1)
  if (!latestSegment) return []
  const structurallyUsable = reliability !== 'low' && timeLocationReliable !== false
  const confidence = preferred => capStructureConfidence(reliability, preferred)
  const results = []
  const add = ({ type, side, source, segment, center = null, referencePrice, invalidationPrice, preferredConfidence = 'medium' }) => {
    const location = summarizeSegment(segment, bis, rates)
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
    })
  }

  if (divergence?.confirmed && divergence.type === 'bottom') {
    const segment = validSegments.find(item => item.id === divergence.departure_segment_id) || latestSegment
    add({
      type: 'first_buy', side: 'buy', source: 'confirmed_bottom_divergence', segment,
      center: centers.find(item => item.id === divergence.center_id), referencePrice: segment.end_price,
      invalidationPrice: divergence.price_extreme_cur, preferredConfidence: divergence.strength === 'strong' ? 'high' : 'medium',
    })
  } else if (divergence?.confirmed && divergence.type === 'top') {
    const segment = validSegments.find(item => item.id === divergence.departure_segment_id) || latestSegment
    add({
      type: 'first_sell', side: 'sell', source: 'confirmed_top_divergence', segment,
      center: centers.find(item => item.id === divergence.center_id), referencePrice: segment.end_price,
      invalidationPrice: divergence.price_extreme_cur, preferredConfidence: divergence.strength === 'strong' ? 'high' : 'medium',
    })
  }

  const priorDivergences = Array.isArray(recentDivergences) ? recentDivergences : []
  const lastBottom = [...priorDivergences].reverse().find(item => item.type === 'bottom' && item.confirmed)
  const lastTop = [...priorDivergences].reverse().find(item => item.type === 'top' && item.confirmed)
  if (lastBottom && latestSegment.dir === 'down' && latestSegment.id >= Number(lastBottom.departure_segment_id) + 2 && latestSegment.low > Number(lastBottom.price_extreme_cur)) {
    add({
      type: 'second_buy', side: 'buy', source: 'higher_low_after_first_buy', segment: latestSegment,
      center: centers.find(item => item.id === lastBottom.center_id), referencePrice: latestSegment.end_price,
      invalidationPrice: lastBottom.price_extreme_cur,
    })
  }
  if (lastTop && latestSegment.dir === 'up' && latestSegment.id >= Number(lastTop.departure_segment_id) + 2 && latestSegment.high < Number(lastTop.price_extreme_cur)) {
    add({
      type: 'second_sell', side: 'sell', source: 'lower_high_after_first_sell', segment: latestSegment,
      center: centers.find(item => item.id === lastTop.center_id), referencePrice: latestSegment.end_price,
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

function emptyDivergence(reason = 'structure_unavailable') {
  return divergenceResult(reason)
}

function emptyChanResult(overrides = {}) {
  return {
    status: 'insufficient_klines',
    reliability: 'low',
    requested_history_count: 0,
    received_history_count: 0,
    history_sufficient: false,
    requested_closed_history_count: 0,
    closed_history_sufficient: false,
    clock_status: 'unknown',
    time_location_reliable: false,
    cache_gap_refilled: false,
    window_resynced: false,
    window_stable: false,
    raw_bar_count: 0,
    closed_bar_count: 0,
    processed_bar_count: 0,
    fractal_count: 0,
    bi_count: 0,
    segment_count: 0,
    center_count: 0,
    historical_segment_run_count: 0,
    historical_segment_count: 0,
    current_bi: null,
    developing_bi: null,
    recent_bis: [],
    current_segment: null,
    prev_segment: null,
    candidate_segment: null,
    current_center: null,
    active_center: null,
    latest_center: null,
    price_vs_center: 'none',
    divergence: emptyDivergence(),
    forming_divergence: emptyDivergence('no_forming_segment'),
    recent_divergences: [],
    trend_state: emptyTrendState(),
    entry_candidates: [],
    warnings: [],
    ...overrides,
  }
}

// === Chan Theory: Assembly ===
function computeChan(rates, timeframe, macdHist, options = {}) {
  const warnings = []
  const dataQuality = options.dataQuality && typeof options.dataQuality === 'object' ? options.dataQuality : null
  const requestedHistoryCount = Number(options.requestedHistoryCount) || rates?.length || 0
  const historySufficient = Array.isArray(rates) && rates.length >= requestedHistoryCount
  if (!historySufficient) warnings.push('history_bars_below_requested')
  const closedRates = Array.isArray(rates) ? rates.slice(0, -1) : []
  const requestedClosedHistoryCount = Math.max(requestedHistoryCount - 1, 0)
  const closedHistorySufficient = closedRates.length >= requestedClosedHistoryCount
  if (!closedHistorySufficient && historySufficient) warnings.push('closed_history_bars_below_requested')
  const utcTimes = closedRates.map(rate => Number(rate?.time_utc_msc))
  const utcLocationComplete = closedRates.length > 0 && utcTimes.every(value => Number.isFinite(value) && value > 0)
  const utcSequenceMonotonic = utcLocationComplete && utcTimes.every((value, index) => index === 0 || value > utcTimes[index - 1])
  const clockStatus = String(dataQuality?.clock_status || rates?.at?.(-1)?.clock_status || 'unknown')
  const timeLocationReliable = dataQuality == null || (clockStatus === 'verified' && utcLocationComplete && utcSequenceMonotonic)
  if (dataQuality && clockStatus !== 'verified') warnings.push('market_clock_unverified')
  if (dataQuality && !utcLocationComplete) warnings.push('utc_time_location_incomplete')
  if (dataQuality && utcLocationComplete && !utcSequenceMonotonic) warnings.push('utc_time_sequence_invalid')
  const closedMacdHist = Array.isArray(macdHist) ? macdHist.slice(0, closedRates.length) : []
  if (closedRates.length < MIN_KLINES_FOR_CHAN) {
    return emptyChanResult({
      status: 'insufficient_klines',
      requested_history_count: requestedHistoryCount,
      received_history_count: rates?.length || 0,
      history_sufficient: historySufficient,
      requested_closed_history_count: requestedClosedHistoryCount,
      closed_history_sufficient: closedHistorySufficient,
      clock_status: clockStatus,
      time_location_reliable: timeLocationReliable,
      raw_bar_count: rates?.length || 0,
      closed_bar_count: closedRates.length,
      divergence: emptyDivergence('insufficient_klines'),
      warnings: [...warnings, 'raw_bars_too_few'],
    })
  }
  const bars = normalizeBarsForChan(closedRates)
  if (bars.length < 10) warnings.push('processed_bars_too_few')
  const fractals = options.fractalsForTest || detectFractals(bars)
  const { bis: allBis, invalidCount, activePivot } = buildBis(fractals, bars)
  if (invalidCount > 0) warnings.push('invalid_bi_price_direction')
  const confirmedBis = allBis.filter(b => b.confirmed !== false)
  const developingBi = buildDevelopingBi(activePivot, rates)
  if (confirmedBis.length < 3) {
    warnings.push('insufficient_confirmed_bis')
    const lastBi = allBis[allBis.length - 1]
    return emptyChanResult({
      status: 'insufficient_bis',
      requested_history_count: requestedHistoryCount,
      received_history_count: rates.length,
      history_sufficient: historySufficient,
      requested_closed_history_count: requestedClosedHistoryCount,
      closed_history_sufficient: closedHistorySufficient,
      clock_status: clockStatus,
      time_location_reliable: timeLocationReliable,
      raw_bar_count: rates.length,
      closed_bar_count: closedRates.length,
      processed_bar_count: bars.length,
      fractal_count: fractals.length,
      bi_count: allBis.length,
      current_bi: lastBi ? { id: lastBi.id, dir: lastBi.dir, start_price: round5(lastBi.start_price), end_price: round5(lastBi.end_price), confirmed: lastBi.confirmed } : null,
      developing_bi: developingBi,
      recent_bis: allBis.slice(-FEED_LAST_N_BIS).map(b => ({ id: b.id, dir: b.dir, start_price: round5(b.start_price), end_price: round5(b.end_price), confirmed: b.confirmed })),
      divergence: emptyDivergence('insufficient_bis'),
      warnings,
    })
  }
  const { segments, candidate, resynced, stable: windowStable, historicalSegmentRuns = [] } = buildSegments(confirmedBis, { trustedStart: false })
  if (!resynced) warnings.push('segment_window_not_resynced')
  else if (!windowStable) warnings.push('segment_window_unstable')
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  if (validSegs.length === 0) warnings.push('segments_not_confirmed')
  const centers = buildCenters(validSegs)
  if (centers.length === 0) warnings.push('no_valid_center')
  const latestCenter = centers.length > 0 ? centers[centers.length - 1] : null
  const activeCenter = latestCenter?.status === 'closed' ? null : latestCenter
  const lastSeg = validSegs.length > 0 ? validSegs[validSegs.length - 1] : null
  const lastBi = allBis[allBis.length - 1]
  const latest = parseFloat(rates[rates.length - 1].close)
  let priceVsCenter = 'none'
  if (latestCenter) {
    if (latest > latestCenter.zh) priceVsCenter = 'above'
    else if (latest < latestCenter.zl) priceVsCenter = 'below'
    else priceVsCenter = 'inside'
  }
  const divergence = detectDivergence(validSegs, allBis, closedMacdHist, centers, closedRates)
  const historicalDivergenceMap = new Map()
  for (const run of historicalSegmentRuns) {
    const runCenters = buildCenters(run)
    for (const item of detectDivergenceHistory(run, allBis, closedMacdHist, runCenters, closedRates)) {
      const key = item.divergence_key || `${item.type}:${item.departure_segment_id}:${item.departure_segment?.end_index}`
      historicalDivergenceMap.set(key, item)
    }
  }
  if (divergence.type === 'top' || divergence.type === 'bottom') {
    const key = divergence.divergence_key || `${divergence.type}:${divergence.departure_segment_id}:${divergence.departure_segment?.end_index}`
    historicalDivergenceMap.set(key, divergence)
  }
  const recentDivergences = [...historicalDivergenceMap.values()]
    .sort((a, b) => Number(a.departure_segment?.end_index || 0) - Number(b.departure_segment?.end_index || 0))
    .slice(-FEED_LAST_N_DIVERGENCES)
  const formingSegment = buildFormingSegment(candidate, allBis, (lastSeg?.id || 0) + 1)
  const formingDivergence = detectFormingDivergence(candidate, validSegs, allBis, closedMacdHist, centers, closedRates)
  if (divergence.type !== 'none') {
    // ok
  } else if (divergence.reason === 'invalid_macd_area' || divergence.reason === 'no_macd_data') {
    warnings.push('divergence_skipped_invalid_macd')
  }

  let reliability = 'low'
  if (historySufficient && closedHistorySufficient && timeLocationReliable && validSegs.length >= 2 && centers.length > 0 && warnings.length === 0) reliability = 'high'
  else if (historySufficient && closedHistorySufficient && validSegs.length > 0) reliability = 'medium'

  let status = 'ok'
  if (validSegs.length === 0 && confirmedBis.length >= 3) status = 'unreliable_segments'
  else if (validSegs.length > 0 && centers.length === 0) status = 'partial'
  else if (warnings.length > 0) status = 'partial'

  const trendState = classifyChanTrend(validSegs, centers, latest, divergence, reliability)
  const entryCandidates = detectChanEntryCandidates(validSegs, centers, divergence, recentDivergences, allBis, closedRates, reliability, timeLocationReliable)

  if (DEBUG_CHAN) console.log(`[Chan] ${timeframe}: status=${status} reliability=${reliability} raw=${rates.length} processed=${bars.length} fractals=${fractals.length} bis=${allBis.length} confirmed=${confirmedBis.length} segs=${validSegs.length} centers=${centers.length} warnings=${warnings.join(',') || 'none'}`)
  return {
    status, reliability,
    requested_history_count: requestedHistoryCount,
    received_history_count: rates.length,
    history_sufficient: historySufficient,
    requested_closed_history_count: requestedClosedHistoryCount,
    closed_history_sufficient: closedHistorySufficient,
    clock_status: clockStatus,
    time_location_reliable: timeLocationReliable,
    cache_gap_refilled: Boolean(dataQuality?.cache_gap_refilled),
    window_resynced: resynced,
    window_stable: windowStable,
    raw_bar_count: rates.length, closed_bar_count: closedRates.length, processed_bar_count: bars.length,
    fractal_count: fractals.length, bi_count: allBis.length, segment_count: validSegs.length, center_count: centers.length,
    historical_segment_run_count: historicalSegmentRuns.length,
    historical_segment_count: historicalSegmentRuns.reduce((sum, run) => sum + run.length, 0),
    current_bi: lastBi ? { id: lastBi.id, dir: lastBi.dir, start_price: round5(lastBi.start_price), end_price: round5(lastBi.end_price), confirmed: lastBi.confirmed } : null,
    developing_bi: developingBi,
    recent_bis: allBis.slice(-FEED_LAST_N_BIS).map(b => ({ id: b.id, dir: b.dir, start_price: round5(b.start_price), end_price: round5(b.end_price), confirmed: b.confirmed })),
    current_segment: summarizeSegment(lastSeg, allBis, closedRates),
    prev_segment: summarizeSegment(validSegs[validSegs.length - 2], allBis, closedRates),
    candidate_segment: formingSegment ? { ...summarizeSegment(formingSegment, allBis, closedRates), confirmed: false } : candidate ? { dir: candidate.dir, bi_count: candidate.bi_ids.length, start_price: round5(candidate.start_price), end_price: round5(candidate.end_price), confirmed: false } : null,
    current_center: summarizeCenter(latestCenter, timeframe),
    active_center: summarizeCenter(activeCenter, timeframe),
    latest_center: summarizeCenter(latestCenter, timeframe),
    price_vs_center: priceVsCenter,
    divergence,
    forming_divergence: formingDivergence,
    recent_divergences: recentDivergences,
    trend_state: trendState,
    entry_candidates: entryCandidates,
    warnings,
  }
}

// Export for testing
export const __chanTest = { calculateMacdSeries, normalizeBarsForChan, detectFractals, buildBis, buildDevelopingBi, normalizeFeatureSequence, buildSegments, buildCenters, detectDivergence, detectDivergenceHistory, detectFormingDivergence, buildFormingSegment, summarizeSegment, summarizeCenter, classifyChanTrend, detectChanEntryCandidates, emptyChanResult, computeChan }

export async function mt5Bridge(userId, action, params = {}, options = {}) {
  const prev = _bridgeLocks.get(userId) || Promise.resolve()
  const current = prev.then(async () => {
    let result = await executeViaBridge(userId, action, params, options.timeoutMs, options)
    if (result?.status === 'error' && result.message?.includes('Symbol not found') && params.symbol) {
      let base = params.symbol
      const knownSuffixes = ['.s', '.c', 'm', '.pro', '.std', '.z', '.ecn', '_']
      for (const sfx of knownSuffixes) {
        if (base.endsWith(sfx)) { base = base.slice(0, -sfx.length); break }
      }
      const variants = [base, base + '.s', base + '.c']
      let fallback_used = null
      for (const v of variants) {
        if (v === params.symbol) continue
        result = await executeViaBridge(userId, action, { ...params, symbol: v }, options.timeoutMs, options)
        if (result?.status !== 'error') { fallback_used = v; break }
      }
      if (fallback_used) {
        console.log(`[mt5Bridge] User ${userId}: rates symbol fallback ${params.symbol} → ${fallback_used} ✓`)
      }
    }
    return result
  }).catch(e => ({ status: 'error', message: e.message }))
    .finally(() => { if (_bridgeLocks.get(userId) === current) _bridgeLocks.delete(userId) })
  _bridgeLocks.set(userId, current)
  return current
}

export async function executeViaBridge(userId, action, params, timeoutMs = 10000, options = {}) {
  return sendBridgeCommand(userId, action, params, timeoutMs, options)
}

export async function platformRates(userId, params = {}) {
  const { getPlatformRates } = await import('./platform-market-data.js')
  return getPlatformRates(userId, params)
}

export function calculateMarketData(symbol, timeframe, rates, account, positions, options = {}) {
  if (!rates || rates.length === 0) {
    return { symbol, timeframe, latest_price: 0, strategy_score: { trend_strength: 0, data_confidence: 0.1 }, error: 'no_rates' }
  }
  const closes = rates.map(r => parseFloat(r.close))
  const highs = rates.map(r => parseFloat(r.high))
  const lows = rates.map(r => parseFloat(r.low))
  const opens = rates.map(r => parseFloat(r.open))
  const volumes = rates.map(r => parseInt(r.tick_volume || 0))
  const n = closes.length
  const latest = closes[n - 1]
  const first = closes[0]

  function ema(data, period) {
    if (data.length < period) return data[data.length - 1]
    const k = 2 / (period + 1)
    let e = data.slice(0, period).reduce((a, b) => a + b, 0) / period
    for (let i = period; i < data.length; i++) e = data[i] * k + e * (1 - k)
    return e
  }

  function calcRsi(data, period) {
    if (data.length < period + 1) return 50
    let gain = 0, loss = 0
    for (let i = data.length - period; i < data.length; i++) {
      const diff = data[i] - data[i - 1]
      if (diff > 0) gain += diff; else loss -= diff
    }
    const avgGain = gain / period
    const avgLoss = loss / period
    if (avgLoss === 0) return 100
    return 100 - 100 / (1 + avgGain / avgLoss)
  }

  const smaWindow = n >= 20 ? closes.slice(-20) : closes
  const sma20 = smaWindow.reduce((a, b) => a + b, 0) / smaWindow.length
  const sma50Window = n >= 50 ? closes.slice(-50) : closes
  const sma50 = sma50Window.reduce((a, b) => a + b, 0) / sma50Window.length

  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)
  const macdSeries = calculateMacdSeries(closes)
  const macdLine = macdSeries.latestDif
  const macdSignal = macdSeries.latestDea
  const macdHistogram = macdSeries.latestHist

  const rsi14 = calcRsi(closes, 14)

  const bbStd = Math.sqrt(smaWindow.reduce((sum, v) => sum + (v - sma20) ** 2, 0) / smaWindow.length)
  const bbUpper = sma20 + 2 * bbStd
  const bbLower = sma20 - 2 * bbStd
  const bbWidth = bbUpper - bbLower
  const bbPosition = bbWidth > 0 ? (latest - bbLower) / bbWidth : 0.5

  const atr14 = computeAtr14(rates)
  const closedRates = rates.length > 1 ? rates.slice(0, -1) : []
  const atr14Closed = computeAtr14(closedRates)

  const recentHighs = highs.length >= 20 ? highs.slice(-20) : highs
  const recentLows = lows.length >= 20 ? lows.slice(-20) : lows
  const recentHigh = Math.max(...recentHighs)
  const recentLow = Math.min(...recentLows)
  const recentRange = Math.max(recentHigh - recentLow, 0.00001)
  const rangePosition = (latest - recentLow) / recentRange

  const prevH = highs[n - 2] || latest, prevL = lows[n - 2] || latest, prevC = closes[n - 2] || latest
  const pivot = (prevH + prevL + prevC) / 3
  const r1 = 2 * pivot - prevL
  const s1 = 2 * pivot - prevH
  const r2 = pivot + (prevH - prevL)
  const s2 = pivot - (prevH - prevL)

  const momentum3 = n >= 4 ? ((latest - closes[n - 4]) / closes[n - 4]) * 100 : 0
  const momentum10 = n >= 11 ? ((latest - closes[n - 11]) / closes[n - 11]) * 100 : 0
  const momentum20 = n >= 21 ? ((latest - closes[n - 21]) / closes[n - 21]) * 100 : 0
  const smaDistancePct = latest ? ((latest - sma20) / latest) * 100 : 0
  const ranges = highs.map((h, i) => h - lows[i])
  const avgVolatility = ranges.reduce((a, b) => a + b, 0) / ranges.length
  const volatilityPct = latest ? (avgVolatility / latest) * 100 : 0

  const trendStrength = clamp(Math.abs(smaDistancePct) / Math.max(volatilityPct * 0.8, 0.0001), 0, 1)
  let momentumAlignment = 0
  if (momentum3 > 0 && momentum10 > 0) momentumAlignment = 1
  else if (momentum3 < 0 && momentum10 < 0) momentumAlignment = -1
  const edgeScore = clamp(0.35 + trendStrength * 0.35 + Math.min(Math.abs(momentum10) / Math.max(volatilityPct * 4, 0.0001), 0.25), 0.2, 0.9)
  const noisePenalty = clamp(volatilityPct / 0.45, 0, 0.18)
  const dataConfidence = clamp(Math.round((edgeScore - noisePenalty) * 100) / 100, 0.05, 0.95)

  const lastBody = Math.abs(closes[n - 1] - opens[n - 1])
  const lastRange = Math.max(highs[n - 1] - lows[n - 1], 0.00001)
  const lastUpperWick = highs[n - 1] - Math.max(closes[n - 1], opens[n - 1])
  const lastLowerWick = Math.min(closes[n - 1], opens[n - 1]) - lows[n - 1]
  const isDoji = lastBody < lastRange * 0.1
  const isHammer = lastLowerWick > lastBody * 2 && lastUpperWick < lastBody * 0.5
  const isShootingStar = lastUpperWick > lastBody * 2 && lastLowerWick < lastBody * 0.5
  const isEngulfing = n >= 2 && (
    (closes[n - 1] > opens[n - 1] && closes[n - 2] < opens[n - 2] && closes[n - 1] > opens[n - 2] && opens[n - 1] < closes[n - 2]) ||
    (closes[n - 1] < opens[n - 1] && closes[n - 2] > opens[n - 2] && closes[n - 1] < opens[n - 2] && opens[n - 1] > closes[n - 2])
  )

  const avgVolume = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0
  const lastVolume = volumes[n - 1] || 0
  const volumeRatio = avgVolume > 0 ? lastVolume / avgVolume : 1

  const longPositions = positions.filter(p => p.type === 'buy')
  const shortPositions = positions.filter(p => p.type === 'sell')
  const totalProfit = positions.reduce((sum, p) => sum + parseFloat(p.profit || 0), 0)

  const chanRates = options.chanRates || rates
  const chanCloses = chanRates === rates ? closes : chanRates.map(r => parseFloat(r.close))
  const chanMacdSeries = chanRates === rates ? macdSeries : calculateMacdSeries(chanCloses)
  const chan = options.computeChan
    ? computeChan(chanRates, timeframe, chanMacdSeries.histSeries, { requestedHistoryCount: options.requestedChanHistoryCount, dataQuality: options.chanDataQuality })
    : undefined

  return {
    symbol, timeframe,
    timestamp: beijingNow(),
    latest_price: round5(latest),
    price_change: round5(latest - first),
    price_change_pct: first ? round3(((latest - first) / first) * 100) : 0,
    sma_20: round5(sma20),
    sma_50: round5(sma50),
    ema_12: round5(ema12),
    ema_26: round5(ema26),
    avg_volatility: round5(avgVolatility),
    recent_high_20: round5(recentHigh),
    recent_low_20: round5(recentLow),
    range_position_20: round3(rangePosition),
    sma_distance_pct: round3(smaDistancePct),
    momentum_3_pct: round3(momentum3),
    momentum_10_pct: round3(momentum10),
    momentum_20_pct: round3(momentum20),
    volatility_pct: round3(volatilityPct),
    macd: {
      line: round5(macdLine),
      signal: round5(macdSignal),
      histogram: round5(macdHistogram),
      trend: macdHistogram > 0 ? 'bullish' : macdHistogram < 0 ? 'bearish' : 'neutral',
    },
    rsi_14: round2(rsi14),
    bollinger: {
      upper: round5(bbUpper),
      middle: round5(sma20),
      lower: round5(bbLower),
      width: round5(bbWidth),
      position: round3(bbPosition),
    },
    atr_14: round5(atr14),
    atr_14_closed: round5(atr14Closed),
    support_resistance: {
      pivot: round5(pivot), r1: round5(r1), r2: round5(r2), s1: round5(s1), s2: round5(s2),
      recent_high: round5(recentHigh), recent_low: round5(recentLow),
    },
    kline_patterns: {
      last_candle: {
        is_doji: isDoji, is_hammer: isHammer, is_shooting_star: isShootingStar, is_engulfing: isEngulfing,
        body_ratio: round3(lastBody / lastRange),
        upper_wick_ratio: round3(lastUpperWick / lastRange),
        lower_wick_ratio: round3(lastLowerWick / lastRange),
      },
      trend_candles: {
        bullish_count: closes.slice(-5).filter((c, i) => i > 0 && c > opens[opens.length - 5 + i]).length,
        bearish_count: closes.slice(-5).filter((c, i) => i > 0 && c < opens[opens.length - 5 + i]).length,
      },
    },
    volume: { current: lastVolume, average: Math.round(avgVolume), ratio: round2(volumeRatio) },
    strategy_score: {
      trend_strength: round3(trendStrength),
      momentum_alignment: momentumAlignment,
      data_confidence: dataConfidence,
      noise_penalty: round3(noisePenalty),
    },
    kline_count: n,
    positions: {
      total_positions: positions.length,
      long_positions: longPositions.length,
      short_positions: shortPositions.length,
      total_profit: round2(totalProfit),
      details: positions.map(p => ({
        ticket: p.ticket, symbol: p.symbol,
        type: p.type === 'buy' ? 'BUY' : 'SELL',
        volume: p.volume,
        open_price: p.open_price || p.price_open,
        current_price: p.price_current,
        profit: round2(p.profit || 0),
        sl: p.sl || null, tp: p.tp || null,
      })),
    },
    pending_orders: options.pending_orders || [],
    account: account ? { balance: account.balance, equity: account.equity } : null,
    chan,
  }
}
