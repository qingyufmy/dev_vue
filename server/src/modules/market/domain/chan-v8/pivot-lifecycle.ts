import type { ChanFractal, ChanRate, ChanDirection } from './types.js'
import { round5 } from './rounding.js'

export function inspectActivePivotLifecycle(activePivot: ChanFractal | null | undefined, closedRates: readonly ChanRate[]) {
  if (!activePivot || !Array.isArray(closedRates) || closedRates.length === 0) {
    return {
      state:'unavailable', origin_breached:false, breach_price:null, breach_raw_index:null,
      breach_time:null, breach_time_utc_msc:null, continuation_extreme_price:null,
      continuation_extreme_raw_index:null, continuation_extreme_time:null,
      continuation_extreme_time_utc_msc:null,
    }
  }
  const pivotRawEnd = Number(activePivot.extreme_raw_idx ?? activePivot.raw_end_idx ?? activePivot.raw_idx)
  const afterPivotIndex = Number.isFinite(pivotRawEnd) ? pivotRawEnd + 1 : closedRates.length
  const startIndex = Math.max(afterPivotIndex, 0)
  const postPivotRates = closedRates.slice(startIndex)
  let extreme: { price: number; rawIndex: number; rate: ChanRate | undefined } | null = null
  for (let offset = 0; offset < postPivotRates.length; offset++) {
    const rate = postPivotRates[offset]
    const price = Number(activePivot.type === 'bottom' ? rate?.low : rate?.high)
    if (!Number.isFinite(price)) continue
    if (!extreme || (activePivot.type === 'bottom' ? price < extreme.price : price > extreme.price)) {
      extreme = { price, rawIndex:startIndex + offset, rate }
    }
  }
  const pivotPrice = Number(activePivot.price)
  const originBreached = Boolean(extreme && Number.isFinite(pivotPrice) && (
    activePivot.type === 'bottom' ? extreme.price < pivotPrice
      : activePivot.type === 'top' ? extreme.price > pivotPrice : false
  ))
  const extremeTimeUtcMs = Number(extreme?.rate?.time_utc_msc)
  return {
    state:originBreached ? 'origin_breached' : 'active',
    origin_breached:originBreached,
    breach_price:originBreached ? round5(extreme!.price) : null,
    breach_raw_index:originBreached ? extreme!.rawIndex : null,
    breach_time:originBreached ? extreme!.rate?.time ?? null : null,
    breach_time_utc_msc:originBreached && Number.isFinite(extremeTimeUtcMs) && extremeTimeUtcMs > 0 ? extremeTimeUtcMs : null,
    continuation_extreme_price:originBreached ? round5(extreme!.price) : null,
    continuation_extreme_raw_index:originBreached ? extreme!.rawIndex : null,
    continuation_extreme_time:originBreached ? extreme!.rate?.time ?? null : null,
    continuation_extreme_time_utc_msc:originBreached && Number.isFinite(extremeTimeUtcMs) && extremeTimeUtcMs > 0 ? extremeTimeUtcMs : null,
  }
}

export function buildDevelopingBi(activePivot: ChanFractal | null | undefined, closedRates: readonly ChanRate[], pivotLifecycle: ReturnType<typeof inspectActivePivotLifecycle> | null = null) {
  if (!activePivot || !Array.isArray(closedRates) || closedRates.length === 0) return null
  const lifecycle = pivotLifecycle || inspectActivePivotLifecycle(activePivot, closedRates)
  if (lifecycle.state !== 'active') return null
  const pivotRawEnd = Number(activePivot.extreme_raw_idx ?? activePivot.raw_end_idx ?? activePivot.raw_idx)
  const afterPivotIndex = Number.isFinite(pivotRawEnd) ? pivotRawEnd + 1 : closedRates.length
  const startIndex = Math.max(afterPivotIndex, 0)
  const developingRates = closedRates.slice(startIndex)
  const pivotRate = Number.isFinite(pivotRawEnd) ? closedRates[pivotRawEnd] : null
  const summarizeDevelopingBi = (dir: ChanDirection, endPrice: number, endRawIndex: number | null) => {
    const endRate = Number.isFinite(endRawIndex) ? closedRates[endRawIndex!] : null
    const startTimeUtcMs = Number(pivotRate?.time_utc_msc)
    const endTimeUtcMs = Number(endRate?.time_utc_msc)
    return {
      dir,
      start_price:round5(activePivot.price),
      end_price:round5(endPrice),
      confirmed:false,
      start_raw_index:Number.isFinite(pivotRawEnd) ? pivotRawEnd : null,
      end_raw_index:Number.isFinite(endRawIndex) ? endRawIndex : null,
      start_broker_time:pivotRate?.time ?? activePivot.time ?? null,
      end_broker_time:endRate?.time ?? null,
      start_time_utc_msc:Number.isFinite(startTimeUtcMs) && startTimeUtcMs > 0 ? startTimeUtcMs : null,
      end_time_utc_msc:Number.isFinite(endTimeUtcMs) && endTimeUtcMs > 0 ? endTimeUtcMs : null,
    }
  }
  if (activePivot.type === 'bottom') {
    let developingHigh = NaN
    let developingHighRawIndex: number | null = null
    developingRates.forEach((rate, offset) => {
      const high = Number(rate?.high)
      if (Number.isFinite(high) && (!Number.isFinite(developingHigh) || high > developingHigh)) {
        developingHigh = high
        developingHighRawIndex = startIndex + offset
      }
    })
    return Number.isFinite(developingHigh) && developingHigh > activePivot.price
      ? summarizeDevelopingBi('up', developingHigh, developingHighRawIndex)
      : null
  }
  if (activePivot.type === 'top') {
    let developingLow = NaN
    let developingLowRawIndex: number | null = null
    developingRates.forEach((rate, offset) => {
      const low = Number(rate?.low)
      if (Number.isFinite(low) && (!Number.isFinite(developingLow) || low < developingLow)) {
        developingLow = low
        developingLowRawIndex = startIndex + offset
      }
    })
    return Number.isFinite(developingLow) && developingLow < activePivot.price
      ? summarizeDevelopingBi('down', developingLow, developingLowRawIndex)
      : null
  }
  return null
}
