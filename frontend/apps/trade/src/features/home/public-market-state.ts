import type { PublicMarketSnapshotData as Snapshot, PublicMarketRealtimeEvent as Event, Timeframe } from '@aurum/contracts'
import type { ChartCandle } from './home-runtime'
import { marketQuote, marketCandles, marketSourceKey, marketStructure, resourceRevisions } from './home-runtime'
import { applyTerminalMarketObservation } from '~/features/trading-context'
function quote(value: NonNullable<Snapshot['quote']>, symbol: string) {
  return { symbol, bid: value.bid, ask: value.ask, last: value.last, spread: value.spread, observedAt: value.observed_at, revision: Number(value.revision) }
}
function candle(value: Snapshot['candles'][number], symbol: string, timeframe: Snapshot['timeframe']) {
  return { symbol, timeframe, openTime: value.open_time, open: value.open, high: value.high, low: value.low, close: value.close,
    tickVolume: value.tick_volume, closed: value.closed, revision: Number(value.revision) }
}

type Structure = Snapshot['structure']
type StructureLine = NonNullable<Structure>['lines'][number]

function lineKey(line: StructureLine) {
  return `${line.kind}:${line.from}:${line.to}:${line.start}:${line.end}`
}

function mergeLines(...groups: readonly StructureLine[][]) {
  const lines = new Map<string, StructureLine>()
  for (const group of groups) for (const line of group) lines.set(lineKey(line), line)
  return [...lines.values()].sort((a, b) => Date.parse(a.from) - Date.parse(b.from)
    || Date.parse(a.to) - Date.parse(b.to) || a.kind.localeCompare(b.kind))
}

function mergeHistoricalStructure(current: Structure, historical: Structure) {
  if (!current || !historical || current.algorithm !== historical.algorithm) return current
  const confirmed = historical.lines.filter(line => line.kind !== 'forming_segment')
  return { ...current, lines: mergeLines(confirmed, current.lines) }
}

function retainLoadedHistory(current: Structure, previous: Structure, currentWindowStart: string | undefined) {
  if (!current || !previous || current.algorithm !== previous.algorithm || !currentWindowStart) return current
  const cutoff = Date.parse(currentWindowStart)
  const historical = previous.lines.filter(line => line.kind !== 'forming_segment' && Date.parse(line.to) < cutoff)
  return { ...current, lines: mergeLines(historical, current.lines) }
}

const TIMEFRAME_MS: Record<Timeframe, number> = { M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000 }

/** Sync the last candle's OHLC with the latest real-time quote bid price. */
function syncLastCandleWithQuote(symbol: string, timeframe: Timeframe) {
  const q = marketQuote.value
  if (!q || q.symbol !== symbol) return
  const last = marketCandles.value.at(-1)
  if (!last || last.timeframe !== timeframe || last.symbol !== symbol) return
  const elapsed = Date.parse(q.observedAt) - Date.parse(last.openTime)
  const duration = TIMEFRAME_MS[timeframe]
  const bid = q.bid
  const price = Number(bid)
  if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(price) || price <= 0) return
  // Anchor to the terminal's last bar, preserving broker H4/D1 alignment.
  // Do not fabricate bars across missing periods after disconnection/weekends.
  if (elapsed >= duration) {
    if (elapsed >= duration * 2) return
    marketCandles.value = [...marketCandles.value, { ...last,
      openTime: new Date(Date.parse(last.openTime) + duration).toISOString(),
      open: bid, high: bid, low: bid, close: bid, tickVolume: '0', closed: false, revision: 0 }]
    return
  }
  if (last.closed) return
  if (bid === last.close && price <= Number(last.high) && price >= Number(last.low)) return
  const high = price > Number(last.high) ? bid : last.high
  const low = price < Number(last.low) ? bid : last.low
  // Local rendering must never advance the server's revision watermark.
  const updated: ChartCandle = { ...last, high, low, close: bid }
  marketCandles.value = [...marketCandles.value.slice(0, -1), updated]
}
export function syncCandleWithQuote() {
  const last = marketCandles.value.at(-1)
  if (!last) return
  syncLastCandleWithQuote(last.symbol, last.timeframe)
}

