// ai/market-data.js — 行情计算 + 桥接封装

import { beijingNow } from '../../db.js'
import { sendBridgeCommand } from '../../bridge-ws.js'
import { CHAN_ALGORITHM_VERSION, round2, round3, round5, clamp, compactRates } from './utils.js'

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
const CHAN_BOOTSTRAP_MAX_BARS = 2000
// Four center segments, two resynchronization segments and MACD warm-up need
// about 130 bars at the theoretical minimum. Keep a conservative 150-bar
// prefix before center evidence so boundary-truncated windows do not vote.
const CHAN_CENTER_MIN_CONTEXT_BARS = 150
const MT4_CLOCK_SAMPLE_MAX_AGE_MS = 5 * 60 * 1000
const CHAN_RULE_PROFILE = 'new_bi_feature_sequence_quorum'
const DEBUG_CHAN = process.env.DEBUG_CHAN === '1'

function roundMacdEvidence(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric === 0) return 0
  return Number(numeric.toPrecision(8))
}

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
    bars.push({
      idx: bars.length, raw_idx: i, raw_start_idx: i, raw_end_idx: i,
      high_raw_idx: i, low_raw_idx: i,
      high: h, low: l, open: o, close: c, time: rates[i].time,
    })
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
        merged[merged.length - 1] = {
          ...prev,
          high: Math.max(prev.high, cur.high),
          low: Math.max(prev.low, cur.low),
          high_raw_idx: prev.high >= cur.high ? prev.high_raw_idx : cur.high_raw_idx,
          low_raw_idx: prev.low >= cur.low ? prev.low_raw_idx : cur.low_raw_idx,
          raw_end_idx: cur.raw_end_idx,
        }
      } else {
        merged[merged.length - 1] = {
          ...prev,
          high: Math.min(prev.high, cur.high),
          low: Math.min(prev.low, cur.low),
          high_raw_idx: prev.high <= cur.high ? prev.high_raw_idx : cur.high_raw_idx,
          low_raw_idx: prev.low <= cur.low ? prev.low_raw_idx : cur.low_raw_idx,
          raw_end_idx: cur.raw_end_idx,
        }
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
      fractals.push({ idx: c.idx, raw_start_idx: c.raw_start_idx, raw_end_idx: c.raw_end_idx, extreme_raw_idx: c.high_raw_idx, type: 'top', price: c.high, high: c.high, low: c.low, time: c.time })
    } else if (c.low < p.low && c.low < n.low && c.high < p.high && c.high < n.high) {
      fractals.push({ idx: c.idx, raw_start_idx: c.raw_start_idx, raw_end_idx: c.raw_end_idx, extreme_raw_idx: c.low_raw_idx, type: 'bottom', price: c.low, high: c.high, low: c.low, time: c.time })
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
      const lastExtremeRawIndex = Number(last.extreme_raw_idx ?? last.raw_idx ?? last.raw_start_idx)
      const currentExtremeRawIndex = Number(f.extreme_raw_idx ?? f.raw_idx ?? f.raw_start_idx)
      const rawDistance = Number.isFinite(lastExtremeRawIndex) && Number.isFinite(currentExtremeRawIndex)
        ? currentExtremeRawIndex - lastExtremeRawIndex
        : f.idx - last.idx
      if (rawDistance >= MIN_BARS_PER_BI - 1) {
        pivots.push(f)
      }
    }
  }
  const bis = []
  const runs = []
  let invalidCount = 0
  let runId = 1
  let currentRun = []
  let lastDiscontinuity = null
  let anchor = pivots[0]
  for (let i = 1; i < pivots.length; i++) {
    const s = anchor, e = pivots[i]
    const dir = s.type === 'bottom' ? 'up' : 'down'
    if ((dir === 'up' && e.price <= s.price) || (dir === 'down' && e.price >= s.price)) {
      invalidCount++
      // Keep the confirmed prefix for audit/history, but start a new isolated
      // run. Segments are never allowed to cross a discontinuous price jump.
      if (currentRun.length > 0) runs.push(currentRun)
      currentRun = []
      runId++
      lastDiscontinuity = {
        pivot_index: i,
        processed_index: Number(e.idx),
        raw_index: Number(e.raw_start_idx ?? e.raw_idx),
      }
      anchor = e
      continue
    }
    const bi = {
      id: bis.length + 1, dir,
      run_id: runId,
      start_idx: s.idx, end_idx: e.idx,
      raw_start_idx: Math.min(s.extreme_raw_idx ?? s.raw_idx ?? s.raw_start_idx, e.extreme_raw_idx ?? e.raw_idx ?? e.raw_start_idx),
      raw_end_idx: Math.max(s.extreme_raw_idx ?? s.raw_idx ?? s.raw_end_idx, e.extreme_raw_idx ?? e.raw_idx ?? e.raw_end_idx),
      start_price: s.price, end_price: e.price,
      high: Math.max(s.high, e.high), low: Math.min(s.low, e.low),
      confirmed: true,
    }
    bis.push(bi)
    currentRun.push(bi)
    anchor = e
  }
  if (currentRun.length > 0) runs.push(currentRun)
  if (DEBUG_CHAN) console.log(`[Chan] Bis(${bis.length}, invalid=${invalidCount}): ${bis.map(b => `${b.id}${b.dir[0]} ${b.start_price}→${b.end_price}${b.confirmed ? '' : '*'}`).join(' | ')}`)
  return { bis, runs, invalidCount, activeRunId: runId, activePivot: anchor || null, lastDiscontinuity }
}

