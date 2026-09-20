import { beforeEach, expect, it } from 'vitest'
import type { PublicMarketRealtimeEvent, PublicMarketSnapshotData } from '@aurum/contracts'
import { mergePublicHistory, applyPublicMarketEvent, applyPublicSnapshot } from '../src/features/home/public-market-state'
import { clearAccountRuntime, marketQuote, marketCandles, marketStructure } from '../src/features/home/home-runtime'

const snapshot: PublicMarketSnapshotData = { symbol: 'XAUUSD', timeframe: 'M5', status: 'cached',
  source_key: 'a'.repeat(64), source_generation: '1', candles: [], structure: null,
  quote: { bid: '2500', ask: '2500.2', last: null, spread: '0.2', observed_at: '2026-09-14T08:00:00Z', revision: '10' } }
function event(data: Partial<PublicMarketRealtimeEvent['data']> = {}): PublicMarketRealtimeEvent {
  return { v: 4, type: 'market.public.updated', event_id: 'market-event', occurred_at: '2026-09-14T08:00:01Z', sequence: 1,
    scope: { user_id: '1', trading_account_id: null, terminal_instance_id: null, observer_channel_id: null },
    resource: { kind: 'public_market', id: 'XAUUSD:quote' }, revision: '11', correlation_id: null,
    data: { symbol: 'XAUUSD', timeframe: null, source_key: snapshot.source_key!, source_generation: '1',
      quote: { ...snapshot.quote!, bid: '2501', revision: '11' }, candle: null, ...data } }
}
beforeEach(() => { clearAccountRuntime(); applyPublicSnapshot(snapshot) })
const liveBar = { open_time: '2026-09-14T08:00:00+00:00', open: '999.9', high: '999.9', low: '999.9', close: '999.9', tick_volume: '10', closed: false, revision: '1' }
function tick(bid: string, time: string, revision = '11') {
  return event({ quote: { ...snapshot.quote!, bid, observed_at: time, revision } })
}
it('updates OHLC numerically using quote time, leaving volume and server revision unchanged', () => {
  applyPublicSnapshot({ ...snapshot, quote: null, candles: [liveBar] })
  applyPublicMarketEvent(tick('1000.1', '2026-09-14T08:01:00Z'), 'XAUUSD', 'M5')
  expect(marketCandles.value[0]).toMatchObject({ open: '999.9', high: '1000.1', low: '999.9', close: '1000.1', tickVolume: '10', revision: 1 })
  applyPublicMarketEvent(tick('999.8', '2026-09-14T08:02:00Z', '12'), 'XAUUSD', 'M5')
  expect(marketCandles.value[0]).toMatchObject({ high: '1000.1', low: '999.8', close: '999.8' })
  applyPublicMarketEvent(tick('900', '2026-09-14T08:01:30Z', '13'), 'XAUUSD', 'M5')
  expect(marketCandles.value[0]?.close).toBe('999.8')
})
it('starts a provisional adjacent bar and replaces it with terminal data without duplicate timestamps', () => {
  applyPublicSnapshot({ ...snapshot, quote: null, candles: [liveBar] })
  applyPublicMarketEvent(tick('1001', '2026-09-14T08:05:01Z'), 'XAUUSD', 'M5')
  expect(marketCandles.value).toHaveLength(2)
  expect(marketCandles.value[1]).toMatchObject({ open: '1001', tickVolume: '0', revision: 0 })
  applyPublicMarketEvent(event({ quote: null, timeframe: 'M5', candle: { ...liveBar, open_time: '2026-09-14T08:05:00+00:00', open: '1000', close: '1002', high: '1002', revision: '2', tick_volume: '22' } }), 'XAUUSD', 'M5')
  expect(marketCandles.value).toHaveLength(2)
  expect(marketCandles.value[1]).toMatchObject({ open: '1000', close: '1002', tickVolume: '22', revision: 2 })
})
it('preserves broker H4 alignment and does not invent missing bars or mutate closed bars', () => {
  applyPublicSnapshot({ ...snapshot, timeframe: 'H4', quote: null, candles: [{ ...liveBar, open_time: '2026-09-14T05:00:00Z' }] })
  applyPublicMarketEvent(tick('1001', '2026-09-14T09:00:01Z'), 'XAUUSD', 'H4')
  expect(marketCandles.value[1]?.openTime).toBe('2026-09-14T09:00:00.000Z')
  applyPublicSnapshot({ ...snapshot, timeframe: 'M5', quote: null, candles: [{ ...liveBar, closed: true }] })
  applyPublicMarketEvent(tick('1001', '2026-09-14T08:01:00Z'), 'XAUUSD', 'M5')
  expect(marketCandles.value[0]?.close).toBe('999.9')
  applyPublicMarketEvent(tick('1002', '2026-09-14T09:00:00Z', '12'), 'XAUUSD', 'M5')
  expect(marketCandles.value).toHaveLength(1)
})
it('never invents a quote or candle when the snapshot is empty', () => {
  applyPublicSnapshot({ ...snapshot, status: 'unavailable', source_key: null, source_generation: null, quote: null })
  expect(marketQuote.value).toBeNull(); expect(marketCandles.value).toEqual([])
})
it('applies only newer revisions of the current symbol and source', () => {
  expect(applyPublicMarketEvent(event(), 'XAUUSD', 'M5')).toBe('applied')
  expect(marketQuote.value?.bid).toBe('2501')
  applyPublicMarketEvent(event({ quote: snapshot.quote }), 'XAUUSD', 'M5')
  expect(marketQuote.value?.bid).toBe('2501')
  expect(applyPublicMarketEvent(event({ symbol: 'EURUSD' }), 'XAUUSD', 'M5')).toBe('ignored')
  expect(marketQuote.value?.bid).toBe('2501')
})
it('requests a new snapshot before accepting a changed source', () => {
  expect(applyPublicMarketEvent(event({ source_key: 'b'.repeat(64), source_generation: '2' }), 'XAUUSD', 'M5')).toBe('resync')
  expect(marketQuote.value?.bid).toBe('2500')
})

