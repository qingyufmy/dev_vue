// ai/market-data.js — 行情计算 + 桥接封装

import { beijingNow } from '../../db.js'
import { sendBridgeCommand } from '../../bridge-ws.js'
import { round2, round3, round5, clamp, compactRates } from './utils.js'

const _bridgeLocks = {}

// === Chan Theory Constants ===
const KLINE_PER_BI = 3
const MIN_BIS_PER_SEGMENT = 3
const FEED_LAST_N_BIS = 3
const ENABLE_DIVERGENCE = true
const MIN_KLINES_FOR_CHAN = 30

// === Chan Theory: Fractal Detection ===
function detectFractals(rates) {
  const fractals = []
  for (let i = 1; i < rates.length - 1; i++) {
    const high = parseFloat(rates[i].high)
    const prevHigh = parseFloat(rates[i - 1].high)
    const nextHigh = parseFloat(rates[i + 1].high)
    const low = parseFloat(rates[i].low)
    const prevLow = parseFloat(rates[i - 1].low)
    const nextLow = parseFloat(rates[i + 1].low)
    if (high > prevHigh && high > nextHigh) {
      fractals.push({ idx: i, type: 'top', price: high })
    } else if (low < prevLow && low < nextLow) {
      fractals.push({ idx: i, type: 'bottom', price: low })
    }
  }
  return fractals
}

// === Chan Theory: Bi (Stroke) Construction ===
function buildBis(fractals, rates) {
  const pivots = []
  for (const f of fractals) {
    if (pivots.length === 0) { pivots.push(f); continue }
    const last = pivots[pivots.length - 1]
    if (f.type === last.type) {
      if ((f.type === 'top' && f.price >= last.price) || (f.type === 'bottom' && f.price <= last.price)) {
        pivots[pivots.length - 1] = f
      }
    } else {
      if (f.idx - last.idx >= KLINE_PER_BI - 1) {
        pivots.push(f)
      }
    }
  }
  const bis = []
  for (let i = 1; i < pivots.length; i++) {
    const s = pivots[i - 1], e = pivots[i]
    bis.push({
      id: bis.length + 1,
      dir: s.type === 'bottom' ? 'up' : 'down',
      start_idx: s.idx, start_price: s.price,
      end_idx: e.idx, end_price: e.price,
    })
  }
  return bis
}

// === Chan Theory: Segment Construction ===
function buildSegments(bis) {
  if (bis.length < MIN_BIS_PER_SEGMENT) return []
  const segments = []
  let seg = { id: 1, dir: bis[0].dir, start_price: bis[0].start_price, end_price: bis[0].end_price, bi_ids: [bis[0].id], broken: false, weak: false }
  let extreme = bis[0].end_price
  let lastOpp = bis[0].start_price

  for (let i = 1; i < bis.length; i++) {
    const bi = bis[i]
    if (seg.dir === 'up') {
      if (bi.dir === 'up') {
        if (bi.end_price > extreme) { extreme = bi.end_price }
        seg.bi_ids.push(bi.id)
        seg.end_price = bi.end_price
      } else {
        if (bi.end_price < lastOpp) {
          seg.weak = seg.bi_ids.length < MIN_BIS_PER_SEGMENT
          seg.broken = true
          segments.push(seg)
          seg = { id: segments.length + 1, dir: 'down', start_price: seg.end_price, end_price: bi.end_price, bi_ids: [bi.id], broken: false, weak: false }
          extreme = bi.end_price
          lastOpp = bi.end_price
        } else {
          lastOpp = bi.end_price
          seg.bi_ids.push(bi.id)
          seg.end_price = bi.end_price
        }
      }
    } else {
      if (bi.dir === 'down') {
        if (bi.end_price < extreme) { extreme = bi.end_price }
        seg.bi_ids.push(bi.id)
        seg.end_price = bi.end_price
      } else {
        if (bi.end_price > lastOpp) {
          seg.weak = seg.bi_ids.length < MIN_BIS_PER_SEGMENT
          seg.broken = true
          segments.push(seg)
          seg = { id: segments.length + 1, dir: 'up', start_price: seg.end_price, end_price: bi.end_price, bi_ids: [bi.id], broken: false, weak: false }
          extreme = bi.end_price
          lastOpp = bi.end_price
        } else {
          lastOpp = bi.end_price
          seg.bi_ids.push(bi.id)
          seg.end_price = bi.end_price
        }
      }
    }
  }
  seg.weak = seg.bi_ids.length < MIN_BIS_PER_SEGMENT
  segments.push(seg)
  return segments
}

