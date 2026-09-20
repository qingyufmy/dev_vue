import { expect, it, vi } from 'vitest'
import { capturePriceActionEvidence, replayPriceActionEvidence } from '../src/modules/market/index.js'
import { compileStrategy } from '../src/modules/strategies/application/strategy-service.js'
import { marketPlan } from '../src/modules/inference/application/analysis-context-builder.js'
import { TradingAnalysisMarketSource } from '../src/modules/inference/infrastructure/trading-analysis-market-source.js'
import type { AnalysisTradingReader } from '../src/modules/inference/index.js'

const now = '2026-09-13T04:00:00.000Z', end = Date.parse(now), step = 300_000
function fixture() {
  const bars = Array.from({ length: 35 }, (_, index) => ({ openTime: new Date(end - (35 - index) * step).toISOString(),
    open: '100', high: '101', low: '99', close: '100', closed: true }))
  Object.assign(bars[30]!, { open: '102', high: '105', low: '101', close: '104' })
  Object.assign(bars[31]!, { open: '104', high: '106', low: '103', close: '105' })
  Object.assign(bars[32]!, { open: '100', high: '101', low: '98', close: '99' })
  Object.assign(bars[33]!, { open: '99', high: '100', low: '97', close: '98' })
  Object.assign(bars[34]!, { open: '98', high: '99', low: '96', close: '97' })
  const context = { sourceAccountId: '5', symbol: 'XAUUSD', timeframe: 'M5', timeframeMs: step, referenceTime: now,
    clock: { clockStatus: 'calibrated', timezoneOffsetMinutes: 180, observedAt: now } }
  return { bars, context }
}

it('retains stable breakout and confirmed reclaim identities with independent validity', () => {
  const f = fixture(), result = capturePriceActionEvidence(f.bars, f.context)
  expect(result.state).toBe('ready')
  expect(result.events).toHaveLength(2)
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'two_closed_bar_breakout', direction: 'up', stillValid: false, confirmationBarTime: f.bars[31]!.openTime }),
    expect.objectContaining({ kind: 'reclaim', direction: 'down', stillValid: true, confirmationBarTime: f.bars[33]!.openTime }),
  ]))
  const next = { ...f.bars[34]!, openTime: now, closed: false }
  const appended = capturePriceActionEvidence([...f.bars, next], { ...f.context, referenceTime: new Date(end + 1000).toISOString() })
  expect(appended.events).toEqual(result.events)
  expect(capturePriceActionEvidence(f.bars.slice(-30), f.context).events).toEqual(result.events)
  expect(result.input.bars).toHaveLength(30)
  expect(replayPriceActionEvidence(JSON.parse(JSON.stringify(result)))).toEqual(result)
})

it('does not change identity when non-defining price metadata changes', () => {
  const f = fixture(), before = capturePriceActionEvidence(f.bars, f.context)
  f.bars[31]!.high = '107'
  const after = capturePriceActionEvidence(f.bars, f.context)
  expect(after.events.map(event => event.id)).toEqual(before.events.map(event => event.id))
  expect(after.evidenceHash).not.toBe(before.evidenceHash)
})

it.each(['account', 'symbol', 'timeframe'])('isolates event identity by %s', field => {
  const f = fixture(), first = capturePriceActionEvidence(f.bars, f.context)
  if (field === 'account') f.context.sourceAccountId = '6'
  if (field === 'symbol') f.context.symbol = 'EURUSD'
  if (field === 'timeframe') {
    f.context.timeframe = 'M1'; f.context.timeframeMs = 60_000
    f.bars.forEach((bar, index) => { bar.openTime = new Date(end - (35 - index) * 60_000).toISOString() })
  }
  const second = capturePriceActionEvidence(f.bars, f.context)
  expect(second.state).toBe('ready')
  expect(second.events.every(event => !first.events.some(original => event.id === original.id))).toBe(true)
})

it.each(['clock', 'gap', 'future', 'forming-middle', 'ohlc', 'short', 'stale'])('does not invent events from %s data', kind => {
  const f = fixture()
  if (kind === 'clock') f.context.clock.clockStatus = 'unknown'
  if (kind === 'gap') f.bars.splice(15, 1)
  if (kind === 'future') f.bars[34]!.openTime = now
  if (kind === 'forming-middle') f.bars[10]!.closed = false
  if (kind === 'ohlc') f.bars[10]!.high = '10'
  if (kind === 'short') f.bars = f.bars.slice(-28)
  if (kind === 'stale') { f.context.referenceTime = new Date(end + step * 3).toISOString(); f.context.clock.observedAt = f.context.referenceTime }
  const result = capturePriceActionEvidence(f.bars, f.context)
  expect(result.state).toBe('unavailable'); expect(result.events).toEqual([])
  expect(replayPriceActionEvidence(result)).toEqual(result)
})

