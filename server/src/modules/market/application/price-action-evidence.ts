import { unresolvedMarketGap, type ConfirmedMarketGap } from './confirmed-market-gaps.js'
import { calculatePriceActionEvents, type EventBar, type PriceActionEventScope } from '../domain/price-action-events.js'
import { sha256Canonical } from '../../../shared/canonical-json.js'

export interface PriceActionEvidenceContext extends PriceActionEventScope {
  referenceTime: string
  confirmedGaps?: ConfirmedMarketGap[]
  clock: { clockStatus: string; timezoneOffsetMinutes: number | null; observedAt: string; dailyCalibration?: boolean } | null
}

/** Full bounded calculation input is retained with the evidence, including rejected source facts. */
export function capturePriceActionEvidence(input: readonly EventBar[], context: PriceActionEvidenceContext) {
  const scope = structuredClone(context)
  // 20 reference bars + two trigger bars + seven older confirmation candidates + optional forming tail.
  const bars = input.slice(-30).map(({ openTime, open, high, low, close, closed }) => ({ openTime, open, high, low, close, closed }))
  const now = Date.parse(scope.referenceTime), age = now - Date.parse(scope.clock?.observedAt ?? '')
  const timeframeMs = { M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000 }[scope.timeframe]
  const validUtc = (value: string) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
  const invalid = !Number.isSafeInteger(scope.timeframeMs) || timeframeMs !== scope.timeframeMs || !validUtc(scope.referenceTime)
    || !/^[1-9]\d{0,19}$/.test(scope.sourceAccountId) || !/^[A-Za-z0-9._-]{1,64}$/.test(scope.symbol)
    || bars.some((bar, index) => !validUtc(bar.openTime) || Date.parse(bar.openTime) > now
      || typeof bar.closed !== 'boolean' || (!bar.closed && index !== bars.length - 1)
      || (bar.closed && Date.parse(bar.openTime) + scope.timeframeMs > now)
      || [bar.open, bar.high, bar.low, bar.close].some(price => typeof price !== 'string' || !/^(?:0|[1-9]\d{0,28})(?:\.\d{1,18})?$/.test(price) || Number(price) <= 0)
      || Number(bar.low) > Math.min(Number(bar.open), Number(bar.close)) || Number(bar.high) < Math.max(Number(bar.open), Number(bar.close)))
  const gap = unresolvedMarketGap(bars.map(bar => Date.parse(bar.openTime)), scope.timeframeMs, scope.confirmedGaps)
  const closed = bars.filter(bar => bar.closed)
  const reason = invalid ? 'event_candle_invalid' : gap ? 'event_history_gap_unresolved'
    : scope.clock?.clockStatus !== 'calibrated' || !validUtc(scope.clock.observedAt) || !Number.isFinite(age) || age < 0 || age > (scope.clock?.dailyCalibration ? 25 * 3600_000 : 300_000)
      || !Number.isInteger(scope.clock.timezoneOffsetMinutes) || Math.abs(scope.clock.timezoneOffsetMinutes!) > 840 ? 'event_clock_unavailable'
    : closed.length < 29 ? 'event_history_insufficient'
    : now - Date.parse(closed.at(-1)!.openTime) > Math.max(120_000, scope.timeframeMs * 2) ? 'event_source_stale' : null
  const events = reason ? [] : calculatePriceActionEvents(closed, scope)
  const evidence = { schemaVersion: 1, algorithmVersion: 'price_action_events/v1', state: reason ? 'unavailable' : 'ready', reason,
    sourceAccountId: scope.sourceAccountId, symbol: scope.symbol, timeframe: scope.timeframe, referenceTime: scope.referenceTime,
    gapPolicy: scope.confirmedGaps?.length ? 'terminal_confirmed/v1' : 'contiguous_only/v1', supportedKinds: ['two_closed_bar_breakout', 'reclaim'], events,
    input: { bars, context: scope } }
  return { ...evidence, evidenceHash: sha256Canonical(evidence) }
}

/** Recompute against frozen time and clock; never substitute today's candles for an old event. */
export function replayPriceActionEvidence(value: unknown): ReturnType<typeof capturePriceActionEvidence> {
  const fail = (): never => { throw new Error('price_action_evidence_invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const evidence = value as ReturnType<typeof capturePriceActionEvidence>
  if (evidence.schemaVersion !== 1 || evidence.algorithmVersion !== 'price_action_events/v1'
    || !evidence.input || !evidence.input.context || !Array.isArray(evidence.input.bars) || evidence.input.bars.length > 30
    || evidence.input.bars.some(bar => !bar || typeof bar !== 'object')) return fail()
  try {
    const result = capturePriceActionEvidence(evidence.input.bars, evidence.input.context)
    if (sha256Canonical(result) !== sha256Canonical(evidence)) return fail()
    return result
  } catch { return fail() }
}
