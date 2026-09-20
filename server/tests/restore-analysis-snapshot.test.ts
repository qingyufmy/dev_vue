import { expect, it } from 'vitest'
import { calculateEma34Evidence } from '../src/modules/strategies/index.js'
import { contentHash } from '../src/modules/inference/domain/inference.js'
import { restoreAnalysisSnapshot } from '../src/modules/inference/application/restore-analysis-snapshot.js'

function fixture() {
  const now = '2026-09-15T10:15:00.000Z'
  const bars = Array.from({ length: 61 }, (_, i) => ({ open_time: new Date(Date.parse(now) - (61-i)*60000).toISOString(), close: String(4200+i*0.37), closed: true }))
  const calculated = calculateEma34Evidence(bars.map(b=>({openTimeUtcMs:Date.parse(b.open_time),close:b.close,closed:b.closed})), {timeframeMs:60000,referenceTimeUtcMs:Date.parse(now),internalGapUnresolved:false})
  const payload = { kind: 'analysis', market: { indicators: { ema34: { ...calculated, timeframe:'M1', reference_time:now, input_bars:bars } } } }
  const hash = contentHash(payload)
  const stored = JSON.parse(JSON.stringify(payload))
  stored.market.indicators.ema34.analysis.distance_pct = Number(stored.market.indicators.ema34.analysis.distance_pct.toPrecision(15))
  return { payload, hash, stored }
}
it('restores rounded derived numbers only with the original complete digest', () => {
  const {payload,hash,stored}=fixture()
  expect(contentHash(stored)).not.toBe(hash)
  expect(restoreAnalysisSnapshot(stored,hash)).toEqual(payload)
  expect(contentHash(stored)).not.toBe(hash)
})
it('does not accept changed raw bars or unrelated snapshot fields', () => {
  const {hash,stored}=fixture()
  stored.market.indicators.ema34.input_bars[0].close='9999'
  expect(contentHash(restoreAnalysisSnapshot(stored,hash))).not.toBe(hash)
  const other=fixture();other.stored.kind='other'
  expect(contentHash(restoreAnalysisSnapshot(other.stored,other.hash))).not.toBe(other.hash)
})
