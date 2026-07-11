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
const FEED_LAST_N_BIS = 3
const ENABLE_DIVERGENCE = true
const MIN_KLINES_FOR_CHAN = 30
const DIVERGENCE_MIN_AREA_RATIO = 0.85
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
  for (let i = 1; i < pivots.length; i++) {
    const s = pivots[i - 1], e = pivots[i]
    const dir = s.type === 'bottom' ? 'up' : 'down'
    if (dir === 'up' && e.price <= s.price) { invalidCount++; continue }
    if (dir === 'down' && e.price >= s.price) { invalidCount++; continue }
    bis.push({
      id: bis.length + 1, dir,
      start_idx: s.idx, end_idx: e.idx,
      raw_start_idx: Math.min(s.raw_start_idx ?? s.raw_idx, e.raw_start_idx ?? e.raw_idx),
      raw_end_idx: Math.max(s.raw_end_idx ?? s.raw_idx, e.raw_end_idx ?? e.raw_idx),
      start_price: s.price, end_price: e.price,
      high: Math.max(s.high, e.high), low: Math.min(s.low, e.low),
      confirmed: true,
    })
  }
  if (DEBUG_CHAN) console.log(`[Chan] Bis(${bis.length}, invalid=${invalidCount}): ${bis.map(b => `${b.id}${b.dir[0]} ${b.start_price}→${b.end_price}${b.confirmed ? '' : '*'}`).join(' | ')}`)
  return { bis, invalidCount }
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
function buildSegments(confirmedBis, options = {}) {
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
      start_price: startPrice,
      end_price: endPrice,
      high: Math.max(...segBis.map(b => b.high)),
      low: Math.min(...segBis.map(b => b.low)),
      bi_ids: segBis.map(b => b.id),
      start_bi_id: segBis[0].id,
      end_bi_id: segBis[segBis.length - 1].id,
      broken: true,
      weak: false,
      confirmation: endpoint.hasGap ? 'gap_reverse_confirmed' : 'feature_fractal',
    })
    startIndex = endpoint.endpointIndex
  }

  const tailBis = confirmedBis.slice(startIndex)
  const candidate = tailBis.length > 0 ? {
    dir: tailBis[0].dir,
    bi_ids: tailBis.map(b => b.id),
    start_price: tailBis[0].start_price,
    end_price: tailBis[tailBis.length - 1].end_price,
  } : null

  if (DEBUG_CHAN) console.log(`[Chan] Segments(${segments.length}): ${segments.map(s => `#${s.id}(${s.dir}) bis=${s.bi_ids.length}`).join(' | ')}`)
  return { segments, candidate, resynced }
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
    }
    let j = i + 3
    while (j < components.length) {
      const item = components[j]
      const low = Number.isFinite(item.low) ? item.low : Math.min(item.start_price, item.end_price)
      const high = Number.isFinite(item.high) ? item.high : Math.max(item.start_price, item.end_price)
      if (Math.max(center.zl, low) >= Math.min(center.zh, high)) break
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
function detectDivergence(segments, bis, macdHist, centers = []) {
  if (!ENABLE_DIVERGENCE || !macdHist || macdHist.length === 0) return { type: 'none', strength: 'none', reason: 'no_macd_data', area_cur: 0, area_prev: 0, price_extreme_cur: 0, price_extreme_prev: 0 }
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  if (validSegs.length < 2) return { type: 'none', strength: 'none', reason: 'insufficient_valid_segments', area_cur: 0, area_prev: 0, price_extreme_cur: 0, price_extreme_prev: 0 }
  if (centers.length === 0) return { type: 'none', strength: 'none', reason: 'no_valid_center', area_cur: 0, area_prev: 0, price_extreme_cur: 0, price_extreme_prev: 0 }

  function calcArea(biIds, dir) {
    let area = 0
    const seenIndexes = new Set()
    for (const bid of biIds) {
      const bi = bis.find(b => b.id === bid)
      if (!bi) continue
      for (let j = bi.raw_start_idx; j <= bi.raw_end_idx && j < macdHist.length; j++) {
        if (seenIndexes.has(j)) continue
        seenIndexes.add(j)
        const v = macdHist[j] || 0
        if (dir === 'up' && v > 0) area += v
        else if (dir === 'down' && v < 0) area += Math.abs(v)
      }
    }
    return area
  }

  // Compare the latest departure segment with the same-direction segment that
  // entered the same center. This prevents unrelated historical segments from
  // being paired solely because their direction matches.
  const current = validSegs[validSegs.length - 1]
  const eligibleCenters = centers.filter(c => current.id === (c.end_segment_id || 0) + 1)
  if (eligibleCenters.length === 0) return { type: 'none', strength: 'none', reason: 'not_after_center', area_cur: 0, area_prev: 0, price_extreme_cur: 0, price_extreme_prev: 0 }
  const lastCenter = eligibleCenters[eligibleCenters.length - 1]
  const prev = validSegs.find(s => s.id === lastCenter.start_segment_id - 1)
  if (!prev || prev.dir !== current.dir) return { type: 'none', strength: 'none', reason: 'no_entry_segment', area_cur: 0, area_prev: 0, price_extreme_cur: 0, price_extreme_prev: 0 }
  const cur = current

  const areaPrev = calcArea(prev.bi_ids, cur.dir)
  const areaCur = calcArea(cur.bi_ids, cur.dir)

  if (areaCur === 0 || areaPrev === 0) return { type: 'none', strength: 'none', reason: 'invalid_macd_area', area_cur: round2(areaCur), area_prev: round2(areaPrev), price_extreme_cur: 0, price_extreme_prev: 0 }

  if (cur.dir === 'up') {
    if (cur.high <= prev.high) return { type: 'none', strength: 'none', reason: 'no_price_extreme_break', area_cur: round2(areaCur), area_prev: round2(areaPrev), price_extreme_cur: round5(cur.high), price_extreme_prev: round5(prev.high) }
    if (areaCur <= areaPrev * DIVERGENCE_MIN_AREA_RATIO) return { type: 'top', category: 'center_departure', trend_confirmed: false, strength: 'candidate', reason: 'macd_area_divergence', area_cur: round2(areaCur), area_prev: round2(areaPrev), price_extreme_cur: round5(cur.high), price_extreme_prev: round5(prev.high) }
    return { type: 'none', strength: 'none', reason: 'macd_area_not_shrunk_enough', area_cur: round2(areaCur), area_prev: round2(areaPrev), price_extreme_cur: round5(cur.high), price_extreme_prev: round5(prev.high) }
  } else {
    if (cur.low >= prev.low) return { type: 'none', strength: 'none', reason: 'no_price_extreme_break', area_cur: round2(areaCur), area_prev: round2(areaPrev), price_extreme_cur: round5(cur.low), price_extreme_prev: round5(prev.low) }
    if (areaCur <= areaPrev * DIVERGENCE_MIN_AREA_RATIO) return { type: 'bottom', category: 'center_departure', trend_confirmed: false, strength: 'candidate', reason: 'macd_area_divergence', area_cur: round2(areaCur), area_prev: round2(areaPrev), price_extreme_cur: round5(cur.low), price_extreme_prev: round5(prev.low) }
    return { type: 'none', strength: 'none', reason: 'macd_area_not_shrunk_enough', area_cur: round2(areaCur), area_prev: round2(areaPrev), price_extreme_cur: round5(cur.low), price_extreme_prev: round5(prev.low) }
  }
}

// === Chan Theory: Assembly ===
function computeChan(rates, timeframe, macdHist, options = {}) {
  const warnings = []
  const requestedHistoryCount = Number(options.requestedHistoryCount) || rates?.length || 0
  const historySufficient = Array.isArray(rates) && rates.length >= requestedHistoryCount
  if (!historySufficient) warnings.push('history_bars_below_requested')
  const closedRates = Array.isArray(rates) ? rates.slice(0, -1) : []
  const closedMacdHist = Array.isArray(macdHist) ? macdHist.slice(0, closedRates.length) : []
  if (closedRates.length < MIN_KLINES_FOR_CHAN) {
    return { status: 'insufficient_klines', reliability: 'low', requested_history_count: requestedHistoryCount, received_history_count: rates?.length || 0, history_sufficient: historySufficient, raw_bar_count: rates?.length || 0, processed_bar_count: 0, fractal_count: 0, bi_count: 0, segment_count: 0, center_count: 0, warnings: [...warnings, 'raw_bars_too_few'] }
  }
  const bars = normalizeBarsForChan(closedRates)
  if (bars.length < 10) warnings.push('processed_bars_too_few')
  const fractals = options.fractalsForTest || detectFractals(bars)
  const { bis: allBis, invalidCount } = buildBis(fractals, bars)
  if (invalidCount > 0) warnings.push('invalid_bi_price_direction')
  const confirmedBis = allBis.filter(b => b.confirmed !== false)
  if (confirmedBis.length < 3) {
    warnings.push('insufficient_confirmed_bis')
    return { status: 'insufficient_bis', reliability: 'low', requested_history_count: requestedHistoryCount, received_history_count: rates.length, history_sufficient: historySufficient, raw_bar_count: rates.length, closed_bar_count: closedRates.length, processed_bar_count: bars.length, fractal_count: fractals.length, bi_count: allBis.length, segment_count: 0, center_count: 0, warnings }
  }
  const { segments, candidate, resynced } = buildSegments(confirmedBis, { trustedStart: false })
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  if (validSegs.length === 0) warnings.push('segments_not_confirmed')
  const centers = buildCenters(validSegs)
  if (centers.length === 0) warnings.push('no_valid_center')
  const latestCenter = centers.length > 0 ? centers[centers.length - 1] : null
  const activeCenter = latestCenter?.status === 'closed' ? null : latestCenter
  const lastSeg = validSegs.length > 0 ? validSegs[validSegs.length - 1] : null
  const lastBi = allBis[allBis.length - 1]
  const latest = parseFloat(rates[rates.length - 1].close)
  const liveRate = rates[rates.length - 1]
  const lastFractal = fractals[fractals.length - 1]
  let developingBi = null
  if (lastFractal && liveRate) {
    const liveHigh = Number(liveRate.high)
    const liveLow = Number(liveRate.low)
    if (lastFractal.type === 'bottom' && Number.isFinite(liveHigh) && liveHigh > lastFractal.price) {
      developingBi = { dir: 'up', start_price: round5(lastFractal.price), end_price: round5(liveHigh), confirmed: false }
    } else if (lastFractal.type === 'top' && Number.isFinite(liveLow) && liveLow < lastFractal.price) {
      developingBi = { dir: 'down', start_price: round5(lastFractal.price), end_price: round5(liveLow), confirmed: false }
    }
  }
  let priceVsCenter = 'none'
  if (activeCenter) {
    if (latest > activeCenter.zh) priceVsCenter = 'above'
    else if (latest < activeCenter.zl) priceVsCenter = 'below'
    else priceVsCenter = 'inside'
  }
  const divergence = detectDivergence(validSegs, allBis, closedMacdHist, centers)
  if (divergence.type !== 'none') {
    // ok
  } else if (divergence.reason === 'invalid_macd_area' || divergence.reason === 'no_macd_data') {
    warnings.push('divergence_skipped_invalid_macd')
  }

  let reliability = 'low'
  if (historySufficient && validSegs.length >= 2 && centers.length > 0 && warnings.length === 0) reliability = 'high'
  else if (historySufficient && validSegs.length > 0) reliability = 'medium'

  let status = 'ok'
  if (validSegs.length === 0 && confirmedBis.length >= 3) status = 'unreliable_segments'
  else if (validSegs.length > 0 && centers.length === 0) status = 'partial'
  else if (warnings.length > 0) status = 'partial'

  console.log(`[Chan] ${timeframe}: status=${status} reliability=${reliability} raw=${rates.length} processed=${bars.length} fractals=${fractals.length} bis=${allBis.length} confirmed=${confirmedBis.length} segs=${validSegs.length} centers=${centers.length} warnings=${warnings.join(',') || 'none'}`)
  return {
    status, reliability,
    requested_history_count: requestedHistoryCount,
    received_history_count: rates.length,
    history_sufficient: historySufficient,
    window_resynced: resynced,
    raw_bar_count: rates.length, closed_bar_count: closedRates.length, processed_bar_count: bars.length,
    fractal_count: fractals.length, bi_count: allBis.length, segment_count: validSegs.length, center_count: centers.length,
    current_bi: lastBi ? { id: lastBi.id, dir: lastBi.dir, start_price: round5(lastBi.start_price), end_price: round5(lastBi.end_price), confirmed: lastBi.confirmed } : null,
    developing_bi: developingBi,
    recent_bis: allBis.slice(-FEED_LAST_N_BIS).map(b => ({ id: b.id, dir: b.dir, start_price: round5(b.start_price), end_price: round5(b.end_price), confirmed: b.confirmed })),
    current_segment: lastSeg ? { id: lastSeg.id, dir: lastSeg.dir, start_price: round5(lastSeg.start_price), end_price: round5(lastSeg.end_price), broken: lastSeg.broken } : null,
    candidate_segment: candidate ? { dir: candidate.dir, bi_count: candidate.bi_ids.length, start_price: round5(candidate.start_price), end_price: round5(candidate.end_price) } : null,
    current_center: activeCenter ? {
      id: activeCenter.id,
      zl: round5(activeCenter.zl),
      zh: round5(activeCenter.zh),
      source_timeframe: timeframe,
      structure_level: 'segment',
      level: timeframe,
      status: activeCenter.status,
      start_segment_id: activeCenter.start_segment_id,
      end_segment_id: activeCenter.end_segment_id,
    } : null,
    active_center: activeCenter ? {
      id: activeCenter.id, zl: round5(activeCenter.zl), zh: round5(activeCenter.zh), status: activeCenter.status,
      source_timeframe: timeframe, structure_level: 'segment',
      start_segment_id: activeCenter.start_segment_id, end_segment_id: activeCenter.end_segment_id,
    } : null,
    latest_center: latestCenter ? {
      id: latestCenter.id, zl: round5(latestCenter.zl), zh: round5(latestCenter.zh), status: latestCenter.status,
      source_timeframe: timeframe, structure_level: 'segment',
      start_segment_id: latestCenter.start_segment_id, end_segment_id: latestCenter.end_segment_id,
    } : null,
    price_vs_center: priceVsCenter,
    divergence,
    warnings,
  }
}

// Export for testing
export const __chanTest = { calculateMacdSeries, normalizeBarsForChan, detectFractals, buildBis, normalizeFeatureSequence, buildSegments, buildCenters, detectDivergence, computeChan }

export async function mt5Bridge(userId, action, params = {}, options = {}) {
  const prev = _bridgeLocks.get(userId) || Promise.resolve()
  const current = prev.then(async () => {
    let result = await executeViaBridge(userId, action, params, undefined, options)
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
        result = await executeViaBridge(userId, action, { ...params, symbol: v }, undefined, options)
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
    ? computeChan(chanRates, timeframe, chanMacdSeries.histSeries, { requestedHistoryCount: options.requestedChanHistoryCount })
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