function buildDevelopingBi(activePivot, rates) {
  if (!activePivot || !Array.isArray(rates) || rates.length === 0) return null
  const pivotRawEnd = Number(activePivot.extreme_raw_idx ?? activePivot.raw_end_idx ?? activePivot.raw_idx)
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
  let resyncEndpointCount = 0
  while (startIndex + MIN_BIS_PER_SEGMENT <= confirmedBis.length) {
    const dir = confirmedBis[startIndex].dir
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
    const directionalBis = tailBis
      .filter(b => b.dir === dir)
      .filter(b => Number.isFinite(Number(b.end_price)))
    const endpointBi = directionalBis.reduce((best, bi) => {
      if (!best) return bi
      return dir === 'up'
        ? (Number(bi.end_price) > Number(best.end_price) ? bi : best)
        : (Number(bi.end_price) < Number(best.end_price) ? bi : best)
    }, null)
    const endPrice = Number(endpointBi?.end_price)
    candidate = {
      dir,
      bi_ids: tailBis.map(b => b.id),
      start_price: tailBis[0].start_price,
      end_price: endPrice,
      // The candidate may already contain a reverse stroke after its price
      // extreme. Keep the full stroke span for structure calculations, while
      // pairing the displayed endpoint price with the bar where it occurred.
      endpoint_raw_idx: Number.isFinite(Number(endpointBi?.raw_end_idx)) ? Number(endpointBi.raw_end_idx) : null,
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

function validatorEndsWithSegmentChain(validator, chain) {
  const candidateSegments = Array.isArray(validator?.segments) ? validator.segments : []
  const start = candidateSegments.length - chain.length
  return start >= 0 && chain.every((segment, index) => (
    sameSegmentBoundary(segment, candidateSegments[start + index])
  ))
}

function buildSegments(confirmedBis, options = {}) {
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
        current_start_bi_id: primary.segments[index + 1].start_bi_id,
        current_end_bi_id: primary.segments[index + 1].end_bi_id,
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
  const validators = []
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

  const groups = []
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
  const winner = groups[0]
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
  ))[0]
  let confirmedChain = null
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
      const next = suffix[1]
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
  const candidateGroups = []
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
  const candidate = candidateWinner?.count >= 2 && candidateWinner.count * 2 > derivedValidators.length
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

// === Chan Theory: Center (Zhongshu) Detection from confirmed segments ===
function buildCenters(components, options = {}) {
  if (components.length < 3) return []
  const componentLevel = options.componentLevel === 'bi' ? 'bi' : 'segment'
  const centers = []
  // A trusted anchor is the start of the already-confirmed entry segment.
  // Keep that leading segment outside the three-segment centre core so an
  // anchored rebuild reproduces the same entry/core identity as the full
  // authoritative history instead of shifting the centre forward by one.
  let i = options.leadingSegmentIsEntry === true ? 1 : 0
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
      component_level: componentLevel,
      entry_component_id: components[i - 1]?.id ?? null,
      start_component_id: initial[0].id,
      end_component_id: initial[2].id,
      departure_component_id: null,
      component_ids: initial.map(item => item.id),
      start_segment_id: initial[0].id,
      end_segment_id: initial[2].id,
      segment_ids: initial.map(item => item.id),
      entry_segment_id: componentLevel === 'segment' ? (components[i - 1]?.id ?? null) : null,
      departure_segment_id: null,
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
        center.departure_component_id = item.id
        if (componentLevel === 'segment') center.departure_segment_id = item.id
        break
      }
      center.fluctuation_low = Math.min(center.fluctuation_low, low)
      center.fluctuation_high = Math.max(center.fluctuation_high, high)
      center.segment_ids.push(item.id)
      center.component_ids.push(item.id)
      center.end_segment_id = item.id
      center.end_component_id = item.id
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

function summarizeBiCenter(center, timeframe, bis = [], rates = []) {
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
      ? Number(rates[startIndex].time_utc_msc) : null,
    end_time_utc_msc: Number.isFinite(endIndex) && Number.isFinite(Number(rates[endIndex]?.time_utc_msc))
      ? Number(rates[endIndex].time_utc_msc) : null,
  }
}

function segmentLocation(segment, bis, rates = []) {
  if (!segment) return null
  const price = value => Number.isFinite(Number(value)) ? round5(Number(value)) : null
  const segmentBis = (segment.bi_ids || []).map(id => bis.find(b => b.id === id)).filter(Boolean)
  const startIndex = Number.isFinite(Number(segment.raw_start_idx))
    ? Number(segment.raw_start_idx)
    : segmentBis.length ? Math.min(...segmentBis.map(b => Number(b.raw_start_idx))) : null
  const endIndex = segment.endpoint_raw_idx != null && Number.isFinite(Number(segment.endpoint_raw_idx))
    ? Number(segment.endpoint_raw_idx)
    : Number.isFinite(Number(segment.raw_end_idx))
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

  // Compare the center's explicit entry/departure references. Inferring these
  // as id +/- 1 fails after resync, discontinuities, and for the first center
  // in a retained window.
  const departureId = center => center.departure_segment_id
    ?? center.closed_by_segment_id
    ?? (center.component_level ? null : (center.end_segment_id || 0) + 1)
  const eligibleCenters = centers.filter(c => current.id === departureId(c))
  if (eligibleCenters.length === 0) return emptyResult('not_after_center')
  const lastCenter = eligibleCenters[eligibleCenters.length - 1]
  const entrySegmentId = lastCenter.entry_segment_id
    ?? (lastCenter.component_level ? null : lastCenter.start_segment_id - 1)
  const prev = validSegs.find(s => s.id === entrySegmentId)
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
  if (!formingSegment) return emptyDivergence('no_forming_segment')
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

function summarizeCenter(center, timeframe, segments = [], bis = [], rates = []) {
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
  const validSegments = segments.filter(segment => !segment.weak && (
    (Array.isArray(segment.bi_ids) && segment.bi_ids.length >= MIN_BIS_PER_SEGMENT)
    || Number(segment.bi_count) >= MIN_BIS_PER_SEGMENT
  ))
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
    if (latestCenter.status !== 'closed' && Number(latestPrice) > latestCenter.zh) {
      return {
        state: 'upward_breakout_pending', direction: 'up', phase: 'breakout_candidate', reversal_bias: 'none',
        confidence: 'low', reason: 'price_above_unclosed_center',
        center_id: latestCenter.id, segment_id: latestSegment.id,
      }
    }
    if (latestCenter.status !== 'closed' && Number(latestPrice) < latestCenter.zl) {
      return {
        state: 'downward_breakout_pending', direction: 'down', phase: 'breakout_candidate', reversal_bias: 'none',
        confidence: 'low', reason: 'price_below_unclosed_center',
        center_id: latestCenter.id, segment_id: latestSegment.id,
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

function detectChanEntryCandidates(segments, centers, divergence, recentDivergences, bis, rates, reliability, structureTimeKeyReliable, activeBiRunId = null) {
  const validSegments = segments.filter(segment => !segment.weak && Array.isArray(segment.bi_ids) && segment.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  const latestSegment = validSegments.at(-1)
  if (!latestSegment) return []
  const locatedSegments = validSegments.map(segment => ({
    segment,
    location:summarizeSegment(segment, bis, rates),
  }))
  const segmentByStableId = new Map(locatedSegments
    .filter(item => item.location?.stable_id)
    .map(item => [item.location.stable_id, item.segment]))
  const segmentIndexByStableId = new Map(locatedSegments
    .filter(item => item.location?.stable_id)
    .map((item, index) => [item.location.stable_id, index]))
  const locatedCenters = centers.map(center => ({
    center,
    location:summarizeCenter(center, null, validSegments, bis, rates),
  }))
  const stableSegmentId = evidence => evidence?.stable_id || null
  const resolveEvidenceSegment = evidence => {
    const stableId = stableSegmentId(evidence)
    return stableId ? segmentByStableId.get(stableId) || null : null
  }
  const resolveEvidenceCenter = evidence => {
    const entryStableId = stableSegmentId(evidence?.entry_segment)
    const departureStableId = stableSegmentId(evidence?.departure_segment)
    if (!entryStableId || !departureStableId) return null
    return locatedCenters.find(item => (
      item.location?.entry_segment_stable_id === entryStableId
      && item.location?.departure_segment_stable_id === departureStableId
    ))?.center || null
  }
  const structurallyUsable = reliability !== 'low' && structureTimeKeyReliable === true
  const confidence = preferred => capStructureConfidence(reliability, preferred)
  const results = []
  const add = ({ type, side, source, segment, center = null, referencePrice, invalidationPrice, preferredConfidence = 'medium' }) => {
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
    && latestSegmentIndex >= bottomDepartureIndex + 2
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
    && latestSegmentIndex >= topDepartureIndex + 2
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

function emptyDivergence(reason = 'structure_unavailable') {
  return divergenceResult(reason)
}

function emptyChanResult(overrides = {}) {
  return {
    algorithm_version: CHAN_ALGORITHM_VERSION,
    rule_profile: CHAN_RULE_PROFILE,
    center_level: 'segment',
    status: 'insufficient_klines',
    reliability: 'low',
    requested_history_count: 0,
    received_history_count: 0,
    history_sufficient: false,
    requested_closed_history_count: 0,
    closed_history_sufficient: false,
    clock_status: 'unknown',
    clock_trust_level: 'untrusted',
    time_location_reliable: false,
    structure_time_key_reliable: false,
    structure_time_key_basis: 'untrusted',
    structure_topology_reliable: false,
    cache_gap_refilled: false,
    cache_internal_gap_unresolved: false,
    window_resynced: false,
    window_stable: false,
    segment_support_count: 0,
    segment_validator_count: 0,
    segment_support_ratio: 0,
    segment_pair_support: [],
    cross_window_support_count: 0,
    cross_window_validator_count: 0,
    cross_window_support_ratio: 0,
    structure_anchor: {
      requested_time_utc_msc: null,
      matched: false,
      recommended_time_utc_msc: null,
      last_confirmed_segment_time_utc_msc: null,
      full_window_authoritative: false,
      temporal_identity_stable: false,
      temporal_closed_bar_support: 0,
      temporal_closed_bar_validator_count: 0,
      bootstrap_state: 'unavailable',
    },
    window_start_time_utc_msc: null,
    window_end_time_utc_msc: null,
    raw_bar_count: 0,
    latest_price: null,
    closed_bar_count: 0,
    processed_bar_count: 0,
    fractal_count: 0,
    bi_count: 0,
    active_bi_count: 0,
    bi_run_count: 0,
    active_bi_run_id: null,
    bi_discontinuity_count: 0,
    last_bi_discontinuity: null,
    segment_count: 0,
    center_count: 0,
    bi_center_count: 0,
    confirmed_structure_age_bars: null,
    // A confirmed segment has no fixed bar-count expiry. Keep this field for
    // consumers of the previous schema, but make its diagnostic-only meaning
    // explicit instead of exposing the removed 120-bar validity threshold.
    confirmed_structure_max_age_bars: null,
    confirmed_structure_age_semantics: 'diagnostic_only_no_expiry',
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
    latest_bi_center: null,
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
function computeChanWindow(rates, timeframe, macdHist, options = {}) {
  const warnings = []
  const dataQuality = options.dataQuality && typeof options.dataQuality === 'object' ? options.dataQuality : null
  const requestedHistoryCount = Number(options.requestedHistoryCount) || rates?.length || 0
  const historySufficient = Array.isArray(rates) && rates.length >= requestedHistoryCount
  if (!historySufficient) warnings.push('history_bars_below_requested')
  const lastBarClosed = dataQuality?.last_bar_closed === true
  const closedRates = Array.isArray(rates) ? (lastBarClosed ? rates : rates.slice(0, -1)) : []
  const latest = parseFloat(rates?.at?.(-1)?.close)
  const windowStartTimeUtcMs = Number(closedRates[0]?.time_utc_msc || rates?.[0]?.time_utc_msc) || null
  const windowEndTimeUtcMs = Number(closedRates.at(-1)?.time_utc_msc || rates?.at?.(-1)?.time_utc_msc) || null
  const requestedClosedHistoryCount = Math.max(requestedHistoryCount - (lastBarClosed ? 0 : 1), 0)
  const closedHistorySufficient = closedRates.length >= requestedClosedHistoryCount
  if (!closedHistorySufficient && historySufficient) warnings.push('closed_history_bars_below_requested')
  const utcTimes = closedRates.map(rate => Number(rate?.time_utc_msc))
  const utcLocationComplete = closedRates.length > 0 && utcTimes.every(value => Number.isFinite(value) && value > 0)
  const utcSequenceMonotonic = utcLocationComplete && utcTimes.every((value, index) => index === 0 || value > utcTimes[index - 1])
  const clockStatus = String(dataQuality?.clock_status || rates?.at?.(-1)?.clock_status || 'unknown')
  const platform = String(dataQuality?.platform || rates?.at?.(-1)?.platform || '').trim().toLowerCase()
  const sourceId = Number(dataQuality?.source_id)
  const timezoneOffsetMinutes = Number(dataQuality?.timezone_offset_minutes)
  const clockSampleAgeMs = Number(dataQuality?.clock_sample_age_ms)
  const sourceIdentityReliable = dataQuality == null || (
    Number.isInteger(sourceId) && sourceId > 0 && (platform === 'mt4' || platform === 'mt5'))
  const mt4OffsetValid = Number.isInteger(timezoneOffsetMinutes)
    && timezoneOffsetMinutes >= -14 * 60 && timezoneOffsetMinutes <= 14 * 60
    && timezoneOffsetMinutes % 15 === 0
  const mt4ClockFresh = clockStatus === 'mt4_current_offset'
    && Number.isFinite(clockSampleAgeMs) && clockSampleAgeMs >= 0
    && clockSampleAgeMs <= MT4_CLOCK_SAMPLE_MAX_AGE_MS
  const mt4HistoricalOffsetUnverified = platform === 'mt4'
    && (clockStatus === 'mt4_current_offset' || clockStatus === 'mt4_cached_offset')
  const clockStatusTrusted = clockStatus === 'verified'
  const clockTrustLevel = clockStatus === 'verified'
    ? 'verified'
    : mt4HistoricalOffsetUnverified ? 'derived_unverified_history' : 'untrusted'
  const timeLocationReliable = dataQuality == null || (sourceIdentityReliable
    && clockStatusTrusted && utcLocationComplete && utcSequenceMonotonic)
  // MT4 only exposes historical broker-server timestamps.  Applying the
  // current server offset cannot prove an old candle's exact UTC instant
  // across a DST boundary, but it is still a deterministic structure key
  // while the market-data source remains scoped by account/server/offset.
  // Keep that weaker guarantee separate from time_location_reliable so price
  // structure can bootstrap without presenting an approximate UTC as exact.
  const mt4OffsetScopedStructureKey = platform === 'mt4' && sourceIdentityReliable
    && mt4OffsetValid && mt4ClockFresh && utcLocationComplete && utcSequenceMonotonic
  const structureTimeKeyReliable = dataQuality == null
    || (sourceIdentityReliable && utcLocationComplete && utcSequenceMonotonic
      && (clockStatusTrusted || mt4OffsetScopedStructureKey))
  const structureTimeKeyBasis = dataQuality == null || clockStatus === 'verified'
    ? 'utc_verified'
    : mt4OffsetScopedStructureKey ? 'mt4_current_offset_source_scoped' : 'untrusted'
  if (dataQuality && !clockStatusTrusted) warnings.push('market_clock_unverified')
  if (dataQuality && mt4HistoricalOffsetUnverified) warnings.push('mt4_historical_offset_unverified')
  if (dataQuality && !utcLocationComplete) warnings.push('utc_time_location_incomplete')
  if (dataQuality && utcLocationComplete && !utcSequenceMonotonic) warnings.push('utc_time_sequence_invalid')
  const cacheInternalGapUnresolved = Boolean(dataQuality?.cache_internal_gap_unresolved)
  if (cacheInternalGapUnresolved) warnings.push('cache_internal_gap_unresolved')
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
      clock_trust_level: clockTrustLevel,
      time_location_reliable: timeLocationReliable,
      structure_time_key_reliable: structureTimeKeyReliable,
      structure_time_key_basis: structureTimeKeyBasis,
      cache_gap_refilled: Boolean(dataQuality?.cache_gap_refilled),
      cache_internal_gap_unresolved: cacheInternalGapUnresolved,
      window_start_time_utc_msc: windowStartTimeUtcMs,
      window_end_time_utc_msc: windowEndTimeUtcMs,
      raw_bar_count: rates?.length || 0,
      latest_price: Number.isFinite(latest) ? round5(latest) : null,
      closed_bar_count: closedRates.length,
      divergence: emptyDivergence('insufficient_klines'),
      warnings: [...warnings, 'raw_bars_too_few'],
    })
  }
  const bars = normalizeBarsForChan(closedRates)
  if (bars.length < 10) warnings.push('processed_bars_too_few')
  const fractals = options.fractalsForTest || detectFractals(bars)
  const { bis: allBis, runs: biRuns, invalidCount, activeRunId, activePivot, lastDiscontinuity } = buildBis(fractals, bars)
  const confirmedBiRuns = biRuns
    .map(run => run.filter(b => b.confirmed !== false))
    .filter(run => run.length > 0)
  const activeConfirmedBis = confirmedBiRuns.find(run => run[0]?.run_id === activeRunId) || []
  const developingBi = buildDevelopingBi(activePivot, rates)
  if (activeConfirmedBis.length < 3) {
    warnings.push('insufficient_confirmed_bis')
    const lastBi = activeConfirmedBis.at(-1) || null
    return emptyChanResult({
      status: 'insufficient_bis',
      requested_history_count: requestedHistoryCount,
      received_history_count: rates.length,
      history_sufficient: historySufficient,
      requested_closed_history_count: requestedClosedHistoryCount,
      closed_history_sufficient: closedHistorySufficient,
      clock_status: clockStatus,
      clock_trust_level: clockTrustLevel,
      time_location_reliable: timeLocationReliable,
      structure_time_key_reliable: structureTimeKeyReliable,
      structure_time_key_basis: structureTimeKeyBasis,
      cache_gap_refilled: Boolean(dataQuality?.cache_gap_refilled),
      cache_internal_gap_unresolved: cacheInternalGapUnresolved,
      window_start_time_utc_msc: windowStartTimeUtcMs,
      window_end_time_utc_msc: windowEndTimeUtcMs,
      raw_bar_count: rates.length,
      latest_price: Number.isFinite(latest) ? round5(latest) : null,
      closed_bar_count: closedRates.length,
      processed_bar_count: bars.length,
      fractal_count: fractals.length,
      bi_count: allBis.length,
      active_bi_count: activeConfirmedBis.length,
      bi_run_count: biRuns.length,
      active_bi_run_id: activeRunId,
      bi_discontinuity_count: invalidCount,
      last_bi_discontinuity: lastDiscontinuity,
      current_bi: lastBi ? { id: lastBi.id, dir: lastBi.dir, start_price: round5(lastBi.start_price), end_price: round5(lastBi.end_price), confirmed: lastBi.confirmed } : null,
      developing_bi: developingBi,
      recent_bis: activeConfirmedBis.slice(-FEED_LAST_N_BIS).map(b => ({ id: b.id, dir: b.dir, start_price: round5(b.start_price), end_price: round5(b.end_price), confirmed: b.confirmed })),
      divergence: emptyDivergence('insufficient_bis'),
      warnings,
    })
  }
  const trustedStructureAnchor = options.trustedStructureAnchor && typeof options.trustedStructureAnchor === 'object'
    ? options.trustedStructureAnchor : {}
  const requestedStructureAnchor = Number(
    trustedStructureAnchor.anchor_time_utc_msc ?? options.trustedStructureAnchorUtcMs)
  const requestedAnchorCoreStableId = String(trustedStructureAnchor.bootstrap_core_stable_id || '').trim()
  const requestedAnchorEntryStableId = String(trustedStructureAnchor.bootstrap_entry_segment_stable_id || '').trim()
  const requestedAnchorLastConfirmedTime = Number(trustedStructureAnchor.last_confirmed_segment_time_utc_msc)
  const requestedAnchorIdentityComplete = Boolean(requestedAnchorCoreStableId && requestedAnchorEntryStableId
    && Number.isFinite(requestedAnchorLastConfirmedTime) && requestedAnchorLastConfirmedTime > 0)
  const anchoredBiIndex = Number.isFinite(requestedStructureAnchor) && requestedStructureAnchor > 0
    ? activeConfirmedBis.findIndex(bi => Number(closedRates[Number(bi.raw_start_idx)]?.time_utc_msc) === requestedStructureAnchor)
    : -1
  const structureAnchorTimeMatched = anchoredBiIndex >= 0
  if (Number.isFinite(requestedStructureAnchor) && requestedStructureAnchor > 0 && !structureAnchorTimeMatched) {
    warnings.push('structure_anchor_not_found')
  }
  const segmentBis = structureAnchorTimeMatched ? activeConfirmedBis.slice(anchoredBiIndex) : activeConfirmedBis
  const {
    segments, candidate, resynced, stable: windowStable,
    supportCount: segmentSupportCount = 0,
    validatorCount: segmentValidatorCount = 0,
    supportRatio: segmentSupportRatio = 0,
    pairSupport: segmentPairSupport = [],
    historicalSegmentRuns = [],
  } = buildSegments(segmentBis, { trustedStart: structureAnchorTimeMatched })
  const windowResynced = structureAnchorTimeMatched || resynced
  if (!windowResynced) warnings.push('segment_window_not_resynced')
  else if (!windowStable) warnings.push('segment_window_unstable')
  else if (segmentValidatorCount > 0 && segmentSupportRatio < 1) warnings.push('segment_consensus_partial')
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  if (validSegs.length === 0) warnings.push('segments_not_confirmed')
  const centers = buildCenters(validSegs, {
    componentLevel:'segment',
    leadingSegmentIsEntry:structureAnchorTimeMatched,
  })
  const biCenters = buildCenters(activeConfirmedBis, { componentLevel: 'bi' })
  if (centers.length === 0) warnings.push('no_valid_center')
  const latestCenter = centers.length > 0 ? centers[centers.length - 1] : null
  const centerEntryUnconfirmed = Boolean(latestCenter && latestCenter.entry_segment_id == null)
  const centerEntryConfirmed = Boolean(latestCenter && latestCenter.entry_segment_id != null)
  if (centerEntryUnconfirmed) warnings.push('center_entry_unconfirmed')
  const lastSeg = validSegs.length > 0 ? validSegs[validSegs.length - 1] : null
  const lastBi = activeConfirmedBis.at(-1) || null
  const lastSegmentEndIndex = Number(lastSeg?.raw_end_idx)
  const confirmedStructureAgeBars = Number.isFinite(lastSegmentEndIndex)
    ? Math.max(0, closedRates.length - 1 - lastSegmentEndIndex)
    : null
  // A Chan segment may extend for an arbitrary number of bars until it is
  // broken by an opposite segment. Age is retained only as diagnostics; it
  // must not invalidate the current structure or its trend evidence.
  const activeCenter = latestCenter && latestCenter.status !== 'closed'
    && latest >= latestCenter.zl && latest <= latestCenter.zh ? latestCenter : null
  let priceVsCenter = 'none'
  if (latestCenter) {
    if (latest > latestCenter.zh) priceVsCenter = 'above'
    else if (latest < latestCenter.zl) priceVsCenter = 'below'
    else priceVsCenter = 'inside'
  }
  const divergence = {
    ...detectDivergence(validSegs, allBis, closedMacdHist, centers, closedRates),
    bi_run_id: activeRunId,
  }
  const historicalDivergenceMap = new Map()
  const currentRunDivergenceMap = new Map()
  const priorHistoricalSegmentRuns = []
  const recordHistoricalDivergence = (item, biRunId, currentRun = false) => {
    const tagged = { ...item, bi_run_id: biRunId }
    const key = tagged.divergence_key || `${tagged.type}:${tagged.departure_segment_id}:${tagged.departure_segment?.end_index}`
    historicalDivergenceMap.set(key, tagged)
    if (currentRun) currentRunDivergenceMap.set(key, tagged)
  }
  for (const runBis of confirmedBiRuns.filter(run => run !== activeConfirmedBis)) {
    const result = buildSegments(runBis, { trustedStart: false })
    if (!result.stable || result.segments.length < 2) continue
    priorHistoricalSegmentRuns.push(result.segments)
    const biRunId = runBis[0]?.run_id ?? null
    const runCenters = buildCenters(result.segments)
    for (const item of detectDivergenceHistory(result.segments, allBis, closedMacdHist, runCenters, closedRates)) {
      recordHistoricalDivergence(item, biRunId, false)
    }
  }
  for (const run of historicalSegmentRuns) {
    const runCenters = buildCenters(run)
    for (const item of detectDivergenceHistory(run, allBis, closedMacdHist, runCenters, closedRates)) {
      recordHistoricalDivergence(item, activeRunId, true)
    }
  }
  if (divergence.type === 'top' || divergence.type === 'bottom') {
    const key = divergence.divergence_key || `${divergence.type}:${divergence.departure_segment_id}:${divergence.departure_segment?.end_index}`
    historicalDivergenceMap.set(key, divergence)
    currentRunDivergenceMap.set(key, divergence)
  }
  const recentDivergences = [...historicalDivergenceMap.values()]
    .sort((a, b) => Number(a.departure_segment?.end_index || 0) - Number(b.departure_segment?.end_index || 0))
    .slice(-FEED_LAST_N_DIVERGENCES)
  const currentRunRecentDivergences = [...currentRunDivergenceMap.values()]
    .sort((a, b) => Number(a.departure_segment?.end_index || 0) - Number(b.departure_segment?.end_index || 0))
    .slice(-FEED_LAST_N_DIVERGENCES)
  const formingSegment = buildFormingSegment(candidate, allBis, (lastSeg?.id || 0) + 1)
  const formingDivergence = detectFormingDivergence(candidate, validSegs, allBis, closedMacdHist, centers, closedRates)
  if (divergence.type !== 'none') {
    // ok
  } else if (divergence.reason === 'invalid_macd_area' || divergence.reason === 'no_macd_data') {
    warnings.push('divergence_skipped_invalid_macd')
  }

  const lastSegmentRawIndex = Number(lastSeg?.raw_end_idx)
  const lastConfirmedSegmentTime = Number.isFinite(lastSegmentRawIndex)
    ? Number(closedRates[lastSegmentRawIndex]?.time_utc_msc) : null
  const confirmedSegmentSummaries = validSegs.map(segment => summarizeSegment(segment, allBis, closedRates))
  const confirmedCenterSummaries = centers.map(center => summarizeCenter(center, timeframe, validSegs, allBis, closedRates))
  const latestCenterSummary = confirmedCenterSummaries.at(-1) || null
  const requestedIdentityCenter = requestedAnchorIdentityComplete
    ? confirmedCenterSummaries.find(center => (
      center.core_stable_id === requestedAnchorCoreStableId
      && center.entry_segment_stable_id === requestedAnchorEntryStableId
      && Number(center.entry_segment_start_time_utc_msc) === requestedStructureAnchor
    )) || null
    : null
  const structureAnchorIdentityMatched = Boolean(requestedIdentityCenter)
  const structureAnchorLastConfirmedNotRegressed = requestedAnchorIdentityComplete
    && Number.isFinite(lastConfirmedSegmentTime)
    && lastConfirmedSegmentTime >= requestedAnchorLastConfirmedTime
  const structureAnchorMatched = structureAnchorTimeMatched
    && structureAnchorIdentityMatched && structureAnchorLastConfirmedNotRegressed
  if (Number.isFinite(requestedStructureAnchor) && requestedStructureAnchor > 0) {
    if (!requestedAnchorIdentityComplete) warnings.push('structure_anchor_identity_missing')
    else if (structureAnchorTimeMatched && !structureAnchorIdentityMatched) warnings.push('structure_anchor_identity_mismatch')
    else if (structureAnchorIdentityMatched && !structureAnchorLastConfirmedNotRegressed) {
      warnings.push('structure_anchor_last_segment_regressed')
    }
  }

  let reliability = 'low'
  if (cacheInternalGapUnresolved) reliability = 'low'
  else if (historySufficient && closedHistorySufficient && timeLocationReliable && validSegs.length >= 2 && centers.length > 0 && warnings.length === 0) reliability = 'high'
  else if (historySufficient && closedHistorySufficient && validSegs.length > 0) reliability = 'medium'

  let status = 'ok'
  if (validSegs.length === 0 && activeConfirmedBis.length >= 3) status = 'unreliable_segments'
  else if (validSegs.length > 0 && centers.length === 0) status = 'partial'
  else if (warnings.length > 0) status = 'partial'

  const trendState = classifyChanTrend(validSegs, centers, latest, divergence, reliability)
  const entryCandidates = detectChanEntryCandidates(validSegs, centers, divergence, currentRunRecentDivergences,
    allBis, closedRates, reliability, structureTimeKeyReliable, activeRunId)
  const entrySegment = latestCenter ? validSegs.find(segment => segment.id === latestCenter.entry_segment_id) || null : null
  const anchorRawIndex = Number(entrySegment?.raw_start_idx)
  const recommendedAnchorTime = centerEntryConfirmed && windowStable && structureTimeKeyReliable
    && !cacheInternalGapUnresolved && Number.isFinite(anchorRawIndex)
    ? Number(closedRates[anchorRawIndex]?.time_utc_msc) : null
  const bootstrapIdentity = latestCenterSummary?.core_stable_id && latestCenterSummary?.entry_segment_stable_id
    ? JSON.stringify({
      core_stable_id:latestCenterSummary.core_stable_id,
      entry_segment_stable_id:latestCenterSummary.entry_segment_stable_id,
    })
    : null

  if (DEBUG_CHAN) console.log(`[Chan] ${timeframe}: status=${status} reliability=${reliability} raw=${rates.length} processed=${bars.length} fractals=${fractals.length} bis=${allBis.length} active_bis=${activeConfirmedBis.length} runs=${biRuns.length} segs=${validSegs.length} centers=${centers.length} support=${segmentSupportCount}/${segmentValidatorCount} warnings=${warnings.join(',') || 'none'}`)
  const result = {
    algorithm_version: CHAN_ALGORITHM_VERSION,
    rule_profile: CHAN_RULE_PROFILE,
    center_level: 'segment',
    status, reliability,
    requested_history_count: requestedHistoryCount,
    received_history_count: rates.length,
    history_sufficient: historySufficient,
    requested_closed_history_count: requestedClosedHistoryCount,
    closed_history_sufficient: closedHistorySufficient,
    clock_status: clockStatus,
    clock_trust_level: clockTrustLevel,
    time_location_reliable: timeLocationReliable,
    structure_time_key_reliable: structureTimeKeyReliable,
    structure_time_key_basis: structureTimeKeyBasis,
    structure_topology_reliable:Boolean(windowStable && structureTimeKeyReliable
      && !cacheInternalGapUnresolved
      && validSegs.length >= 2 && centers.length > 0),
    cache_gap_refilled: Boolean(dataQuality?.cache_gap_refilled),
    cache_internal_gap_unresolved: cacheInternalGapUnresolved,
    window_resynced: windowResynced,
    window_stable: windowStable,
    segment_support_count: segmentSupportCount,
    segment_validator_count: segmentValidatorCount,
    segment_support_ratio: round3(segmentSupportRatio),
    segment_pair_support: segmentPairSupport,
    structure_anchor: {
      requested_time_utc_msc: Number.isFinite(requestedStructureAnchor) && requestedStructureAnchor > 0 ? requestedStructureAnchor : null,
      matched: structureAnchorMatched,
      time_matched:structureAnchorTimeMatched,
      identity_matched:structureAnchorIdentityMatched,
      last_confirmed_segment_not_regressed:structureAnchorLastConfirmedNotRegressed,
      requested_core_stable_id:requestedAnchorCoreStableId || null,
      requested_entry_segment_stable_id:requestedAnchorEntryStableId || null,
      requested_last_confirmed_segment_time_utc_msc:Number.isFinite(requestedAnchorLastConfirmedTime)
        && requestedAnchorLastConfirmedTime > 0 ? requestedAnchorLastConfirmedTime : null,
      recommended_time_utc_msc: Number.isFinite(recommendedAnchorTime) && recommendedAnchorTime > 0 ? recommendedAnchorTime : null,
      last_confirmed_segment_time_utc_msc: Number.isFinite(lastConfirmedSegmentTime) && lastConfirmedSegmentTime > 0 ? lastConfirmedSegmentTime : null,
      bootstrap_identity: bootstrapIdentity,
      bootstrap_core_stable_id: latestCenterSummary?.core_stable_id || null,
      bootstrap_entry_segment_stable_id: latestCenterSummary?.entry_segment_stable_id || null,
      bootstrap_entry_start_time_utc_msc: Number(latestCenterSummary?.entry_segment_start_time_utc_msc) || null,
      bootstrap_observation_time_utc_msc: Number(windowEndTimeUtcMs) || null,
      full_window_authoritative: false,
      temporal_identity_stable: false,
      temporal_closed_bar_support: 0,
      temporal_closed_bar_validator_count: 0,
      bootstrap_state: bootstrapIdentity ? 'candidate' : 'unavailable',
      current_result_usable:structureAnchorMatched,
    },
    window_start_time_utc_msc: windowStartTimeUtcMs,
    window_end_time_utc_msc: windowEndTimeUtcMs,
    raw_bar_count: rates.length,
    latest_price: Number.isFinite(latest) ? round5(latest) : null,
    closed_bar_count: closedRates.length, processed_bar_count: bars.length,
    fractal_count: fractals.length,
    bi_count: allBis.length,
    active_bi_count: activeConfirmedBis.length,
    bi_run_count: biRuns.length,
    active_bi_run_id: activeRunId,
    bi_discontinuity_count: invalidCount,
    last_bi_discontinuity: lastDiscontinuity,
    segment_count: validSegs.length,
    center_count: centers.length,
    bi_center_count: biCenters.length,
    confirmed_structure_age_bars: confirmedStructureAgeBars,
    confirmed_structure_max_age_bars: null,
    confirmed_structure_age_semantics: 'diagnostic_only_no_expiry',
    historical_segment_run_count: priorHistoricalSegmentRuns.length + historicalSegmentRuns.length,
    historical_segment_count: [...priorHistoricalSegmentRuns, ...historicalSegmentRuns].reduce((sum, run) => sum + run.length, 0),
    current_bi: lastBi ? { id: lastBi.id, dir: lastBi.dir, start_price: round5(lastBi.start_price), end_price: round5(lastBi.end_price), confirmed: lastBi.confirmed } : null,
    developing_bi: developingBi,
    recent_bis: activeConfirmedBis.slice(-FEED_LAST_N_BIS).map(b => ({ id: b.id, dir: b.dir, start_price: round5(b.start_price), end_price: round5(b.end_price), confirmed: b.confirmed })),
    current_segment: confirmedSegmentSummaries.at(-1) || null,
    prev_segment: confirmedSegmentSummaries.at(-2) || null,
    candidate_segment: formingSegment ? { ...summarizeSegment(formingSegment, allBis, closedRates), confirmed: false } : candidate ? { dir: candidate.dir, bi_count: candidate.bi_ids.length, start_price: round5(candidate.start_price), end_price: round5(candidate.end_price), confirmed: false } : null,
    current_center:confirmedCenterSummaries.at(-1) || null,
    active_center:activeCenter ? confirmedCenterSummaries.find(center => center.id === activeCenter.id) || null : null,
    latest_center:confirmedCenterSummaries.at(-1) || null,
    latest_bi_center: summarizeBiCenter(biCenters.at(-1), timeframe, activeConfirmedBis, closedRates),
    price_vs_center: priceVsCenter,
    divergence,
    forming_divergence: formingDivergence,
    recent_divergences: recentDivergences,
    trend_state: trendState,
    entry_candidates: entryCandidates,
    warnings,
  }
  Object.defineProperty(result, '_confirmed_segments', {
    value:confirmedSegmentSummaries,
    enumerable:false,
  })
  Object.defineProperty(result, '_confirmed_centers', {
    value:confirmedCenterSummaries,
    enumerable:false,
  })
  Object.defineProperty(result, '_closed_rate_times_utc_msc', {
    value:utcTimes,
    enumerable:false,
  })
  return result
}

function stableTerminalStructureKey(result) {
  const current = result?.current_segment?.stable_id
  const previous = result?.prev_segment?.stable_id
  const hasWithinWindowEvidence = result?.window_stable || Number(result?.segment_support_count) >= 1
  return hasWithinWindowEvidence && result?.segment_count >= 2 && current && previous ? `${previous}|${current}` : null
}

function windowCanObserve(candidate, evidenceStartUtcMs) {
  const windowStart = Number(candidate?.window_start_time_utc_msc)
  const evidenceStart = Number(evidenceStartUtcMs)
  return !Number.isFinite(windowStart) || windowStart <= 0
    || !Number.isFinite(evidenceStart) || evidenceStart <= 0
    || windowStart <= evidenceStart
}

function windowHasEvidenceContext(candidate, evidenceStartUtcMs, minimumBars = 0) {
  if (!windowCanObserve(candidate, evidenceStartUtcMs)) return false
  if (!(Number(minimumBars) > 0)) return true
  const times = Array.isArray(candidate?._closed_rate_times_utc_msc)
    ? candidate._closed_rate_times_utc_msc : []
  const evidenceStart = Number(evidenceStartUtcMs)
  if (!times.length || !Number.isFinite(evidenceStart) || evidenceStart <= 0) return false
  let low = 0
  let high = times.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (Number(times[middle]) < evidenceStart) low = middle + 1
    else high = middle
  }
  return low >= Number(minimumBars)
}

function terminalEvidenceStart(candidate) {
  const utcMs = Number(candidate?.prev_segment?.start_time_utc_msc)
  if (Number.isFinite(utcMs) && utcMs > 0) return utcMs
  const fallback = Number(candidate?.prev_segment?.start_time)
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null
}

function confirmedSegmentEvidence(candidate) {
  if (Array.isArray(candidate?._confirmed_segments) && candidate._confirmed_segments.length > 0) {
    return candidate._confirmed_segments
  }
  return [candidate?.prev_segment, candidate?.current_segment].filter(Boolean)
}

function buildCrossWindowConsensusSegments(winnerCandidates, allCandidates = winnerCandidates) {
  const representative = [...winnerCandidates].sort((a, b) => (
    confirmedSegmentEvidence(b).length - confirmedSegmentEvidence(a).length
    || Number(b.raw_bar_count || 0) - Number(a.raw_bar_count || 0)
  ))[0]
  const segments = confirmedSegmentEvidence(representative)
  if (segments.length < 2) return { segments:[], pairSupport:[] }
  let confirmedChain = null
  for (let start = 0; start <= segments.length - 2; start++) {
    const chain = segments.slice(start)
    const evidenceStart = Number(chain[0]?.start_time_utc_msc) || null
    const eligible = allCandidates.filter(candidate => windowCanObserve(candidate, evidenceStart))
    const support = eligible.filter(candidate => candidateEndsWithSegmentChain(candidate, chain)).length
    const pairEvidence = chain.slice(0, -1).map((segment, index) => {
      const next = chain[index + 1]
      const pairStart = Number(segment?.start_time_utc_msc) || null
      const pairEligible = allCandidates.filter(candidate => windowCanObserve(candidate, pairStart))
      const pairSupport = pairEligible.filter(candidate => candidateEndsWithSegmentChain(
        candidate, chain.slice(index))).length
      return {
        segment,
        next,
        support:pairSupport,
        eligible:pairEligible.length,
        confirmed:pairSupport >= 2 && pairSupport * 2 > pairEligible.length,
      }
    })
    const wholeChainConfirmed = support >= 2 && support * 2 > eligible.length
    if (wholeChainConfirmed && pairEvidence.every(item => item.confirmed)) {
      confirmedChain = { segments:chain, support, eligible:eligible.length, pairEvidence }
      break
    }
  }
  if (!confirmedChain) return { segments:[], pairSupport:[] }
  return {
    segments:confirmedChain.segments,
    supportCount:confirmedChain.support,
    validatorCount:confirmedChain.eligible,
    pairSupport:confirmedChain.pairEvidence.map(item => ({
      previous_stable_id:item.segment.stable_id,
      current_stable_id:item.next.stable_id,
      support_count:item.support,
      validator_count:item.eligible,
    })),
  }
}

function candidateEndsWithSegmentChain(candidate, chain) {
  if (!chain.length) return true
  const candidateIds = confirmedSegmentEvidence(candidate).map(segment => segment?.stable_id)
  const chainIds = chain.map(segment => segment?.stable_id)
  const start = candidateIds.length - chainIds.length
  return start >= 0 && chainIds.every((id, index) => id && candidateIds[start + index] === id)
}

function summarizeConsensusCenter(center, segments, timeframe, supportCount, validatorCount) {
  if (!center) return null
  const byId = id => segments.find(segment => segment.id === id) || null
  const entry = byId(center.entry_segment_id)
  const start = byId(center.start_segment_id)
  const end = byId(center.end_segment_id)
  const departure = byId(center.departure_segment_id)
  const core = (center.segment_ids || []).slice(0, 3).map(byId)
  const coreStableIds = core.length === 3 && core.every(segment => segment?.stable_id)
    ? core.map(segment => segment.stable_id)
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

function confirmedCenterEvidence(candidate) {
  if (Object.prototype.hasOwnProperty.call(candidate || {}, '_confirmed_centers')) {
    return Array.isArray(candidate?._confirmed_centers) ? candidate._confirmed_centers : []
  }
  return [candidate?.latest_center].filter(Boolean)
}

function centerCoreStableIds(center, candidate = null) {
  const explicit = Array.isArray(center?.core_segment_stable_ids)
    ? center.core_segment_stable_ids.filter(Boolean)
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
  return values.every(Boolean) ? values : []
}

function stableCenterCoreKey(center, candidate = null) {
  const coreStableIds = centerCoreStableIds(center, candidate)
  return coreStableIds.length === 3 ? JSON.stringify(coreStableIds) : null
}

function rebuildConsensusCenterFromCore(coreStableIds, segments) {
  if (!Array.isArray(coreStableIds) || coreStableIds.length !== 3) return null
  const startIndex = segments.findIndex(segment => segment?.stable_id === coreStableIds[0])
  if (startIndex < 0 || startIndex + 2 >= segments.length) return null
  const initial = segments.slice(startIndex, startIndex + 3)
  if (!initial.every((segment, index) => segment?.stable_id === coreStableIds[index])) return null
  const range = segment => {
    const low = Number.isFinite(Number(segment?.low))
      ? Number(segment.low) : Math.min(Number(segment?.start_price), Number(segment?.end_price))
    const high = Number.isFinite(Number(segment?.high))
      ? Number(segment.high) : Math.max(Number(segment?.start_price), Number(segment?.end_price))
    return Number.isFinite(low) && Number.isFinite(high) && low <= high ? [low, high] : null
  }
  const initialRanges = initial.map(range)
  if (initialRanges.some(item => !item)) return null
  const zl = Math.max(...initialRanges.map(item => item[0]))
  const zh = Math.min(...initialRanges.map(item => item[1]))
  if (!(zl < zh)) return null
  let fluctuationLow = Math.min(...initialRanges.map(item => item[0]))
  let fluctuationHigh = Math.max(...initialRanges.map(item => item[1]))
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
      id:null,
      component_level:'segment',
      component_ids:centerSegments.map(segment => segment.id),
      segment_ids:centerSegments.map(segment => segment.id),
      zl,
      zh,
      fluctuation_low:fluctuationLow,
      fluctuation_high:fluctuationHigh,
      start_segment_id:initial[0].id,
      end_segment_id:segments[endIndex].id,
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

function selectConsensusCenters(supportCandidates, allCandidates, segments, timeframe,
  authoritativeCandidate = null, minimumContextBars = 0) {
  const groups = new Map()
  let hadEvidence = allCandidates.some(candidate => confirmedCenterEvidence(candidate).length > 0)
  const authoritativeCenterKeys = new Set(confirmedCenterEvidence(authoritativeCandidate)
    .map(center => stableCenterCoreKey(center, authoritativeCandidate)).filter(Boolean))
  for (const candidate of supportCandidates) {
    const seen = new Set()
    for (const center of confirmedCenterEvidence(candidate)) {
      const key = stableCenterCoreKey(center, candidate)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const group = groups.get(key) || { coreStableIds:JSON.parse(key), entries:[] }
      group.entries.push({ candidate, center })
      groups.set(key, group)
    }
  }
  const supported = []
  for (const group of groups.values()) {
    // Suffix windows may confirm a phase chosen by the complete history, but a
    // truncated window is never allowed to create a different center phase.
    if (!authoritativeCenterKeys.has(JSON.stringify(group.coreStableIds))
      || !group.entries.some(entry => entry.candidate === authoritativeCandidate)) continue
    const firstCoreStableId = group.coreStableIds[0]
    const evidenceSegment = group.entries
      .flatMap(entry => confirmedSegmentEvidence(entry.candidate))
      .find(segment => segment?.stable_id === firstCoreStableId)
    const evidenceStart = Number(evidenceSegment?.start_time_utc_msc) || null
    const eligibleCandidates = allCandidates.filter(candidate => (
      windowHasEvidenceContext(candidate, evidenceStart, minimumContextBars)))
    const eligibleSet = new Set(eligibleCandidates)
    const supportEntries = group.entries.filter(entry => eligibleSet.has(entry.candidate))
    if (supportEntries.length < 2 || supportEntries.length * 2 <= eligibleCandidates.length) continue
    const rebuilt = rebuildConsensusCenterFromCore(group.coreStableIds, segments)
    if (!rebuilt) continue
    supported.push({
      ...rebuilt,
      evidenceStart,
      supportEntries,
      supportCount:supportEntries.length,
      validatorCount:eligibleCandidates.length,
    })
  }
  supported.sort((a, b) => a.startIndex - b.startIndex || b.supportCount - a.supportCount)
  let coherent = []
  let jointSupportCandidates = new Set()
  let sequenceEvidenceStart = null
  for (const option of supported) {
    const previous = coherent.at(-1)
    if (previous) {
      if (previous.departureIndex == null || option.startIndex < previous.departureIndex) {
        coherent = [option]
        jointSupportCandidates = new Set(option.supportEntries.map(entry => entry.candidate))
        sequenceEvidenceStart = option.evidenceStart
        continue
      }
      const optionSupportCandidates = new Set(option.supportEntries.map(entry => entry.candidate))
      const intersection = new Set([...jointSupportCandidates].filter(candidate => optionSupportCandidates.has(candidate)))
      const sequenceEligible = allCandidates.filter(candidate => windowCanObserve(candidate, sequenceEvidenceStart))
      if (intersection.size < 2 || intersection.size * 2 <= sequenceEligible.length) {
        coherent = [option]
        jointSupportCandidates = optionSupportCandidates
        sequenceEvidenceStart = option.evidenceStart
        continue
      }
      jointSupportCandidates = intersection
    } else {
      jointSupportCandidates = new Set(option.supportEntries.map(entry => entry.candidate))
      sequenceEvidenceStart = option.evidenceStart
    }
    coherent.push(option)
  }
  coherent.forEach((option, index) => { option.center.id = index + 1 })
  const centers = coherent.map(option => summarizeConsensusCenter(
    option.center, segments, timeframe, option.supportCount, option.validatorCount))
  const latestOption = coherent.at(-1) || null
  return {
    centers,
    hadEvidence,
    latestSupportCount:latestOption?.supportCount || 0,
    latestValidatorCount:latestOption?.validatorCount || 0,
    latestCandidates:latestOption?.supportEntries.map(entry => entry.candidate) || [],
  }
}

function centerBootstrapIdentity(candidate) {
  const center = candidate?.latest_center || null
  const coreStableId = center?.core_stable_id || null
  const entryStableId = center?.entry_segment_stable_id || null
  const entryStartUtcMs = Number(center?.entry_segment_start_time_utc_msc)
  if (!coreStableId || !entryStableId || !Number.isFinite(entryStartUtcMs) || entryStartUtcMs <= 0) return null
  return {
    key:JSON.stringify({ core_stable_id:coreStableId, entry_segment_stable_id:entryStableId }),
    coreStableId,
    entryStableId,
    entryStartUtcMs,
  }
}

function summarizeTemporalBootstrapEvidence(snapshots = []) {
  const validatorCount = snapshots.length
  const valid = snapshots.map(candidate => {
    const identity = centerBootstrapIdentity(candidate)
    const observationUtcMs = Number(candidate?.structure_anchor?.bootstrap_observation_time_utc_msc
      || candidate?.window_end_time_utc_msc)
    const stableStructureTimeKey = candidate?.structure_time_key_reliable === true
      || (candidate?.structure_time_key_reliable == null && candidate?.time_location_reliable === true)
    const reliable = candidate?.window_stable === true
      && stableStructureTimeKey
      && candidate?.history_sufficient !== false
      && candidate?.closed_history_sufficient !== false
      && candidate?.cache_internal_gap_unresolved !== true
      && candidate?.reliability !== 'low'
      && Number.isFinite(observationUtcMs) && observationUtcMs > 0
    return reliable && identity ? { candidate, identity, observationUtcMs } : null
  }).filter(Boolean)
  const groups = new Map()
  for (const item of valid) {
    const group = groups.get(item.identity.key) || []
    group.push(item)
    groups.set(item.identity.key, group)
  }
  const winner = [...groups.values()].sort((a, b) => b.length - a.length)[0] || []
  const observations = new Set(winner.map(item => item.observationUtcMs))
  const stable = validatorCount === 3 && winner.length === 3 && observations.size === 3
  const identity = stable ? winner[0].identity : null
  return {
    full_window_authoritative:true,
    temporal_identity_stable:stable,
    temporal_closed_bar_support:winner.length,
    temporal_closed_bar_validator_count:validatorCount,
    temporal_core_stable_id:identity?.coreStableId || null,
    temporal_entry_segment_stable_id:identity?.entryStableId || null,
    temporal_entry_start_time_utc_msc:identity?.entryStartUtcMs || null,
    temporal_observation_times_utc_msc:[...observations].sort((a, b) => a - b),
  }
}

function buildFullWindowTemporalEvidence(rates, timeframe, options, primary) {
  const lastBarClosed = options?.dataQuality?.last_bar_closed === true
  const closedRates = Array.isArray(rates) ? (lastBarClosed ? rates.slice() : rates.slice(0, -1)) : []
  if (closedRates.length < MIN_KLINES_FOR_CHAN + 2 || !centerBootstrapIdentity(primary)) {
    return summarizeTemporalBootstrapEvidence([primary, null, null])
  }
  const snapshots = []
  for (const trim of [2, 1]) {
    const snapshotRates = closedRates.slice(0, -trim)
    const snapshotMacd = calculateMacdSeries(snapshotRates.map(rate => Number(rate.close))).histSeries
    snapshots.push(computeChanWindow(snapshotRates, timeframe, snapshotMacd, {
      ...options,
      trustedStructureAnchor:null,
      trustedStructureAnchorUtcMs:null,
      requestedHistoryCount:snapshotRates.length,
      dataQuality:{ ...(options?.dataQuality || {}), last_bar_closed:true },
    }))
  }
  snapshots.push(primary)
  return summarizeTemporalBootstrapEvidence(snapshots)
}

function evaluateCrossWindowBootstrapEvidence(candidates, authoritativeCandidate, temporalEvidence, minimumContextBars = 0) {
  const entryStartUtcMs = Number(temporalEvidence?.temporal_entry_start_time_utc_msc)
  const coreStableId = temporalEvidence?.temporal_core_stable_id || null
  const entryStableId = temporalEvidence?.temporal_entry_segment_stable_id || null
  if (temporalEvidence?.temporal_identity_stable !== true || !coreStableId || !entryStableId
    || !Number.isFinite(entryStartUtcMs) || entryStartUtcMs <= 0) {
    return { stable:false, supportCount:0, validatorCount:0 }
  }
  const authoritativeIdentity = centerBootstrapIdentity(authoritativeCandidate)
  if (authoritativeIdentity?.coreStableId !== coreStableId || authoritativeIdentity?.entryStableId !== entryStableId) {
    return { stable:false, supportCount:0, validatorCount:0 }
  }
  const eligible = candidates.filter(candidate => (
    windowHasEvidenceContext(candidate, entryStartUtcMs, minimumContextBars)))
  const supporters = eligible.filter(candidate => confirmedCenterEvidence(candidate).some(center => (
    (center?.core_stable_id || centerCoreStableIds(center, candidate).join('|')) === coreStableId
      && center?.entry_segment_stable_id === entryStableId
  )))
  return {
    stable:supporters.length >= 2 && supporters.length * 2 > eligible.length,
    supportCount:supporters.length,
    validatorCount:eligible.length,
  }
}

const CONCLUSIVE_DIVERGENCE_NONE_REASONS = new Set([
  'macd_no_divergence', 'no_price_extreme_break', 'not_after_center',
])
const CONCLUSIVE_FORMING_NONE_REASONS = new Set([
  ...CONCLUSIVE_DIVERGENCE_NONE_REASONS, 'forming_departure_not_confirmed', 'no_forming_segment',
])

function stableDivergenceEvidenceKey(divergence, forming = false) {
  const hasDirectionalEvidence = divergence?.type === 'top' || divergence?.type === 'bottom'
  if (!hasDirectionalEvidence) {
    const conclusiveReasons = forming ? CONCLUSIVE_FORMING_NONE_REASONS : CONCLUSIVE_DIVERGENCE_NONE_REASONS
    return conclusiveReasons.has(String(divergence?.reason || '')) ? 'none' : null
  }
  if (!forming && divergence?.confirmed !== true) return null
  if (forming && divergence?.confirmed === true) return null
  const entry = divergence.entry_segment?.stable_id
    || (divergence.entry_segment_id == null ? null : `unlocated:${divergence.entry_segment_id}`)
  const departure = divergence.departure_segment?.stable_id
    || (divergence.departure_segment_id == null ? null : `unlocated:${divergence.departure_segment_id}`)
  if (!entry || !departure) return null
  return JSON.stringify({
    type:divergence.type,
    entry,
    departure,
  })
}

function stableFormingCandidateEvidenceKey(candidate) {
  const key = stableDivergenceEvidenceKey(candidate?.forming_divergence, true)
  if (!key || key === 'none') return key
  const center = centerStableIdentity(candidate?.latest_center)
  return center ? `${key}|center:${center}` : null
}

function stableEntryEvidenceKey(item = {}) {
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

function centerStableIdentity(center) {
  if (center?.core_stable_id) return center.core_stable_id
  if (Array.isArray(center?.core_segment_stable_ids) && center.core_segment_stable_ids.length === 3) {
    return center.core_segment_stable_ids.join('|')
  }
  if (center?.stable_id) return center.stable_id
  return center?.start_segment_stable_id && center?.end_segment_stable_id
    ? `${center.start_segment_stable_id}|${center.end_segment_stable_id}`
    : null
}

function remapDivergenceToConsensus(divergence, segments, centers, fallbackCenter = null) {
  if (!divergence || (divergence.type !== 'top' && divergence.type !== 'bottom')) return divergence || null
  const entryStableId = divergence.entry_segment?.stable_id || null
  const departureStableId = divergence.departure_segment?.stable_id || null
  if (!entryStableId || !departureStableId) return null
  const entrySegment = segments.find(segment => segment.stable_id === entryStableId) || null
  const departureSegment = segments.find(segment => segment.stable_id === departureStableId) || null
  const centerMatches = center => center
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

function remapFormingDivergenceToConsensus(divergence, sourceCenter, sourceCandidate, segments, consensusCenter) {
  if (!divergence || (divergence.type !== 'top' && divergence.type !== 'bottom')) return divergence || null
  const sourceCenterIdentity = stableCenterCoreKey(sourceCenter, sourceCandidate)
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

function preserveHistoricalDivergenceReferences(divergence, segments, centers) {
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

function remapEntryCandidateToConsensus(item, segments, centers) {
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

function selectEvidenceConsensus(candidates, keySelector) {
  const groups = new Map()
  let eligibleCount = 0
  for (const candidate of candidates) {
    const key = keySelector(candidate)
    if (!key) continue
    eligibleCount++
    const group = groups.get(key) || []
    group.push(candidate)
    groups.set(key, group)
  }
  const group = [...groups.values()]
    .filter(item => item.length >= 2 && item.length * 2 > eligibleCount)
    .sort((a, b) => b.length - a.length)[0] || null
  return { group, eligibleCount }
}

function conservativeDivergence(items) {
  const strengthRank = { none:0, weak:1, strong:2 }
  return [...items].sort((a, b) => (
    (strengthRank[a?.strength] ?? 0) - (strengthRank[b?.strength] ?? 0)
    || (Number(b?.area_ratio) || 0) - (Number(a?.area_ratio) || 0)
    || (Number(b?.peak_ratio) || 0) - (Number(a?.peak_ratio) || 0)
  ))[0]
}

function majorityEvidenceItems(candidates, listSelector, keySelector, validatorCount,
  selectItem = items => items[0], evidenceStartSelector = null) {
  const evidence = new Map()
  for (const candidate of candidates) {
    const seen = new Set()
    for (const item of listSelector(candidate)) {
      const key = keySelector(item)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const group = evidence.get(key) || { entries:[], items:[] }
      group.entries.push({ candidate, item })
      group.items.push(item)
      evidence.set(key, group)
    }
  }
  return [...evidence.values()].map(group => {
    const evidenceStart = evidenceStartSelector ? Number(evidenceStartSelector(group.items[0])) : null
    const eligible = evidenceStartSelector
      ? candidates.filter(candidate => windowCanObserve(candidate, evidenceStart))
      : candidates.slice(0, validatorCount)
    const supportItems = group.entries
      .filter(entry => !evidenceStartSelector || windowCanObserve(entry.candidate, evidenceStart))
      .map(entry => entry.item)
    return { eligibleCount:eligible.length, supportItems }
  }).filter(group => (
    group.supportItems.length >= 2 && group.supportItems.length * 2 > group.eligibleCount
  )).map(group => selectItem(group.supportItems))
}

function selectStableChanResult(candidates, options = {}) {
  const explicitAuthoritativeCandidate = options.authoritativeCandidate || null
  const authoritativeCandidate = explicitAuthoritativeCandidate || candidates[0] || null
  const groups = new Map()
  for (const candidate of candidates) {
    const key = stableTerminalStructureKey(candidate)
    if (!key) continue
    const group = groups.get(key) || []
    group.push(candidate)
    groups.set(key, group)
  }
  const supported = [...groups.values()].map(group => {
    const evidenceStart = terminalEvidenceStart(group[0])
    const eligible = candidates.filter(candidate => windowCanObserve(candidate, evidenceStart))
    return { group, evidenceStart, eligibleCount:eligible.length, ratio:eligible.length ? group.length / eligible.length : 0 }
  }).filter(item => (!explicitAuthoritativeCandidate || item.group.includes(authoritativeCandidate))
    && item.group.length >= 2 && item.group.length * 2 > item.eligibleCount)
  if (supported.length === 0) return null
  supported.sort((a, b) => (
    b.ratio - a.ratio
    || b.group.length - a.group.length
    || Math.max(...b.group.map(item => item.center_count * 10000 + item.segment_count * 100 + item.raw_bar_count))
      - Math.max(...a.group.map(item => item.center_count * 10000 + item.segment_count * 100 + item.raw_bar_count))
  ))
  if (supported[1] && supported[0].ratio === supported[1].ratio && supported[0].group.length === supported[1].group.length) return null
  const winnerEvidence = supported[0]
  const winner = winnerEvidence.group
  const validatorCount = winnerEvidence.eligibleCount
  const confirmedSuffix = buildCrossWindowConsensusSegments(winner, candidates)
  if (confirmedSuffix.segments.length < 2) return null
  const derivedCandidates = winner.filter(candidate => candidateEndsWithSegmentChain(candidate, confirmedSuffix.segments))
  if (derivedCandidates.length < 2) return null
  const derivedValidatorCount = derivedCandidates.length
  // The complete window owns the phase and the public structure chain.  A
  // shorter suffix is only a validator; using it as the output base can make
  // a confirmed full-window anchor disagree with the returned center.
  if (explicitAuthoritativeCandidate && !derivedCandidates.includes(authoritativeCandidate)) return null
  const selected = explicitAuthoritativeCandidate
    ? authoritativeCandidate
    : [...derivedCandidates].sort((a, b) => (
      b.center_count - a.center_count || b.segment_count - a.segment_count || b.raw_bar_count - a.raw_bar_count
    ))[0]
  const consensus = explicitAuthoritativeCandidate
    ? { ...confirmedSuffix, segments:confirmedSegmentEvidence(authoritativeCandidate) }
    : confirmedSuffix
  if (consensus.segments.length < 2) return null
  const timeframe = selected?.latest_center?.source_timeframe || selected?.current_center?.source_timeframe || null
  const centerConsensus = selectConsensusCenters(
    derivedCandidates, candidates, consensus.segments, timeframe, authoritativeCandidate,
    Number(options.minimumCenterContextBars) || 0)
  const summarizedCenters = centerConsensus.centers
  const latestConsensusCenter = summarizedCenters.at(-1) || null
  const centerCandidates = latestConsensusCenter ? centerConsensus.latestCandidates : []
  const consensusCenterEntryConfirmed = Boolean(latestConsensusCenter
    && latestConsensusCenter.entry_segment_stable_id && latestConsensusCenter.entry_segment_id != null)
  const divergenceCandidates = derivedCandidates.map(candidate => {
    const divergence = candidate?.divergence
    if (!latestConsensusCenter) return { ...candidate, divergence:emptyDivergence('no_cross_window_center') }
    if (stableCenterCoreKey(candidate?.latest_center, candidate) !== stableCenterCoreKey(latestConsensusCenter)) {
      return { ...candidate, divergence:emptyDivergence('center_reference_mismatch') }
    }
    const directional = divergence?.type === 'top' || divergence?.type === 'bottom'
    if (!directional && CONCLUSIVE_DIVERGENCE_NONE_REASONS.has(String(divergence?.reason || ''))) {
      const localCenter = candidate?.latest_center || null
      const sameEntry = Boolean(latestConsensusCenter.entry_segment_stable_id
        && localCenter?.entry_segment_stable_id === latestConsensusCenter.entry_segment_stable_id)
      // An open centre legitimately has no departure segment yet.  Treat a
      // shared null departure as the same structural reference, while still
      // rejecting candidates that refer to a different departure.
      const consensusDeparture = latestConsensusCenter.departure_segment_stable_id || null
      const localDeparture = localCenter?.departure_segment_stable_id || null
      const sameDeparture = localDeparture === consensusDeparture
      return sameEntry && sameDeparture
        ? candidate
        : { ...candidate, divergence:emptyDivergence('center_reference_mismatch') }
    }
    if (!divergence?.confirmed) return candidate
    const entry = divergence.entry_segment?.stable_id || null
    const departure = divergence.departure_segment?.stable_id || null
    const entryMatches = Boolean(entry && latestConsensusCenter.entry_segment_stable_id
      && entry === latestConsensusCenter.entry_segment_stable_id)
    const departureMatches = Boolean(departure && latestConsensusCenter.departure_segment_stable_id
      && departure === latestConsensusCenter.departure_segment_stable_id)
    return entryMatches && departureMatches
      ? candidate
      : { ...candidate, divergence:emptyDivergence('center_reference_mismatch') }
  })
  const divergenceConsensus = selectEvidenceConsensus(divergenceCandidates,
    candidate => stableDivergenceEvidenceKey(candidate?.divergence))
  const divergenceWinner = divergenceConsensus.group
  const formingCandidates = latestConsensusCenter
    ? derivedCandidates.map(candidate => {
      if (stableCenterCoreKey(candidate?.latest_center, candidate) !== stableCenterCoreKey(latestConsensusCenter)) {
        return { ...candidate, forming_divergence:emptyDivergence('center_reference_mismatch') }
      }
      const forming = candidate?.forming_divergence
      const directional = forming?.type === 'top' || forming?.type === 'bottom'
      if (!directional && CONCLUSIVE_FORMING_NONE_REASONS.has(String(forming?.reason || ''))) {
        const localCenter = candidate?.latest_center || null
        const sameEntry = Boolean(latestConsensusCenter.entry_segment_stable_id
          && localCenter?.entry_segment_stable_id === latestConsensusCenter.entry_segment_stable_id)
        const consensusDeparture = latestConsensusCenter.departure_segment_stable_id || null
        const localDeparture = localCenter?.departure_segment_stable_id || null
        if (!sameEntry || localDeparture !== consensusDeparture) {
          return { ...candidate, forming_divergence:emptyDivergence('center_reference_mismatch') }
        }
      }
      return candidate
    })
    : derivedCandidates.map(candidate => ({ ...candidate, forming_divergence:emptyDivergence('no_cross_window_center') }))
  const formingConsensus = selectEvidenceConsensus(formingCandidates, stableFormingCandidateEvidenceKey)
  const formingWinner = formingConsensus.group
  const votedDivergence = divergenceWinner
    ? conservativeDivergence(divergenceWinner.map(candidate => candidate.divergence))
    : null
  const consensusDivergence = votedDivergence
    ? remapDivergenceToConsensus(votedDivergence, consensus.segments, summarizedCenters, latestConsensusCenter)
    : null
  const votedFormingDivergence = formingWinner
    ? conservativeDivergence(formingWinner.map(candidate => candidate.forming_divergence))
    : null
  const consensusFormingDivergence = votedFormingDivergence
    ? remapFormingDivergenceToConsensus(votedFormingDivergence,
      formingWinner?.[0]?.latest_center, formingWinner?.[0], consensus.segments, latestConsensusCenter)
    : null
  const recentDivergences = majorityEvidenceItems(derivedCandidates,
    candidate => Array.isArray(candidate?.recent_divergences) ? candidate.recent_divergences : [],
    stableDivergenceEvidenceKey, derivedValidatorCount, conservativeDivergence,
    item => Number(item?.entry_segment?.start_time_utc_msc || item?.departure_segment?.start_time_utc_msc) || null)
    .map(item => preserveHistoricalDivergenceReferences(item, consensus.segments, summarizedCenters))
    .filter(Boolean)
  const entryCandidates = latestConsensusCenter
    ? majorityEvidenceItems(centerCandidates,
      candidate => Array.isArray(candidate?.entry_candidates) ? candidate.entry_candidates : [],
      stableEntryEvidenceKey, centerCandidates.length, items => items[0],
      item => Number(item?.center?.start_time_utc_msc || item?.segment?.start_time_utc_msc) || null)
      .map(item => remapEntryCandidateToConsensus(item, consensus.segments, summarizedCenters))
      .filter(Boolean)
    : []
  const confirmedWarnings = (selected.warnings || []).filter(item => (
    item !== 'segment_window_unstable'
    && item !== 'center_entry_unconfirmed'
    && item !== 'no_valid_center'
    // This warning belonged to the removed fixed-age gate. Ignore it when a
    // legacy candidate is still present in a cross-window validation set.
    && item !== 'confirmed_structure_stale'
  ))
  if (latestConsensusCenter) {
    // Center existence is independently confirmed below; local-window center warnings
    // are not allowed to leak into the cross-window result.
  } else if (centerConsensus.hadEvidence) confirmedWarnings.push('center_cross_window_unstable')
  else confirmedWarnings.push('no_valid_center')
  if (latestConsensusCenter && !consensusCenterEntryConfirmed) confirmedWarnings.push('center_entry_unconfirmed')
  const divergenceFailureReason = !latestConsensusCenter
    ? 'no_cross_window_center'
    : divergenceConsensus.eligibleCount < 2
      ? 'divergence_evidence_unavailable' : 'divergence_cross_window_unstable'
  if (!consensusDivergence && latestConsensusCenter) confirmedWarnings.push(divergenceFailureReason)
  const uniqueWarnings = [...new Set(confirmedWarnings)]
  const confirmedStatus = consensus.segments.length > 0 && summarizedCenters.length === 0
    ? 'partial'
    : uniqueWarnings.length > 0 ? 'partial' : 'ok'
  const confirmedReliability = selected.history_sufficient && selected.closed_history_sufficient
    && selected.time_location_reliable && consensus.segments.length >= 2 && summarizedCenters.length > 0
    && uniqueWarnings.length === 0
    ? 'high'
    : selected.history_sufficient && selected.closed_history_sufficient && consensus.segments.length > 0
      ? 'medium'
      : 'low'
  const structureTopologyReliable = selected.history_sufficient && selected.closed_history_sufficient
    && selected.structure_time_key_reliable === true
    && selected.cache_internal_gap_unresolved !== true
    && consensus.segments.length >= 2 && summarizedCenters.length > 0
  const latestPrice = Number(selected.latest_price)
  const priceVsCenter = !latestConsensusCenter || !Number.isFinite(latestPrice)
    ? 'none'
    : latestPrice > Number(latestConsensusCenter.zh) ? 'above'
      : latestPrice < Number(latestConsensusCenter.zl) ? 'below' : 'inside'
  const trendState = classifyChanTrend(consensus.segments, summarizedCenters, latestPrice,
    consensusDivergence || emptyDivergence(divergenceFailureReason), confirmedReliability)
  const formingFailureReason = formingConsensus.eligibleCount < 2
    ? 'forming_evidence_unavailable' : 'forming_cross_window_unstable'
  return {
    ...selected,
    status: confirmedStatus,
    reliability: confirmedReliability,
    window_stable: true,
    structure_topology_reliable:structureTopologyReliable,
    segment_count:consensus.segments.length,
    center_count:summarizedCenters.length,
    confirmed_structure_max_age_bars:null,
    confirmed_structure_age_semantics:'diagnostic_only_no_expiry',
    current_segment:consensus.segments.at(-1) || null,
    prev_segment:consensus.segments.at(-2) || null,
    current_center:latestConsensusCenter,
    active_center:latestConsensusCenter && latestConsensusCenter.status !== 'closed'
      && priceVsCenter === 'inside' ? latestConsensusCenter : null,
    latest_center:latestConsensusCenter,
    price_vs_center:priceVsCenter,
    structure_anchor:{
      ...(selected.structure_anchor || {}),
      recommended_time_utc_msc:null,
      last_confirmed_segment_time_utc_msc:Number(consensus.segments.at(-1)?.end_time_utc_msc) || null,
      full_window_authoritative:false,
      temporal_identity_stable:false,
      temporal_closed_bar_support:0,
      temporal_closed_bar_validator_count:0,
      bootstrap_state:'pending',
    },
    divergence:consensusDivergence || emptyDivergence(divergenceFailureReason),
    forming_divergence:consensusFormingDivergence || emptyDivergence(formingFailureReason),
    recent_divergences: recentDivergences,
    trend_state:trendState,
    entry_candidates: entryCandidates,
    warnings: uniqueWarnings,
    cross_window_support_count: winner.length,
    cross_window_validator_count: validatorCount,
    cross_window_total_count:candidates.length,
    cross_window_support_ratio: validatorCount > 0 ? round3(winner.length / validatorCount) : 0,
    cross_window_segment_pair_support:consensus.pairSupport,
    cross_window_derived_support_count: derivedCandidates.length,
    authoritative_terminal_chain_confirmed:derivedCandidates.includes(authoritativeCandidate),
    cross_window_derived_support_ratio: consensus.validatorCount > 0
      ? round3(consensus.supportCount / consensus.validatorCount) : 0,
    cross_window_center_support_count: latestConsensusCenter ? centerConsensus.latestSupportCount : 0,
    cross_window_center_validator_count:latestConsensusCenter ? centerConsensus.latestValidatorCount : 0,
    cross_window_divergence_support_count: divergenceWinner?.length || 0,
    cross_window_divergence_validator_count:divergenceConsensus.eligibleCount,
    cross_window_forming_support_count:formingWinner?.length || 0,
    cross_window_forming_validator_count:formingConsensus.eligibleCount,
    cross_window_trend_support_count:derivedCandidates.length,
  }
}

function suppressUnconfirmedWindowStructure(primary) {
  const warnings = [...new Set([
    ...(primary.warnings || []).filter(item => item !== 'segment_consensus_partial'
      && item !== 'center_entry_unconfirmed'),
    'segment_cross_window_unstable',
    'segments_not_confirmed',
    'no_valid_center',
  ])]
  return {
    ...primary,
    status: Number(primary.active_bi_count || primary.bi_count) >= 3 ? 'segment_history_unresolved' : primary.status,
    reliability: 'low',
    window_stable: false,
    structure_topology_reliable:false,
    cross_window_support_count: 0,
    cross_window_validator_count: 0,
    cross_window_support_ratio: 0,
    segment_count: 0,
    center_count: 0,
    historical_segment_run_count: 0,
    historical_segment_count: 0,
    confirmed_structure_age_bars: null,
    confirmed_structure_max_age_bars: null,
    confirmed_structure_age_semantics:'diagnostic_only_no_expiry',
    structure_anchor: {
      ...(primary.structure_anchor || {}),
      matched: false,
      recommended_time_utc_msc: null,
      last_confirmed_segment_time_utc_msc: null,
      full_window_authoritative:false,
      temporal_identity_stable:false,
      temporal_closed_bar_support:0,
      temporal_closed_bar_validator_count:0,
      bootstrap_state:'unavailable',
      bootstrap_identity:null,
      bootstrap_core_stable_id:null,
      bootstrap_entry_segment_stable_id:null,
      bootstrap_entry_start_time_utc_msc:null,
      current_result_usable:false,
    },
    current_segment: null,
    prev_segment: null,
    current_center: null,
    active_center: null,
    latest_center: null,
    price_vs_center: 'none',
    divergence: emptyDivergence('segment_cross_window_unstable'),
    forming_divergence: emptyDivergence('segment_cross_window_unstable'),
    recent_divergences: [],
    trend_state: emptyTrendState('segment_cross_window_unstable'),
    entry_candidates: [],
    warnings,
  }
}

function protectBootstrapDependentEvidence(selected, usable, reliability) {
  if (usable) {
    return {
      divergence:selected.divergence,
      forming_divergence:selected.forming_divergence,
      recent_divergences:selected.recent_divergences,
      trend_state:selected.trend_state,
      entry_candidates:selected.entry_candidates,
    }
  }
  const divergence = emptyDivergence('structure_anchor_bootstrap_pending')
  return {
    divergence,
    forming_divergence:emptyDivergence('structure_anchor_bootstrap_pending'),
    recent_divergences:[],
    trend_state:classifyChanTrend(
      [selected?.prev_segment, selected?.current_segment].filter(Boolean),
      [selected?.latest_center].filter(Boolean),
      Number(selected?.latest_price), divergence, reliability),
    entry_candidates:[],
  }
}

function protectUnanchoredShortHistory(primary, sourceHistoryCount, calculationWindowCount) {
  const reliability = primary.reliability === 'high' ? 'medium' : primary.reliability
  const warnings = [...new Set([...(primary.warnings || []), 'structure_anchor_bootstrap_pending'])]
  const hasEntryDependentStructure = Number(primary.segment_count) > 0
    || Number(primary.center_count) > 0
    || primary.divergence?.type === 'top' || primary.divergence?.type === 'bottom'
    || primary.forming_divergence?.type === 'top' || primary.forming_divergence?.type === 'bottom'
    || (Array.isArray(primary.recent_divergences) && primary.recent_divergences.length > 0)
    || (Array.isArray(primary.entry_candidates) && primary.entry_candidates.length > 0)
  const protectedEvidence = hasEntryDependentStructure
    ? protectBootstrapDependentEvidence(primary, false, reliability)
    : {
      divergence:primary.divergence,
      forming_divergence:primary.forming_divergence,
      recent_divergences:primary.recent_divergences,
      trend_state:primary.trend_state,
      entry_candidates:primary.entry_candidates,
    }
  return {
    ...primary,
    status:primary.status === 'ok' ? 'partial' : primary.status,
    reliability,
    warnings,
    temporal_identity_stable:false,
    temporal_closed_bar_support:0,
    temporal_closed_bar_validator_count:0,
    cross_window_entry_support_count:0,
    cross_window_entry_validator_count:0,
    confirmed_structure_max_age_bars:null,
    confirmed_structure_age_semantics:'diagnostic_only_no_expiry',
    authoritative_terminal_chain_confirmed:false,
    ...protectedEvidence,
    structure_anchor:{
      ...(primary.structure_anchor || {}),
      matched:false,
      recommended_time_utc_msc:null,
      full_window_authoritative:true,
      temporal_identity_stable:false,
      temporal_closed_bar_support:0,
      temporal_closed_bar_validator_count:0,
      cross_window_entry_support_count:0,
      cross_window_entry_validator_count:0,
      bootstrap_identity:null,
      bootstrap_core_stable_id:null,
      bootstrap_entry_segment_stable_id:null,
      bootstrap_entry_start_time_utc_msc:null,
      bootstrap_state:'pending',
      current_result_usable:false,
    },
    source_history_count:sourceHistoryCount,
    calculation_window_count:calculationWindowCount,
    window_selection:'full_window_bootstrap_pending',
  }
}

function computeChan(rates, timeframe, macdHist, options = {}) {
  const sourceHistoryCount = Array.isArray(rates) ? rates.length : 0
  const calculationRates = sourceHistoryCount > CHAN_BOOTSTRAP_MAX_BARS
    ? rates.slice(-CHAN_BOOTSTRAP_MAX_BARS) : rates
  const calculationWindowCount = Array.isArray(calculationRates) ? calculationRates.length : 0
  const calculationMacdHist = sourceHistoryCount > CHAN_BOOTSTRAP_MAX_BARS
    ? calculateMacdSeries(calculationRates.map(rate => Number(rate.close))).histSeries
    : macdHist
  const requestedHistoryCount = Number(options.requestedHistoryCount)
  const calculationOptions = {
    ...options,
    requestedHistoryCount:Number.isFinite(requestedHistoryCount) && requestedHistoryCount > 0
      ? Math.min(requestedHistoryCount, CHAN_BOOTSTRAP_MAX_BARS)
      : calculationWindowCount,
  }
  const requestedTrustedAnchor = options.trustedStructureAnchor && typeof options.trustedStructureAnchor === 'object'
    ? options.trustedStructureAnchor : {}
  const requestedTrustedAnchorTime = Number(
    requestedTrustedAnchor.anchor_time_utc_msc ?? options.trustedStructureAnchorUtcMs)
  const hasTrustedAnchor = Number.isFinite(requestedTrustedAnchorTime) && requestedTrustedAnchorTime > 0
  let effectiveCalculationOptions = calculationOptions
  let primary = computeChanWindow(calculationRates, timeframe, calculationMacdHist, calculationOptions)
  let trustedAnchorMatched = hasTrustedAnchor && primary.structure_anchor?.matched === true
  if (hasTrustedAnchor && !trustedAnchorMatched) {
    const failedAnchorDiagnostics = primary.structure_anchor || {}
    const anchorWarnings = (primary.warnings || []).filter(item => item.startsWith('structure_anchor_'))
    const unanchoredOptions = {
      ...calculationOptions,
      trustedStructureAnchor:null,
      trustedStructureAnchorUtcMs:null,
    }
    effectiveCalculationOptions = unanchoredOptions
    const unanchored = computeChanWindow(calculationRates, timeframe, calculationMacdHist, unanchoredOptions)
    primary = {
      ...unanchored,
      status:'partial',
      reliability:unanchored.reliability === 'high' ? 'medium' : unanchored.reliability,
      warnings:[...new Set([...(unanchored.warnings || []), ...anchorWarnings])],
      structure_anchor:{
        ...(unanchored.structure_anchor || {}),
        requested_time_utc_msc:requestedTrustedAnchorTime,
        requested_core_stable_id:String(requestedTrustedAnchor.bootstrap_core_stable_id || '').trim() || null,
        requested_entry_segment_stable_id:String(requestedTrustedAnchor.bootstrap_entry_segment_stable_id || '').trim() || null,
        requested_last_confirmed_segment_time_utc_msc:
          Number(requestedTrustedAnchor.last_confirmed_segment_time_utc_msc) || null,
        matched:false,
        time_matched:failedAnchorDiagnostics.time_matched === true,
        identity_matched:failedAnchorDiagnostics.identity_matched === true,
        last_confirmed_segment_not_regressed:
          failedAnchorDiagnostics.last_confirmed_segment_not_regressed === true,
      },
    }
    trustedAnchorMatched = false
  }
  if (trustedAnchorMatched || options.fractalsForTest || !Array.isArray(calculationRates)) {
    return { ...primary, source_history_count:sourceHistoryCount, calculation_window_count:calculationWindowCount, window_selection:trustedAnchorMatched ? 'trusted_anchor' : 'full_window' }
  }
  if (calculationWindowCount < 300) {
    return protectUnanchoredShortHistory(primary, sourceHistoryCount, calculationWindowCount)
  }
  const maxWindow = calculationWindowCount
  const shortWindowStep = maxWindow >= 600 ? 100 : Math.max(20, Math.floor((maxWindow / 5) / 10) * 10)
  const minWindow = maxWindow >= 600 ? 300 : Math.max(120, Math.floor((maxWindow * 0.6) / 10) * 10)
  const sizes = []
  for (let size = maxWindow; size >= minWindow;) {
    sizes.push(size)
    size -= size > 1200 ? 200 : shortWindowStep
  }
  const candidates = sizes.map(size => {
    if (size === calculationWindowCount) return primary
    const windowRates = calculationRates.slice(-size)
    const windowMacd = calculateMacdSeries(windowRates.map(rate => Number(rate.close))).histSeries
      return computeChanWindow(windowRates, timeframe, windowMacd, { ...effectiveCalculationOptions, requestedHistoryCount: size })
  })
  const selected = selectStableChanResult(candidates, {
    authoritativeCandidate:primary,
    minimumCenterContextBars:CHAN_CENTER_MIN_CONTEXT_BARS,
  })
  if (!selected) {
    return {
      ...suppressUnconfirmedWindowStructure(primary),
      source_history_count:sourceHistoryCount,
      calculation_window_count:calculationWindowCount,
      window_selection: 'full_window_unresolved',
    }
  }
  const temporalEvidence = buildFullWindowTemporalEvidence(calculationRates, timeframe, effectiveCalculationOptions, primary)
  const crossWindowBootstrap = evaluateCrossWindowBootstrapEvidence(
    candidates, primary, temporalEvidence, CHAN_CENTER_MIN_CONTEXT_BARS)
  const primaryStructureTimeKeyReliable = primary.structure_time_key_reliable === true
    || (primary.structure_time_key_reliable == null && primary.time_location_reliable === true)
  const promotionHistoryReady = calculationWindowCount >= CHAN_BOOTSTRAP_MAX_BARS
    && primary.history_sufficient === true
    && primary.closed_history_sufficient === true
    && primaryStructureTimeKeyReliable
    && primary.cache_internal_gap_unresolved !== true
    && primary.reliability !== 'low'
  const promotionReady = promotionHistoryReady
    && selected.authoritative_terminal_chain_confirmed === true
    && temporalEvidence.temporal_identity_stable === true
    && crossWindowBootstrap.stable
  // The unanchored calculation is phase one only: it may recommend and persist
  // an independently confirmed boundary, but it never publishes entry-dependent
  // evidence. A later calculation must reload and exactly match that boundary.
  const bootstrapUsableNow = false
  const recommendedAnchorTime = promotionReady
    ? Number(temporalEvidence.temporal_entry_start_time_utc_msc) || null : null
  const bootstrapWarning = bootstrapUsableNow ? [] : ['structure_anchor_bootstrap_pending']
  const warnings = [...new Set([...(selected.warnings || []), ...bootstrapWarning])]
  const reliability = !bootstrapUsableNow && selected.reliability === 'high' ? 'medium' : selected.reliability
  const protectedEvidence = protectBootstrapDependentEvidence(selected, bootstrapUsableNow, reliability)
  return {
    ...selected,
    status:warnings.length > 0 ? 'partial' : selected.status,
    reliability,
    warnings,
    temporal_identity_stable:temporalEvidence.temporal_identity_stable,
    temporal_closed_bar_support:temporalEvidence.temporal_closed_bar_support,
    temporal_closed_bar_validator_count:temporalEvidence.temporal_closed_bar_validator_count,
    cross_window_entry_support_count:crossWindowBootstrap.supportCount,
    cross_window_entry_validator_count:crossWindowBootstrap.validatorCount,
    ...protectedEvidence,
    structure_anchor:{
      ...(selected.structure_anchor || {}),
      requested_time_utc_msc:primary.structure_anchor?.requested_time_utc_msc ?? null,
      matched:false,
      recommended_time_utc_msc:recommendedAnchorTime,
      full_window_authoritative:true,
      temporal_identity_stable:temporalEvidence.temporal_identity_stable,
      temporal_closed_bar_support:temporalEvidence.temporal_closed_bar_support,
      temporal_closed_bar_validator_count:temporalEvidence.temporal_closed_bar_validator_count,
      cross_window_entry_support_count:crossWindowBootstrap.supportCount,
      cross_window_entry_validator_count:crossWindowBootstrap.validatorCount,
      bootstrap_identity:promotionReady ? JSON.stringify({
        core_stable_id:temporalEvidence.temporal_core_stable_id,
        entry_segment_stable_id:temporalEvidence.temporal_entry_segment_stable_id,
      }) : null,
      bootstrap_core_stable_id:promotionReady ? temporalEvidence.temporal_core_stable_id : null,
      bootstrap_entry_segment_stable_id:promotionReady ? temporalEvidence.temporal_entry_segment_stable_id : null,
      bootstrap_entry_start_time_utc_msc:promotionReady
        ? temporalEvidence.temporal_entry_start_time_utc_msc : null,
      bootstrap_observation_time_utc_msc:Number(primary.structure_anchor?.bootstrap_observation_time_utc_msc) || null,
      bootstrap_state:promotionReady ? 'confirmed' : 'pending',
      current_result_usable:bootstrapUsableNow,
    },
    source_history_count:sourceHistoryCount,
    calculation_window_count: selected.raw_bar_count,
    window_selection: 'full_window_cross_confirmed',
  }
}

// Export for testing
export const __chanTest = { calculateMacdSeries, roundMacdEvidence, normalizeBarsForChan, detectFractals, buildBis, buildDevelopingBi, normalizeFeatureSequence, buildSegments, buildCenters, detectDivergence, detectDivergenceHistory, detectFormingDivergence, buildFormingSegment, summarizeSegment, summarizeCenter, classifyChanTrend, detectChanEntryCandidates, emptyChanResult, computeChan, computeChanWindow, selectStableChanResult, summarizeTemporalBootstrapEvidence, evaluateCrossWindowBootstrapEvidence, protectBootstrapDependentEvidence }

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
  const closedRates = options.chanDataQuality?.last_bar_closed === true
    ? rates
    : rates.length > 1 ? rates.slice(0, -1) : []
  const lastClosedRate = closedRates.at(-1) || null
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
    ? computeChan(chanRates, timeframe, chanMacdSeries.histSeries, {
      requestedHistoryCount: options.requestedChanHistoryCount,
      dataQuality: options.chanDataQuality,
      trustedStructureAnchor: {
        anchor_time_utc_msc:options.chanDataQuality?.chan_structure_anchor_utc_msc,
        last_confirmed_segment_time_utc_msc:options.chanDataQuality?.chan_last_confirmed_segment_utc_msc,
        bootstrap_core_stable_id:options.chanDataQuality?.chan_structure_anchor_core_stable_id,
        bootstrap_entry_segment_stable_id:options.chanDataQuality?.chan_structure_anchor_entry_segment_stable_id,
      },
    })
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
    last_closed_bar: lastClosedRate ? {
      time:lastClosedRate.time ?? null,
      time_utc_msc:Number.isFinite(Number(lastClosedRate.time_utc_msc)) ? Number(lastClosedRate.time_utc_msc) : null,
      open:round5(parseFloat(lastClosedRate.open || 0)),
      high:round5(parseFloat(lastClosedRate.high || 0)),
      low:round5(parseFloat(lastClosedRate.low || 0)),
      close:round5(parseFloat(lastClosedRate.close || 0)),
    } : null,
    market_data_quality: options.chanDataQuality ? {
      clock_status: options.chanDataQuality.clock_status || 'unknown',
      cache_gap_refilled: Boolean(options.chanDataQuality.cache_gap_refilled),
      cache_internal_gap_detected: Boolean(options.chanDataQuality.cache_internal_gap_detected),
      cache_internal_gap_unresolved: Boolean(options.chanDataQuality.cache_internal_gap_unresolved),
      last_bar_closed: Boolean(options.chanDataQuality.last_bar_closed),
    } : undefined,
    chan,
  }
}