it('rejects altered frozen inputs, output identity or hash', () => {
  const f = fixture(), value = capturePriceActionEvidence(f.bars, f.context)
  for (const field of ['input', 'output', 'hash']) {
    const copy = structuredClone(value)
    if (field === 'input') copy.input.bars[0]!.close = '100.1'
    if (field === 'output') copy.events[0]!.id = 'event:' + '0'.repeat(64)
    if (field === 'hash') copy.evidenceHash = '0'.repeat(64)
    expect(() => replayPriceActionEvidence(copy)).toThrow('price_action_evidence_invalid')
  }
})

it('compiles the explicit evidence switch and carries bounded inputs into the frozen market snapshot', async () => {
  const f = fixture(), config = { timeframes: ['M5'], candle_limit: 100, price_action_evidence: { version: 1, enabled: true } }
  const compiled = compileStrategy('analysis', 'objective evidence', config)
  expect(compiled.valid).toBe(true)
  expect(marketPlan(compiled.normalizedConfig).priceAction).toEqual(config.price_action_evidence)
  for (const bad of [{ version: 2, enabled: true }, { version: 1, enabled: true, guess: true }, true]) {
    expect(compileStrategy('analysis', 'objective evidence', { ...config, price_action_evidence: bad }).valid).toBe(false)
  }
  const clock = vi.fn(async () => f.context.clock)
  const reader = { findOwnedAccount: async () => null, listAccounts: async () => [{ id: '5', bridgeState: 'online', platform: 'mt5', server: 'fixture' }],
    getQuote: async () => ({ bid: '100', ask: '101', observedAt: now }), getAccountSnapshot: clock,
    listCandles: async () => f.bars.map(bar => ({ ...bar, accountId: '5', symbol: 'XAUUSD', timeframe: 'M5', tickVolume: '1', revision: 1 })) } as unknown as AnalysisTradingReader
  const source = new TradingAnalysisMarketSource(reader)
  const value = await source.read({ userId: 7, preferredAccountId: null, symbol: 'XAUUSD', referenceTime: now, plan: marketPlan(compiled.normalizedConfig) })
  expect(value).toMatchObject({ events: { M5: { state: 'ready', events: expect.any(Array), input: { bars: expect.any(Array) } } } })
  const disabled = await source.read({ userId: 7, preferredAccountId: null, symbol: 'XAUUSD', referenceTime: now,
    plan: marketPlan({ ...config, price_action_evidence: { version: 1, enabled: false } }) })
  expect(disabled).not.toHaveProperty('events')
  expect(clock).toHaveBeenCalledTimes(1)
})

 it('uses a daily public calibration without weakening candle freshness or legacy clock checks', () => {
  const f = fixture(), observedAt = new Date(end - 12 * 3600_000).toISOString()
  const context = { ...f.context, clock: { ...f.context.clock, observedAt, dailyCalibration: true } }
  expect(capturePriceActionEvidence(f.bars, context).state).toBe('ready')
  expect(capturePriceActionEvidence(f.bars, { ...context, clock: { ...context.clock, dailyCalibration: false } }).reason).toBe('event_clock_unavailable')
  expect(capturePriceActionEvidence(f.bars, { ...context, clock: { ...context.clock, observedAt: new Date(end - 26 * 3600_000).toISOString() } }).reason).toBe('event_clock_unavailable')
  expect(capturePriceActionEvidence(f.bars, { ...context, referenceTime: new Date(end + step * 3).toISOString() }).reason).toBe('event_source_stale')
  expect(replayPriceActionEvidence(capturePriceActionEvidence(f.bars, context)).state).toBe('ready')
 })

it('replays a terminal-confirmed interval but keeps other gaps unavailable', () => {
 const f=fixture(), bars=f.bars.filter((_,i)=>i!==20)
 const confirmedGaps=[{from:f.bars[19]!.openTime,to:f.bars[21]!.openTime}]
 const evidence=capturePriceActionEvidence(bars,{...f.context,confirmedGaps})
 expect(evidence.reason).toBeNull()
 expect(replayPriceActionEvidence(evidence)).toEqual(evidence)
 expect(capturePriceActionEvidence(bars,f.context).reason).toBe('event_history_gap_unresolved')
})
