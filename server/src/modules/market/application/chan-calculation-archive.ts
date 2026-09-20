import { sha256Canonical } from '../../../shared/canonical-json.js'
import { calculateChanMarketEvidence, calculateChanChartStructure } from './chan-market-evidence.js'

type Candle = Parameters<typeof calculateChanMarketEvidence>[0][number]
type Context = Parameters<typeof calculateChanMarketEvidence>[1]
// Use the same JSON projection persisted in inference snapshots (omit optional
// undefined diagnostics); do not hash an in-memory-only representation.
const serializedEvidence = (input: { candles: Candle[]; context: Context }): ReturnType<typeof calculateChanMarketEvidence> =>
  JSON.parse(JSON.stringify(calculateChanMarketEvidence(input.candles,input.context))) as ReturnType<typeof calculateChanMarketEvidence>
export interface ChanCalculationArchive {
  version: 'chan-calculation-archive/v1'
  algorithm: 'chan_structure_v8'
  input: { candles: Candle[]; context: Context }
  inputSha256: string
  outputSha256: string
}

/** Capture only calculation inputs; account balances and other snapshot fields are excluded. */
export function captureChanCalculation(items: readonly Candle[], context: Context) {
  if (items.length > 2000) throw new Error('chan_archive_input_invalid')
  const clock = context.clock ? { clockStatus: context.clock.clockStatus,
    timezoneOffsetMinutes: context.clock.timezoneOffsetMinutes, observedAt: context.clock.observedAt, ...(context.clock.dailyCalibration ? { dailyCalibration: true } : {}) } : null
  const input = { candles: items.map(({openTime,open,high,low,close,closed}) => ({openTime,open,high,low,close,closed})),
    context: { timeframe:context.timeframe,timeframeMs:context.timeframeMs,referenceTime:context.referenceTime,
      accountId:context.accountId,platform:context.platform,clock, ...(context.confirmedGaps ? { confirmedGaps: structuredClone(context.confirmedGaps) } : {}) } }
  const evidence = serializedEvidence(input)
  const archive: ChanCalculationArchive = { version:'chan-calculation-archive/v1',algorithm:'chan_structure_v8',input,
    inputSha256:sha256Canonical(input),outputSha256:sha256Canonical(evidence) }
  return { evidence,archive }
}

/** No clock, database, terminal or network reads are permitted while replaying. */
export function replayChanCalculation(archive: ChanCalculationArchive) {
  if (archive.version !== 'chan-calculation-archive/v1' || archive.algorithm !== 'chan_structure_v8'
    || !Array.isArray(archive.input?.candles) || archive.input.candles.length > 2000
    || sha256Canonical(archive.input) !== archive.inputSha256) throw new Error('chan_archive_input_invalid')
  const evidence = serializedEvidence(archive.input)
  if (sha256Canonical(evidence) !== archive.outputSha256) throw new Error('chan_archive_replay_mismatch')
  return evidence
}

export function replayChanChart(archive: ChanCalculationArchive) {
  replayChanCalculation(archive)
  return calculateChanChartStructure(archive.input.candles, archive.input.context)
}