it('resyncs Chan at rollover and accepts a delayed previous close by per-bar revision', () => {
  applyPublicSnapshot({ ...snapshot, quote: null, candles: [liveBar] })
  expect(applyPublicMarketEvent(tick('1001', '2026-09-14T08:05:01Z'), 'XAUUSD', 'M5')).toBe('resync')
  const current = event({ quote: null, timeframe: 'M5', candle: { ...liveBar, open_time: '2026-09-14T08:05:00Z', revision: '20' } })
  expect(applyPublicMarketEvent(current, 'XAUUSD', 'M5')).toBe('resync')
  const close = event({ quote: null, timeframe: 'M5', candle: { ...liveBar, closed: true, revision: '19' } })
  expect(applyPublicMarketEvent(close, 'XAUUSD', 'M5')).toBe('resync')
  expect(marketCandles.value[0]?.closed).toBe(true)
  expect(applyPublicMarketEvent(close, 'XAUUSD', 'M5')).toBe('applied')
  expect(applyPublicMarketEvent(current, 'XAUUSD', 'M5')).toBe('applied')
})

it('does not roll back a live quote while the structure snapshot is in flight', () => {
  const base = { ...snapshot, candles: [liveBar] }
  applyPublicSnapshot(base)
  applyPublicMarketEvent(tick('2502', '2026-09-14T08:01:00Z', '12'), 'XAUUSD', 'M5')
  applyPublicSnapshot(base)
  expect(marketQuote.value).toMatchObject({ bid: '2502', revision: 12 })
  expect(marketCandles.value.at(-1)?.close).toBe('2502')
  applyPublicMarketEvent(tick('2501', '2026-09-14T08:00:30Z', '11'), 'XAUUSD', 'M5')
  expect(marketQuote.value?.bid).toBe('2502')
})

it('uses quotes for candle rendering without repeatedly requesting Chan calculation inside the period', () => {
  applyPublicSnapshot({ ...snapshot, quote: null, candles: [liveBar] })
  expect(applyPublicMarketEvent(tick('1001', '2026-09-14T08:01:00Z'), 'XAUUSD', 'M5')).toBe('applied')
  expect(applyPublicMarketEvent(tick('1002', '2026-09-14T08:02:00Z', '12'), 'XAUUSD', 'M5')).toBe('applied')
})

it('deduplicates historical pages and retains older candles when the latest snapshot refreshes', () => {
  const candle = { open_time: '2026-09-14T08:00:00Z', open: '2500', high: '2501', low: '2499', close: '2500', tick_volume: '10', closed: true, revision: '1' }
  applyPublicSnapshot({ ...snapshot, candles: [candle] })
  const older = { ...candle, open_time: '2026-09-14T07:55:00Z' }
  expect(mergePublicHistory({ ...snapshot, candles: [older, candle] })).toBe(true)
  applyPublicSnapshot({ ...snapshot, candles: [candle] })
  expect(marketCandles.value.map(item => item.openTime)).toEqual([older.open_time, candle.open_time])
  expect(mergePublicHistory({ ...snapshot, timeframe: 'H1', candles: [older] })).toBe(false)
  expect(mergePublicHistory({ ...snapshot, source_key: 'b'.repeat(64), candles: [older] })).toBe(false)
  applyPublicSnapshot({ ...snapshot, source_key: 'b'.repeat(64), candles: [candle] })
  expect(marketCandles.value).toHaveLength(1)
})

it('merges confirmed historical Chan lines and retains them across a latest snapshot refresh', () => {
  const candle = { open_time: '2026-09-14T08:00:00Z', open: '2500', high: '2501', low: '2499', close: '2500', tick_volume: '10', closed: true, revision: '1' }
  const currentLine = { kind: 'bi' as const, from: '2026-09-14T07:00:00Z', to: candle.open_time, start: 2490, end: 2501 }
  const historicalLine = { kind: 'segment' as const, from: '2026-09-13T06:00:00Z', to: '2026-09-13T07:00:00Z', start: 2480, end: 2490 }
  const staleForming = { kind: 'forming_segment' as const, from: '2026-09-13T07:00:00Z', to: '2026-09-13T08:00:00Z', start: 2490, end: 2485 }
  const structure = { algorithm: 'chan_structure_v8' as const, status: 'ok', reliability: 'high' as const,
    based_on_closed_bars: 1800, trend: null, lines: [currentLine] }
  applyPublicSnapshot({ ...snapshot, candles: [candle], structure })
  expect(mergePublicHistory({ ...snapshot, candles: [], structure: { ...structure, lines: [historicalLine, staleForming] } })).toBe(true)
  expect(marketStructure.value?.lines).toEqual([historicalLine, currentLine])
  applyPublicSnapshot({ ...snapshot, candles: [candle], structure })
  expect(marketStructure.value?.lines).toEqual([historicalLine, currentLine])
})
