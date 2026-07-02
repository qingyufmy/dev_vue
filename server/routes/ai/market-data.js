// ai/market-data.js — 行情计算 + 桥接封装

import { beijingNow } from '../../db.js'
import { sendBridgeCommand } from '../../bridge-ws.js'
import { round2, round3, round5, clamp, compactRates } from './utils.js'

const _bridgeLocks = {}

// === Chan Theory Constants ===
const MIN_BARS_PER_BI = 5
const MIN_BIS_PER_SEGMENT = 3
const FEED_LAST_N_BIS = 3
const ENABLE_DIVERGENCE = true
const MIN_KLINES_FOR_CHAN = 30
const DEBUG_CHAN = process.env.DEBUG_CHAN === '1'

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
    bars.push({ idx: bars.length, raw_idx: i, high: h, low: l, open: o, close: c, time: rates[i].time })
  }
  if (bars.length < 3) return bars

  const merged = [bars[0]]
  let direction = 0
  for (let i = 1; i < bars.length; i++) {
    const prev = merged[merged.length - 1]
    const cur = bars[i]
    const prevContainsCur = prev.high >= cur.high && prev.low <= cur.low
    const curContainsPrev = cur.high >= prev.high && cur.low <= prev.low
    if (prevContainsCur || curContainsPrev) {
      if (direction === 0) {
        if (i + 1 < bars.length) {
          const next = bars[i + 1]
          direction = next.high > prev.high ? 1 : -1
        }
        if (direction === 0) direction = 1
      }
      if (direction > 0) {
        merged[merged.length - 1] = { ...prev, high: Math.max(prev.high, cur.high), low: Math.max(prev.low, cur.low), raw_end_idx: cur.raw_idx }
      } else {
        merged[merged.length - 1] = { ...prev, high: Math.min(prev.high, cur.high), low: Math.min(prev.low, cur.low), raw_end_idx: cur.raw_idx }
      }
    } else {
      direction = cur.high > prev.high ? 1 : -1
      merged.push({ ...cur, raw_start_idx: cur.raw_idx, raw_end_idx: cur.raw_idx })
    }
  }
  return merged
}