// === Chan Theory: Center (Zhongshu) Detection ===
function buildCenters(bis) {
  if (bis.length < 3) return []
  const centers = []
  for (let i = 0; i + 2 < bis.length; i++) {
    const b1 = bis[i], b2 = bis[i + 1], b3 = bis[i + 2]
    const ranges = [b1, b2, b3].map(b => [Math.min(b.start_price, b.end_price), Math.max(b.start_price, b.end_price)])
    const zh = Math.min(ranges[0][1], ranges[1][1], ranges[2][1])
    const zl = Math.max(ranges[0][0], ranges[1][0], ranges[2][0])
    if (zl < zh) {
      const existing = centers[centers.length - 1]
      if (existing && zh >= existing.zl && zl <= existing.zh) {
        existing.zh = Math.max(existing.zh, zh)
        existing.zl = Math.min(existing.zl, zl)
        existing.bi_ids.push(b3.id)
        existing.status = 'expand'
      } else {
        centers.push({ id: centers.length + 1, zl, zh, level: '', bi_ids: [b1.id, b2.id, b3.id], status: 'range' })
      }
    }
  }
  return centers
}

// === Chan Theory: Divergence Detection ===
function detectDivergence(segments, bis, macdHist) {
  if (!ENABLE_DIVERGENCE || !macdHist || macdHist.length === 0) return { type: 'none', strength: 'none' }

  function calcArea(biIds) {
    let area = 0
    for (const bid of biIds) {
      const bi = bis.find(b => b.id === bid)
      if (!bi) continue
      for (let j = bi.start_idx; j <= bi.end_idx && j < macdHist.length; j++) {
        area += Math.abs(macdHist[j] || 0)
      }
    }
    return area
  }

  const sameDown = segments.filter(s => s.dir === 'down')
  if (sameDown.length >= 2) {
    const a = sameDown[sameDown.length - 2], b = sameDown[sameDown.length - 1]
    const areaA = calcArea(a.bi_ids), areaB = calcArea(b.bi_ids)
    if (areaB < areaA) return { type: 'bottom', strength: 'strong', area_cur: round2(areaB), area_prev: round2(areaA) }
  }
  const sameUp = segments.filter(s => s.dir === 'up')
  if (sameUp.length >= 2) {
    const a = sameUp[sameUp.length - 2], b = sameUp[sameUp.length - 1]
    const areaA = calcArea(a.bi_ids), areaB = calcArea(b.bi_ids)
    if (areaB < areaA) return { type: 'top', strength: 'strong', area_cur: round2(areaB), area_prev: round2(areaA) }
  }
  return { type: 'none', strength: 'none' }
}

// === Chan Theory: Assembly ===
function computeChan(rates, timeframe, macdHist) {
  if (!rates || rates.length < MIN_KLINES_FOR_CHAN) return { status: 'insufficient_klines' }
  const fractals = detectFractals(rates)
  const bis = buildBis(fractals, rates)
  if (bis.length < 3) return { status: 'insufficient_klines' }
  const segments = buildSegments(bis)
  const centers = buildCenters(bis)
  const lastCenter = centers.length > 0 ? centers[centers.length - 1] : null
  const lastSeg = segments.length > 0 ? segments[segments.length - 1] : null
  const lastBi = bis[bis.length - 1]
  const latest = parseFloat(rates[rates.length - 1].close)
  let priceVsCenter = 'none'
  if (lastCenter) {
    if (latest > lastCenter.zh) priceVsCenter = 'above'
    else if (latest < lastCenter.zl) priceVsCenter = 'below'
    else priceVsCenter = 'inside'
  }
  const divergence = detectDivergence(segments, bis, macdHist)
  return {
    status: 'ok',
    current_bi: lastBi ? { id: lastBi.id, dir: lastBi.dir, start_price: round5(lastBi.start_price), end_price: round5(lastBi.end_price) } : null,
    recent_bis: bis.slice(-FEED_LAST_N_BIS).map(b => ({ id: b.id, dir: b.dir, start_price: round5(b.start_price), end_price: round5(b.end_price) })),
    current_segment: lastSeg ? { id: lastSeg.id, dir: lastSeg.dir, start_price: round5(lastSeg.start_price), end_price: round5(lastSeg.end_price), broken: lastSeg.broken } : null,
    current_center: lastCenter ? { id: lastCenter.id, zl: round5(lastCenter.zl), zh: round5(lastCenter.zh), level: timeframe, status: lastCenter.status } : null,
    price_vs_center: priceVsCenter,
    divergence,
  }
}

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
