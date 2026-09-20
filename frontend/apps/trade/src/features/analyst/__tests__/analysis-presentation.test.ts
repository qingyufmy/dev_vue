import { describe, expect, it } from 'vitest'
import { marketAnalysisSummarySchema } from '@aurum/contracts'
import { analysisValidity, biasLabel, opportunityLabel, readableRecord, marketRegimeLabel } from '../model/analysis-presentation'

const summary = marketAnalysisSummarySchema.parse({
  analysis_id: 'analysis-1', strategy_id: 'strategy-1', strategy_version_id: 'version-1', symbol: 'XAUUSD',
  market_bias: 'bullish', opportunity: 'long_setup', confidence: 76, summary: '结构偏多',
  analyzed_at: '2026-09-04T04:00:00.000Z', valid_until: '2026-09-04T04:05:00.000Z', revision: '1',
})

describe('analysis presentation', () => {
  it('does not expose internal market state codes', () => {
    expect(marketRegimeLabel('unavailable')).toBe('市场环境暂无法判断')
    expect(marketRegimeLabel('unknown_internal_state')).toBe('暂未说明')
  })
  it('uses plain Chinese labels for direction and opportunity', () => {
    expect(biasLabel(summary.marketBias)).toBe('偏多')
    expect(opportunityLabel(summary.opportunity)).toBe('发现做多机会')
  })

  it('marks expired analysis without inventing a current conclusion', () => {
    expect(analysisValidity(summary, Date.parse('2026-09-04T04:06:00.000Z'))).toBe('结论已过有效期')
  })

  it('preserves price arrays and omits unknown internal fields', () => {
    expect(readableRecord({ support: [4630, 4620], missing: null })).toEqual([
      { key: 'support', label: '支撑位', value: '4630、4620' },
    ])
  })
})
