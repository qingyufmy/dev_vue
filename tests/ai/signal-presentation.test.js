import { describe, expect, it } from 'vitest'
import { attachSignalPresentation, buildExecutionAdvice, normalizeDecisionFields } from '../../server/routes/ai/signal-presentation.js'

describe('signal presentation', () => {
  it('normalizes model fields and limits untrusted arrays', () => {
    const result = normalizeDecisionFields({ signal_type: 'buy', decision_summary: '  顺势做多  ', bullish_score: 63, bearish_score: 37, key_reasons: ['趋势向上', '', '回踩支撑', '量能改善', '结构完整', 'ignored'] })
    expect(result.schema_version).toBe(2)
    expect(result.decision_summary).toBe('顺势做多')
    expect(result.key_reasons).toHaveLength(4)
    expect(result).toMatchObject({ bullish_score: 63, bearish_score: 37 })
  })

  it('normalizes direction inclination without presenting it as confidence', () => {
    expect(normalizeDecisionFields({ bullish_score: 2, bearish_score: 1 })).toMatchObject({ bullish_score: 66.7, bearish_score: 33.3 })
    expect(normalizeDecisionFields({ bullish_score: 'bad', bearish_score: 50 })).toMatchObject({ bullish_score: null, bearish_score: null })
  })

  it('never marks a hold signal executable', () => {
    expect(buildExecutionAdvice({ signal_type: 'hold' })).toMatchObject({ state: 'observe', executable: false })
  })

  it('uses persisted rejection as the primary execution state', () => {
    const advice = buildExecutionAdvice({ signal_type: 'buy', execution_result: JSON.stringify({ status: 'rejected', message: '超过风险上限' }) })
    expect(advice).toMatchObject({ state: 'rejected', title: '风控未放行', executable: false })
    expect(advice.description).toContain('风险上限')
  })

  it('adapts legacy rows without a decision payload', () => {
    const result = attachSignalPresentation({ id: 1, signal_type: 'sell', entry_method: 'market' })
    expect(result.decision.schema_version).toBe(2)
    expect(result.execution_advice.executable).toBe(true)
  })
})
