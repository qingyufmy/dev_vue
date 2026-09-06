import { describe, expect, it } from 'vitest'
import { calculateEma34Evidence } from '../server/src/modules/strategies/domain/ema34-evidence.ts'
import { calculateIndicator } from '../server/routes/ai/indicator-registry.js'

const base = Date.parse('2026-01-01T00:00:00Z')
const bars = count => Array.from({ length: count }, (_, i) => ({ openTimeUtcMs: base + i * 60_000, close: String(100 + Math.sin(i / 4) * 8 + i / 10), closed: true }))
const source = count => ({ timeframeMs: 60_000, referenceTimeUtcMs: base + count * 60_000, internalGapUnresolved: false })
const definition = { id: 'ema34', kind: 'ema', enabled: true, source: { timeframe: 'M1', field: 'close', bar_scope: 'closed_only' },
  params: { period: 34, minimum_bars: 34, warmup_target_bars: 60, evidence_window: 5 } }

describe('V4 EMA34 migration parity', () => {
  it.each([34, 35, 59, 60, 90])('matches the legacy SMA seed, EMA and complete analysis at %i bars', count => {
    const input = bars(count), current = calculateEma34Evidence(input, source(count))
    const previous = calculateIndicator(definition, input.map(row => ({ time_utc_msc: row.openTimeUtcMs, close: row.close })),
      { lastBarClosed: true, internalGapUnresolved: false, referenceTimeUtcMs: source(count).referenceTimeUtcMs })
    expect(current.ready).toBe(true)
    expect(current.value).toBe(previous.value)
    expect(current.analysis).toEqual(previous.analysis)
  })
  it('does not represent insufficient history as zero and distinguishes minimum from warmup', () => {
    expect(calculateEma34Evidence(bars(30), source(30))).toMatchObject({ ready: false, value: null, reason: 'indicator_history_insufficient' })
    expect(calculateEma34Evidence(bars(34), source(34)).analysis).toMatchObject({ warmup_complete: false, evidence_quality: 'limited' })
    expect(calculateEma34Evidence(bars(60), source(60)).analysis).toMatchObject({ warmup_complete: true, evidence_quality: 'reliable' })
  })
  it('excludes a trailing unclosed candle and preserves original input', () => {
    const input = [...bars(60), { openTimeUtcMs: base + 60 * 60_000, close: '9999999', closed: false }]
    const before = structuredClone(input)
    expect(calculateEma34Evidence(input, source(60))).toEqual(calculateEma34Evidence(bars(60), source(60)))
    expect(input).toEqual(before)
  })
  it('rejects future closed bars, stale evidence and known unresolved gaps', () => {
    expect(calculateEma34Evidence(bars(61), source(60)).reason).toBe('indicator_future_closed_bar')
    expect(calculateEma34Evidence(bars(60), source(63)).reason).toBe('indicator_source_stale')
    expect(calculateEma34Evidence(bars(60), { ...source(60), internalGapUnresolved: true }).reason).toBe('indicator_internal_gap_unresolved')
  })
  it('rejects duplicate time, missing close proof, internal open candles and malformed prices', () => {
    for (const [change, reason] of [[{ openTimeUtcMs: base }, 'indicator_bar_time_invalid'], [{ closed: undefined }, 'indicator_bar_close_state_unknown'],
      [{ closed: false }, 'indicator_internal_open_bar'], [{ close: 'NaN' }, 'indicator_non_finite_value']]) {
      const input = bars(60); Object.assign(input[10], change)
      expect(calculateEma34Evidence(input, source(60))).toMatchObject({ ready: false, value: null, reason })
    }
  })
})
