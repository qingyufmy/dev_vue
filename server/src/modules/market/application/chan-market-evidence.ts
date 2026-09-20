import { unresolvedMarketGap, type ConfirmedMarketGap } from './confirmed-market-gaps.js'
import { computeChan } from '../domain/chan-v8/compute-chan.js'
import { calculateMacdSeries } from '../domain/chan-v8/macd.js'
import { chanHistoryTarget } from '../domain/chan-v8/window-policy.js'
import { projectChanStructureForModel } from '../domain/chan-model-projection.js'
export { chanHistoryTarget }
interface Candle { openTime: string; open: string; high: string; low: string; close: string; closed: boolean }
interface Clock { clockStatus: string; timezoneOffsetMinutes: number | null; observedAt: string; dailyCalibration?: boolean }
/** Only UTC-normalized, ordered closed bars with proven current clock can support runtime structure.
 * Unexplained gaps stay unavailable; this adapter does not invent broker session calendars. */
function calculateChanWithStructure(items: readonly Candle[], input: {
  timeframe: string; timeframeMs: number; referenceTime: string; accountId: string; platform: string; clock: Clock | null; confirmedGaps?: ConfirmedMarketGap[]
}) {
  const target = chanHistoryTarget(input.timeframe), bars = items.slice(-target)
  const now = Date.parse(input.referenceTime), observed = Date.parse(input.clock?.observedAt ?? '')
  const clockAge = now - observed
  const clockValid = input.clock?.clockStatus === 'calibrated' && Number.isFinite(clockAge) && clockAge >= 0 && clockAge <= (input.clock?.dailyCalibration ? 25 * 3600_000 : 300_000)
    && Number.isInteger(input.clock.timezoneOffsetMinutes) && Math.abs(input.clock.timezoneOffsetMinutes!) <= 840
  const times = bars.map(bar => Date.parse(bar.openTime))
  const invalid = bars.some((bar, i) => !Number.isSafeInteger(times[i]) || times[i]! <= 0 || times[i]! > now
    || (i > 0 && times[i]! <= times[i - 1]!) || (!bar.closed && i !== bars.length - 1)
    || (bar.closed && times[i]! + input.timeframeMs > now)
    || [bar.open,bar.high,bar.low,bar.close].some(value => !Number.isFinite(Number(value)) || Number(value) <= 0)
    || Number(bar.low) > Math.min(Number(bar.open),Number(bar.close)) || Number(bar.high) < Math.max(Number(bar.open),Number(bar.close)))
  const gap = unresolvedMarketGap(times, input.timeframeMs, input.confirmedGaps)
  const stale = !bars.length || now - times.at(-1)! > Math.max(120_000, input.timeframeMs * 2)
  const rates = invalid ? [] : bars.map((bar,i) => ({ open:bar.open,high:bar.high,low:bar.low,close:bar.close,time:bar.openTime,time_utc_msc:times[i]! }))
  const result = computeChan(rates,input.timeframe,calculateMacdSeries(rates.map(bar=>Number(bar.close))).histSeries,{
    dataQuality:{ platform:input.platform,source_id:Number(input.accountId),clock_status:clockValid && !stale ? 'verified' : 'unknown',
      timezone_offset_minutes:input.clock?.timezoneOffsetMinutes,clock_sample_age_ms:clockAge,
      last_bar_closed:bars.at(-1)?.closed === true,cache_internal_gap_unresolved:gap || invalid,
      continuity_complete:!gap && !invalid,continuity_status:gap || invalid ? 'suspicious_gap' : 'continuous' },
  })
  const evidence = { algorithm_version:'chan_structure_v8',source_account_id:input.accountId,timeframe:input.timeframe,
    requested_bars:target,received_bars:bars.length,gap_policy:input.confirmedGaps?.length ? 'terminal_confirmed/v1' : 'contiguous_only/v1',
    reason:invalid ? 'chan_candle_invalid' : gap ? 'chan_history_gap_unresolved' : stale ? 'chan_source_stale' : !clockValid ? 'chan_clock_unavailable' : result.status,
    structure:projectChanStructureForModel(result) }
  return { evidence, result }
}

export function calculateChanMarketEvidence(...args: Parameters<typeof calculateChanWithStructure>) { return calculateChanWithStructure(...args).evidence }
export function calculateChanChartStructure(...args: Parameters<typeof calculateChanWithStructure>) { return calculateChanWithStructure(...args).result }
