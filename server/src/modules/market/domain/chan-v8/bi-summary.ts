import type { ChanBi, ChanFractal, ChanBar, ChanRate } from './types.js'
import { round5 } from './rounding.js'
export type BiSummaryInput = Partial<ChanBi> & Pick<ChanBi, 'dir' | 'start_price' | 'end_price'> & {
  start_raw_index?: number | null
  end_raw_index?: number | null
  start_time_utc_msc?: number | null
  end_time_utc_msc?: number | null
  start_broker_time?: string | number | null
  end_broker_time?: string | number | null
}

export function summarizeBi(bi: BiSummaryInput | null | undefined, rates: readonly ChanRate[] = []) {
  if (!bi) return null
  const startRawIndex = Number(bi.raw_start_idx ?? bi.start_raw_index)
  const endRawIndex = Number(bi.raw_end_idx ?? bi.end_raw_index)
  const startRate = Number.isFinite(startRawIndex) ? rates[startRawIndex] : null
  const endRate = Number.isFinite(endRawIndex) ? rates[endRawIndex] : null
  const startTimeUtcMs = Number(startRate?.time_utc_msc ?? bi.start_time_utc_msc)
  const endTimeUtcMs = Number(endRate?.time_utc_msc ?? bi.end_time_utc_msc)
  return {
    ...(bi.id == null ? {} : { id:bi.id }),
    dir:bi.dir,
    start_price:round5(bi.start_price),
    end_price:round5(bi.end_price),
    confirmed:bi.confirmed === true,
    start_raw_index:Number.isFinite(startRawIndex) ? startRawIndex : null,
    end_raw_index:Number.isFinite(endRawIndex) ? endRawIndex : null,
    start_broker_time:startRate?.time ?? bi.start_broker_time ?? null,
    end_broker_time:endRate?.time ?? bi.end_broker_time ?? null,
    start_time_utc_msc:Number.isFinite(startTimeUtcMs) && startTimeUtcMs > 0 ? startTimeUtcMs : null,
    end_time_utc_msc:Number.isFinite(endTimeUtcMs) && endTimeUtcMs > 0 ? endTimeUtcMs : null,
  }
}

export function summarizeLatestConfirmedFractal(fractals: readonly ChanFractal[], normalizedBars: readonly ChanBar[], rates: readonly ChanRate[]) {
  const fractal = Array.isArray(fractals) ? fractals.at(-1) : null
  if (!fractal) return null
  const extremeRawIndex = Number(fractal.extreme_raw_idx ?? fractal.raw_start_idx ?? fractal.raw_idx)
  const confirmationBar = Array.isArray(normalizedBars) ? normalizedBars[Number(fractal.idx) + 1] : null
  const confirmationRawIndex = Number(confirmationBar?.raw_end_idx ?? confirmationBar?.raw_idx)
  const extremeRate = Number.isFinite(extremeRawIndex) ? rates?.[extremeRawIndex] : null
  const confirmationRate = Number.isFinite(confirmationRawIndex) ? rates?.[confirmationRawIndex] : null
  const timeUtcMs = Number(extremeRate?.time_utc_msc)
  const confirmedByBarUtcMs = Number(confirmationRate?.time_utc_msc)
  return {
    type:fractal.type,
    price:round5(fractal.price),
    time:extremeRate?.time ?? fractal.time ?? null,
    time_utc_msc:Number.isFinite(timeUtcMs) ? timeUtcMs : null,
    confirmed_by_bar_time:confirmationRate?.time ?? null,
    confirmed_by_bar_time_utc_msc:Number.isFinite(confirmedByBarUtcMs) ? confirmedByBarUtcMs : null,
    confirmed:true,
  }
}