export function mergePublicHistory(data: Snapshot) {
  if (!data.source_key || data.source_key !== marketSourceKey.value
    || marketCandles.value.some(item => item.symbol !== data.symbol || item.timeframe !== data.timeframe)) return false
  const items = new Map(marketCandles.value.map(item => [Date.parse(item.openTime), item]))
  for (const value of data.candles) {
    const next = candle(value, data.symbol, data.timeframe)
    const time = Date.parse(next.openTime)
    if (!items.has(time) || items.get(time)!.revision <= next.revision) items.set(time, next)
  }
  marketCandles.value = [...items.values()].sort((a, b) => a.openTime.localeCompare(b.openTime))
  marketStructure.value = mergeHistoricalStructure(marketStructure.value, data.structure)
  return true
}
export function applyPublicSnapshot(data: Snapshot) {
  applyTerminalMarketObservation(null)
  const preserve = data.source_key === marketSourceKey.value && marketCandles.value[0]?.symbol === data.symbol && marketCandles.value[0]?.timeframe === data.timeframe
  const previousStructure = marketStructure.value
  const newerQuote = preserve && marketQuote.value && data.quote
    && marketQuote.value.revision > Number(data.quote.revision) ? marketQuote.value : null
  marketSourceKey.value = data.source_key
  marketQuote.value = newerQuote ?? (data.quote ? quote(data.quote, data.symbol) : null)
  marketStructure.value = preserve ? retainLoadedHistory(data.structure, previousStructure, data.candles[0]?.open_time) : data.structure
  if (preserve) mergePublicHistory(data)
  else marketCandles.value = data.candles.map(value => candle(value, data.symbol, data.timeframe))
  resourceRevisions.value.quote = marketQuote.value?.revision ?? 0
  resourceRevisions.value.candle = Math.max(0, ...marketCandles.value.map(value => value.revision))
  syncCandleWithQuote()
}
export function applyPublicMarketEvent(event: Event, symbol: string, timeframe: Snapshot['timeframe']) {
  const data = event.data
  if (data.symbol !== symbol || data.timeframe !== null && data.timeframe !== timeframe) return 'ignored'
  if (data.source_key !== marketSourceKey.value) return 'resync'
  const previousLast = marketCandles.value.at(-1)
  let quoteUpdated = false
  if (data.quote && Number(data.quote.revision) > resourceRevisions.value.quote) {
    if (!marketQuote.value || Date.parse(data.quote.observed_at) >= Date.parse(marketQuote.value.observedAt)) {
      marketQuote.value = quote(data.quote, symbol)
      quoteUpdated = true
    }
    resourceRevisions.value.quote = Number(data.quote.revision)
  }
  let closedCandleUpdated = false
  if (data.candle) {
    const next = candle(data.candle, symbol, timeframe)
    const previous = marketCandles.value.find(item => Date.parse(item.openTime) === Date.parse(next.openTime))
    // Compare the same bar, not the newest bar's watermark: a delayed close
    // can arrive after the terminal has already published the next candle.
    if (!previous || next.revision > previous.revision) {
      marketCandles.value = [...marketCandles.value.filter(item => Date.parse(item.openTime) !== Date.parse(next.openTime)), next]
        .sort((a, b) => a.openTime.localeCompare(b.openTime))
      resourceRevisions.value.candle = Math.max(resourceRevisions.value.candle, next.revision)
      closedCandleUpdated = next.closed || previous?.revision === 0
    }
  }
  if (quoteUpdated) syncCandleWithQuote()
  const rolledOver = previousLast && Date.parse(marketCandles.value.at(-1)!.openTime) > Date.parse(previousLast.openTime)
  // Rollover also repairs a close notification coalesced by the relay.
  return closedCandleUpdated || rolledOver ? 'resync' : 'applied'
}
