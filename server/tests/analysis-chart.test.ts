import { expect, it } from 'vitest'
import { analysisChart } from '../src/modules/inference/domain/analysis-chart.js'
it('projects only frozen chart fields and rejects invalid candles', () => {
  const snapshot = { strategy: { promptText: 'private' }, market: { source_account_id: 'secret', candles: { M5: [
    { open_time: '2026-09-15T00:00:00Z', open: '10', high: '12', low: '9', close: '11', closed: false },
    { open_time: 'bad', open: '10', high: '12', low: '9', close: '11' },
  ] } } }
  const result = analysisChart(snapshot)
  expect(result).toEqual([{ timeframe: 'M5', bars: [{ time: '2026-09-15T00:00:00Z', open: 10, high: 12, low: 9, close: 11, closed: false }], lines: [] }])
  expect(JSON.stringify(result)).not.toContain('secret')
  expect(analysisChart({})).toEqual([])
})
