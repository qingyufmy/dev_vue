import { expect, it } from 'vitest'
import { frozenAnalysisAtr } from '../src/modules/inference/domain/frozen-analysis-atr.js'
import type { JsonObject } from '../src/modules/inference/domain/inference.js'

const capturedAt = '2026-09-09T00:00:00.000Z'
function bars(hours = 1): JsonObject[] {
  return Array.from({ length: 15 }, (_, i) => ({ open_time: new Date(Date.parse(capturedAt) - (15 - i) * hours * 3_600_000).toISOString(),
    open: '10', high: '12', low: '9', close: '11', closed: true }))
}
it('computes fourteen true ranges from fifteen closed bars with H1 priority', () => {
  expect(frozenAnalysisAtr({ candles: { H1: bars(), H4: bars(4) } }, capturedAt)).toEqual({ status: 'available',
    value: '3', timeframe: 'H1', period: 14, method: 'closed-tr-sma14/v1', lastBarOpenTime: '2026-09-08T23:00:00.000Z' })
})
it('includes gaps against the previous close and deterministically rounds recurring decimals', () => {
  const source = bars()
  source[14] = { ...source[14]!, open: '14', high: '15', low: '13', close: '14' }
  expect(frozenAnalysisAtr({ candles: { H1: source } }, capturedAt)).toMatchObject({ value: '3.071428571428571429' })
})
it('does not lose sub-floating-point precision', () => {
  const source = bars().map(bar => ({ ...bar, open: '10', close: '10', low: '10', high: '10.000000000000000001' }))
  expect(frozenAnalysisAtr({ candles: { H1: source } }, capturedAt)).toMatchObject({ value: '0.000000000000000001' })
})
it('ignores the open candle and falls back to frozen H4 only for insufficient H1 samples', () => {
  const source = bars()
  source[14] = { ...source[14]!, closed: false, high: '999999' }
  expect(frozenAnalysisAtr({ candles: { H1: source, H4: bars(4) } }, capturedAt)).toMatchObject({ timeframe: 'H4', value: '3' })
})
it('reports missing evidence without reading a current clock or market', () => {
  expect(frozenAnalysisAtr({ candles: {} }, capturedAt)).toEqual({ status: 'unavailable', reason: 'insufficient_closed_hourly_bars' })
})
it.each([
  { high: '8' }, { close: '13' }, { high: 12 }, { open_time: '2026-09-09T00:00:00.000Z' },
  { open_time: '2026-09-08T23:30:00.000Z' }, { open_time: '2026-09-08T22:00:00.000Z' }, { closed: 'true' },
])('rejects corrupted selected evidence instead of falling back to H4 %j', patch => {
  const source = bars()
  source[14] = { ...source[14]!, ...patch }
  expect(() => frozenAnalysisAtr({ candles: { H1: source, H4: bars(4) } }, capturedAt)).toThrow('frozen_analysis_atr_invalid')
})
it('retains session gaps without inventing intervening prices', () => {
  const source = bars()
  source[0] = { ...source[0]!, open_time: '2026-09-06T00:00:00.000Z' }
  expect(frozenAnalysisAtr({ candles: { H1: source } }, capturedAt)).toMatchObject({ value: '3' })
})