// === Chan Theory: Fractal Detection (on processed bars) ===
function detectFractals(bars) {
  if (bars.length < 3) return []
  const fractals = []
  for (let i = 1; i < bars.length - 1; i++) {
    const p = bars[i - 1], c = bars[i], n = bars[i + 1]
    if (c.high > p.high && c.high > n.high && c.low >= Math.min(p.low, n.low)) {
      fractals.push({ idx: c.idx, raw_idx: c.raw_idx, type: 'top', price: c.high, high: c.high, low: c.low, time: c.time })
    } else if (c.low < p.low && c.low < n.low && c.high <= Math.max(p.high, n.high)) {
      fractals.push({ idx: c.idx, raw_idx: c.raw_idx, type: 'bottom', price: c.low, high: c.high, low: c.low, time: c.time })
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
  for (let i = 1; i < pivots.length; i++) {
    const s = pivots[i - 1], e = pivots[i]
    const isLast = i === pivots.length - 1
    bis.push({
      id: bis.length + 1,
      dir: s.type === 'bottom' ? 'up' : 'down',
      start_idx: s.idx, end_idx: e.idx,
      raw_start_idx: s.raw_idx, raw_end_idx: e.raw_idx,
      start_price: s.price, end_price: e.price,
      high: Math.max(s.high, e.high), low: Math.min(s.low, e.low),
      confirmed: !isLast,
    })
  }
  if (DEBUG_CHAN) console.log(`[Chan] Bis(${bis.length}): ${bis.map(b => `${b.id}${b.dir[0]} ${b.start_price}→${b.end_price}${b.confirmed ? '' : '*'}`).join(' | ')}`)
  return bis
}

// === Chan Theory: Segment Construction (conservative) ===
function buildSegments(confirmedBis) {
  if (confirmedBis.length < MIN_BIS_PER_SEGMENT) return { segments: [], candidate: null }
  const segments = []
  let segStart = 0

  while (segStart < confirmedBis.length - 2) {
    const first = confirmedBis[segStart]
    const segDir = first.dir
    let segEnd = segStart + 2
    let broken = false

    if (segDir === 'up') {
      let extreme = confirmedBis[segStart].end_price
      let lastLow = Math.min(confirmedBis[segStart].start_price, confirmedBis[segStart].end_price)
      for (let i = segStart + 1; i < confirmedBis.length; i++) {
        const bi = confirmedBis[i]
        if (bi.dir === 'up') {
          if (bi.end_price > extreme) extreme = bi.end_price
        } else {
          if (bi.end_price < lastLow) {
            if (i - segStart >= MIN_BIS_PER_SEGMENT) {
              segEnd = i
              broken = true
            }
            break
          }
          lastLow = Math.min(lastLow, bi.end_price)
        }
        segEnd = i
      }
    } else {
      let extreme = confirmedBis[segStart].end_price
      let lastHigh = Math.max(confirmedBis[segStart].start_price, confirmedBis[segStart].end_price)
      for (let i = segStart + 1; i < confirmedBis.length; i++) {
        const bi = confirmedBis[i]
        if (bi.dir === 'down') {
          if (bi.end_price < extreme) extreme = bi.end_price
        } else {
          if (bi.end_price > lastHigh) {
            if (i - segStart >= MIN_BIS_PER_SEGMENT) {
              segEnd = i
              broken = true
            }
            break
          }
          lastHigh = Math.max(lastHigh, bi.end_price)
        }
        segEnd = i
      }
    }

    const biIds = confirmedBis.slice(segStart, segEnd + 1).map(b => b.id)
    if (biIds.length >= MIN_BIS_PER_SEGMENT) {
      const seg = {
        id: segments.length + 1, dir: segDir,
        start_price: confirmedBis[segStart].start_price,
        end_price: confirmedBis[segEnd].end_price,
        bi_ids: biIds, broken, weak: false,
      }
      segments.push(seg)
      segStart = broken ? segEnd : segEnd
    } else {
      segStart++
    }
  }

  // Candidate segment from remaining tail
  const tailBis = confirmedBis.slice(segStart)
  const candidate = tailBis.length > 0 ? {
    dir: tailBis[0].dir,
    bi_ids: tailBis.map(b => b.id),
    start_price: tailBis[0].start_price,
    end_price: tailBis[tailBis.length - 1].end_price,
  } : null

  if (DEBUG_CHAN) console.log(`[Chan] Segments(${segments.length}): ${segments.map(s => `#${s.id}(${s.dir}) bis=${s.bi_ids.length}`).join(' | ')}`)
  return { segments, candidate }
}

// === Chan Theory: Center (Zhongshu) Detection ===
function buildCenters(confirmedBis) {
  if (confirmedBis.length < 3) return []
  const centers = []
  for (let i = 0; i + 2 < confirmedBis.length; i++) {
    const ranges = [confirmedBis[i], confirmedBis[i + 1], confirmedBis[i + 2]].map(b => [Math.min(b.start_price, b.end_price), Math.max(b.start_price, b.end_price)])
    const zl = Math.max(ranges[0][0], ranges[1][0], ranges[2][0])
    const zh = Math.min(ranges[0][1], ranges[1][1], ranges[2][1])
    if (zl < zh) {
      const existing = centers[centers.length - 1]
      if (existing && existing.status !== 'closed') {
        const nextZl = Math.max(existing.zl, zl)
        const nextZh = Math.min(existing.zh, zh)
        if (nextZl < nextZh) {
          existing.zl = nextZl
          existing.zh = nextZh
          existing.bi_ids.push(confirmedBis[i + 2].id)
          existing.end_bi_id = confirmedBis[i + 2].id
          existing.status = 'extended'
        } else {
          existing.status = 'closed'
          centers.push({ id: centers.length + 1, zl, zh, start_bi_id: confirmedBis[i].id, end_bi_id: confirmedBis[i + 2].id, bi_ids: [confirmedBis[i].id, confirmedBis[i + 1].id, confirmedBis[i + 2].id], level: '', status: 'confirmed' })
        }
      } else {
        centers.push({ id: centers.length + 1, zl, zh, start_bi_id: confirmedBis[i].id, end_bi_id: confirmedBis[i + 2].id, bi_ids: [confirmedBis[i].id, confirmedBis[i + 1].id, confirmedBis[i + 2].id], level: '', status: 'confirmed' })
      }
    }
  }
  return centers
}

// === Chan Theory: Divergence Detection (conservative) ===
function detectDivergence(segments, bis, macdHist) {
  if (!ENABLE_DIVERGENCE || !macdHist || macdHist.length === 0) return { type: 'none', strength: 'none', reason: 'no_macd_data' }
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  if (validSegs.length < 2) return { type: 'none', strength: 'none', reason: 'insufficient_valid_segments' }

  function calcArea(biIds) {
    let area = 0
    for (const bid of biIds) {
      const bi = bis.find(b => b.id === bid)
      if (!bi) continue
      for (let j = bi.raw_start_idx; j <= bi.raw_end_idx && j < macdHist.length; j++) {
        area += Math.abs(macdHist[j] || 0)
      }
    }
    return area
  }

  const sameDown = validSegs.filter(s => s.dir === 'down')
  if (sameDown.length >= 2) {
    const a = sameDown[sameDown.length - 2], b = sameDown[sameDown.length - 1]
    const areaA = calcArea(a.bi_ids), areaB = calcArea(b.bi_ids)
    if (areaB < areaA) return { type: 'bottom', strength: 'strong', reason: 'macd_area_divergence', area_cur: round2(areaB), area_prev: round2(areaA) }
  }
  const sameUp = validSegs.filter(s => s.dir === 'up')
  if (sameUp.length >= 2) {
    const a = sameUp[sameUp.length - 2], b = sameUp[sameUp.length - 1]
    const areaA = calcArea(a.bi_ids), areaB = calcArea(b.bi_ids)
    if (areaB < areaA) return { type: 'top', strength: 'strong', reason: 'macd_area_divergence', area_cur: round2(areaB), area_prev: round2(areaA) }
  }
  return { type: 'none', strength: 'none', reason: 'no_divergence_detected' }
}

// === Chan Theory: Assembly ===
function computeChan(rates, timeframe, macdHist) {
  const warnings = []
  if (!rates || rates.length < MIN_KLINES_FOR_CHAN) {
    return { status: 'insufficient_klines', reliability: 'low', raw_bar_count: rates?.length || 0, processed_bar_count: 0, fractal_count: 0, bi_count: 0, segment_count: 0, center_count: 0, warnings: ['raw_bars_too_few'] }
  }
  const bars = normalizeBarsForChan(rates)
  if (bars.length < 10) warnings.push('processed_bars_too_few')
  const fractals = detectFractals(bars)
  const allBis = buildBis(fractals, bars)
  const confirmedBis = allBis.filter(b => b.confirmed !== false)
  if (confirmedBis.length < 3) {
    return { status: 'insufficient_bis', reliability: 'low', raw_bar_count: rates.length, processed_bar_count: bars.length, fractal_count: fractals.length, bi_count: allBis.length, segment_count: 0, center_count: 0, warnings: ['insufficient_confirmed_bis'] }
  }
  const { segments, candidate } = buildSegments(confirmedBis)
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  if (validSegs.length === 0) warnings.push('segments_not_confirmed')
  const centers = buildCenters(confirmedBis)
  const validCenters = centers.filter(c => c.status !== 'closed')
  if (validCenters.length === 0) warnings.push('no_valid_center')
  const lastCenter = validCenters.length > 0 ? validCenters[validCenters.length - 1] : null
  const lastSeg = validSegs.length > 0 ? validSegs[validSegs.length - 1] : null
  const lastBi = allBis[allBis.length - 1]
  const latest = parseFloat(rates[rates.length - 1].close)
  let priceVsCenter = 'none'
  if (lastCenter) {
    if (latest > lastCenter.zh) priceVsCenter = 'above'
    else if (latest < lastCenter.zl) priceVsCenter = 'below'
    else priceVsCenter = 'inside'
  }
  const divergence = detectDivergence(validSegs, allBis, macdHist)
  if (divergence.type !== 'none') {
    // ok
  } else if (divergence.reason === 'insufficient_valid_segments') {
    warnings.push('divergence_skipped_no_valid_segment')
  }

  let reliability = 'low'
  if (validSegs.length > 0 && validCenters.length > 0) reliability = 'high'
  else if (confirmedBis.length > 0 && validSegs.length > 0) reliability = 'medium'

  let status = 'ok'
  if (validSegs.length === 0 && confirmedBis.length >= 3) status = 'unreliable_segments'
  else if (validSegs.length > 0 && validCenters.length === 0) status = 'partial'
  else if (warnings.length > 0) status = 'partial'

  console.log(`[Chan] ${timeframe}: status=${status} reliability=${reliability} raw=${rates.length} processed=${bars.length} fractals=${fractals.length} bis=${allBis.length} confirmed=${confirmedBis.length} segs=${validSegs.length} centers=${validCenters.length} warnings=${warnings.join(',') || 'none'}`)
  return {
    status, reliability,
    raw_bar_count: rates.length, processed_bar_count: bars.length,
    fractal_count: fractals.length, bi_count: allBis.length, segment_count: validSegs.length, center_count: validCenters.length,
    current_bi: lastBi ? { id: lastBi.id, dir: lastBi.dir, start_price: round5(lastBi.start_price), end_price: round5(lastBi.end_price), confirmed: lastBi.confirmed } : null,
    recent_bis: allBis.slice(-FEED_LAST_N_BIS).map(b => ({ id: b.id, dir: b.dir, start_price: round5(b.start_price), end_price: round5(b.end_price), confirmed: b.confirmed })),
    current_segment: lastSeg ? { id: lastSeg.id, dir: lastSeg.dir, start_price: round5(lastSeg.start_price), end_price: round5(lastSeg.end_price), broken: lastSeg.broken } : null,
    candidate_segment: candidate ? { dir: candidate.dir, bi_count: candidate.bi_ids.length, start_price: round5(candidate.start_price), end_price: round5(candidate.end_price) } : null,
    current_center: lastCenter ? { id: lastCenter.id, zl: round5(lastCenter.zl), zh: round5(lastCenter.zh), level: timeframe, status: lastCenter.status } : null,
    price_vs_center: priceVsCenter,
    divergence,
    warnings,
  }
}

// Export for testing
export const __chanTest = { normalizeBarsForChan, detectFractals, buildBis, buildSegments, buildCenters, detectDivergence, computeChan }

export async function mt5Bridge(userId, action, params = {}, options = {}) {
  const prev = _bridgeLocks[userId] || Promise.resolve()
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
  _bridgeLocks[userId] = current
  return current
}

export async function executeViaBridge(userId, action, params, timeoutMs = 10000, options = {}) {
  return sendBridgeCommand(userId, action, params, timeoutMs, options)
}

export function calculateMarketData(symbol, timeframe, rates, account, positions) {
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
  const macdLine = ema12 - ema26
  const macdHistory = []
  if (n >= 26) {
    const k12 = 2 / 13, k26 = 2 / 27
    let e12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12
    let e26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26
    for (let i = 12; i < n; i++) {
      e12 = closes[i] * k12 + e12 * (1 - k12)
      if (i >= 26) {
        e26 = closes[i] * k26 + e26 * (1 - k26)
        macdHistory.push(e12 - e26)
      }
    }
  }
  const macdSignal = macdHistory.length >= 9 ? ema(macdHistory, 9) : macdLine
  const macdHistogram = macdLine - macdSignal

  const rsi14 = calcRsi(closes, 14)

  const bbStd = Math.sqrt(smaWindow.reduce((sum, v) => sum + (v - sma20) ** 2, 0) / smaWindow.length)
  const bbUpper = sma20 + 2 * bbStd
  const bbLower = sma20 - 2 * bbStd
  const bbWidth = bbUpper - bbLower
  const bbPosition = bbWidth > 0 ? (latest - bbLower) / bbWidth : 0.5

  const trueRanges = []
  for (let i = 1; i < n; i++) {
    trueRanges.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])))
  }
  const atrWindow = trueRanges.length >= 14 ? trueRanges.slice(-14) : trueRanges
  const atr14 = atrWindow.length > 0 ? atrWindow.reduce((a, b) => a + b, 0) / atrWindow.length : 0

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

  const chan = computeChan(rates, timeframe, macdHistory)

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
    account: account ? { balance: account.balance, equity: account.equity } : null,
    chan,
  }
}
