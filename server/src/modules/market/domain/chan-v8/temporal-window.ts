import type { ChanRate } from './types.js'
import type { ChanResult } from './chan-result.js'
import { computeChanWindow, type ChanWindowOptions } from './compute-window.js'
import { calculateMacdSeries } from './macd.js'
import { centerBootstrapIdentity, summarizeTemporalBootstrapEvidence } from './bootstrap-consensus.js'
const MIN_KLINES_FOR_CHAN = 30

export function buildFullWindowTemporalEvidence(rates: readonly ChanRate[], timeframe: string, options: ChanWindowOptions, primary: ChanResult) {
  const lastBarClosed = options?.dataQuality?.last_bar_closed === true
  const closedRates = Array.isArray(rates) ? (lastBarClosed ? rates.slice() : rates.slice(0, -1)) : []
  if (closedRates.length < MIN_KLINES_FOR_CHAN + 2 || !centerBootstrapIdentity(primary)) {
    return summarizeTemporalBootstrapEvidence([primary, null, null])
  }
  const snapshots: ChanResult[] = []
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
