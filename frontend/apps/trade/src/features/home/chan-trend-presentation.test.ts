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
      primary: '向上',
      primaryCaption: '已确认笔',
      phase: '向下反转 · 尚未确认',
      phaseCaption: '形成中笔',
      quality: ['低置信度', '部分可用'],
      ariaLabel: '缠论结构：已确认笔向上，形成中笔向下反转 · 尚未确认，低置信度，部分可用',
    })
    expect(result.title).toContain('整体可靠性中等')
    expect(result.title).toContain('走势指引来自形成中笔')
  })

  it('explains pending breakouts without exposing internal state codes', () => {
    const result = presentChanTrend(structure({
      trend: { state: 'upward_breakout_pending', direction: 'up', phase: 'breakout_candidate', confidence: 'low', reason: 'price_above_unclosed_center' },
    }))
    expect(result.primary).toBe('向上')
    expect(result.primaryCaption).toBe('当前方向')
    expect(result.phase).toBe('向上突破待确认')
    expect(result.phaseCaption).toBe('形成中')
    expect(result.title).not.toContain('upward_breakout_pending')
  })

  it('reports missing structure evidence directly', () => {
    expect(presentChanTrend(structure({ status: 'insufficient_klines', reliability: 'low' }))).toMatchObject({
      primary: '待确认',
      primaryCaption: '结构',
      phase: null,
      phaseCaption: null,
      quality: ['历史不足'],
    })
  })
})
