import { describe, expect, it } from 'vitest'
import type { PublicMarketSnapshotData } from '@aurum/contracts'
import { presentChanTrend } from './chan-trend-presentation'

type Structure = NonNullable<PublicMarketSnapshotData['structure']>

function structure(overrides: Partial<Structure> = {}): Structure {
  return {
    algorithm: 'chan_structure_v8',
    status: 'ok',
    reliability: 'high',
    based_on_closed_bars: 1800,
    trend: null,
    lines: [],
    ...overrides,
  }
}

describe('Chan trend presentation', () => {
  it('keeps the confirmed direction and the opposite developing reversal visible', () => {
    const result = presentChanTrend(structure({
      status: 'partial',
      reliability: 'medium',
      trend: { state: 'up_reversal_watch', direction: 'up', phase: 'transition', confidence: 'low', reason: 'forming_opposite_segment_unconfirmed' },
    }))
    expect(result).toMatchObject({
      primary: '确认向上',
      phase: '向下反转观察',
      quality: ['低置信度', '部分可用'],
      ariaLabel: '缠论走势：确认向上，向下反转观察，低置信度，部分可用',
    })
    expect(result.title).toContain('整体可靠性中等')
  })

  it('explains pending breakouts without exposing internal state codes', () => {
    const result = presentChanTrend(structure({
      trend: { state: 'upward_breakout_pending', direction: 'up', phase: 'breakout_candidate', confidence: 'low', reason: 'price_above_unclosed_center' },
    }))
    expect(result.primary).toBe('确认向上')
    expect(result.phase).toBe('向上突破待确认')
    expect(result.title).not.toContain('upward_breakout_pending')
  })

  it('reports missing structure evidence directly', () => {
    expect(presentChanTrend(structure({ status: 'insufficient_klines', reliability: 'low' }))).toMatchObject({
      primary: '待确认',
      phase: null,
      quality: ['历史不足'],
    })
  })
})
