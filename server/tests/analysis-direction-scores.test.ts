import { expect, it } from 'vitest'
import { assertMarketAnalysisResult, type MarketAnalysisResult } from '../src/modules/inference/domain/inference.js'

const result: MarketAnalysisResult = {
  marketBias: 'bullish', opportunity: 'none', confidence: 72, summary: '观察', marketRegime: '震荡',
  supportingEvidence: [], counterEvidence: [], keyLevels: {}, invalidation: {}, dataGaps: [],
  analysisBody: '观察行情', analyzedAt: '2026-09-15T00:00:00Z', validUntil: '2026-09-15T01:00:00Z',
}
it('accepts independent scores and old results without direction scores', () => {
  expect(() => assertMarketAnalysisResult(result)).not.toThrow()
  expect(() => assertMarketAnalysisResult({ ...result, bullishScore: 55, bearishScore: 45 })).not.toThrow()
  expect(() => assertMarketAnalysisResult({ ...result, bullishScore: null, bearishScore: null })).not.toThrow()
})
it.each([[0, 0], [55, null], [-1, 80], [101, 10], [NaN, 40], [Infinity, 40]])('rejects invalid score pair %s %s', (bullishScore, bearishScore) => {
  expect(() => assertMarketAnalysisResult({ ...result, bullishScore, bearishScore })).toThrow('analysis_direction_scores_invalid')
})
