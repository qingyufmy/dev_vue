import type { ChanBar, ChanBi, ChanFractal } from './types.js'

const MIN_BARS_PER_BI = 5

export function buildBis(fractals: readonly ChanFractal[], _bars: readonly ChanBar[]) {
  const pivots: ChanFractal[] = []
  for (const f of fractals) {
    if (pivots.length === 0) { pivots.push(f); continue }
    const last = pivots[pivots.length - 1]!
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
  const bis: ChanBi[] = []
  const runs: ChanBi[][] = []
  let invalidCount = 0
  let runId = 1
  let currentRun: ChanBi[] = []
  let lastDiscontinuity: { pivot_index: number; processed_index: number; raw_index: number } | null = null
  let anchor = pivots[0]
  for (let i = 1; i < pivots.length; i++) {
    const s = anchor!, e = pivots[i]!
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
    const bi: ChanBi = {
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
  return { bis, runs, invalidCount, activeRunId: runId, activePivot: anchor || null, lastDiscontinuity }
}
