import type { ChanRate, ChanBar, ChanFractal } from './types.js'

export function normalizeBarsForChan(rates: readonly ChanRate[]) {
  const bars: ChanBar[] = []
  for (let i = 0; i < rates.length; i++) {
    const h = parseFloat(String(rates[i]!.high))
    const l = parseFloat(String(rates[i]!.low))
    const o = parseFloat(String(rates[i]!.open))
    const c = parseFloat(String(rates[i]!.close))
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(o) || !Number.isFinite(c)) continue
    if (h < l) continue
    bars.push({
      idx: bars.length, raw_idx: i, raw_start_idx: i, raw_end_idx: i,
      high_raw_idx: i, low_raw_idx: i,
      high: h, low: l, open: o, close: c, time: rates[i]!.time,
    })
  }
  if (bars.length < 3) return bars.map((bar, idx) => ({ ...bar, idx }))

  const merged = [bars[0]!]
  let direction = 0
  function inferInitialDirection(reference: ChanBar, fromIndex: number) {
    for (let j = fromIndex; j < bars.length; j++) {
      const probe = bars[j]!
      if (probe.high > reference.high && probe.low > reference.low) return 1
      if (probe.high < reference.high && probe.low < reference.low) return -1
    }
    const last = bars[bars.length - 1]!
    return last.close >= reference.close ? 1 : -1
  }
  for (let i = 1; i < bars.length; i++) {
    const prev = merged[merged.length - 1]!
    const cur = bars[i]!
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
export function detectFractals(bars: readonly ChanBar[]) {
  if (bars.length < 3) return []
  const fractals: ChanFractal[] = []
  for (let i = 1; i < bars.length - 1; i++) {
    const p = bars[i - 1]!, c = bars[i]!, n = bars[i + 1]!
    if (c.high > p.high && c.high > n.high && c.low > p.low && c.low > n.low) {
      fractals.push({ idx: c.idx, raw_start_idx: c.raw_start_idx, raw_end_idx: c.raw_end_idx, extreme_raw_idx: c.high_raw_idx, type: 'top', price: c.high, high: c.high, low: c.low, time: c.time })
    } else if (c.low < p.low && c.low < n.low && c.high < p.high && c.high < n.high) {
      fractals.push({ idx: c.idx, raw_start_idx: c.raw_start_idx, raw_end_idx: c.raw_end_idx, extreme_raw_idx: c.low_raw_idx, type: 'bottom', price: c.low, high: c.high, low: c.low, time: c.time })
    }
  }
  // Ensure alternating and deduplicate same-type
  const cleaned: ChanFractal[] = []
  for (const f of fractals) {
    if (cleaned.length === 0) { cleaned.push(f); continue }
    const last = cleaned[cleaned.length - 1]!
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
