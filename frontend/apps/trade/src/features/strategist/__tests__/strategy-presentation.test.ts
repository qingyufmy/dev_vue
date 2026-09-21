import { describe, expect, it } from 'vitest'
import { defaultConfig, findStrategyName, formatDateTime, versionLabel } from '../model/strategy-presentation'

describe('strategy presentation', () => {
  it('uses production-equivalent analysis data defaults', () => {
    expect(defaultConfig('analysis')).toMatchObject({ responsibility_mode: 'independent_roles_v2', interval_minutes: 60,
      market_data_plan: { primary_timeframe: 'H1', timeframes: [{ timeframe: 'H1' }, { timeframe: 'H4' }] }, chan_evidence: { enabled: true } })
    expect(defaultConfig('trader')).toMatchObject({ responsibility_mode: 'independent_roles_v2',
      market_data_plan: { primary_timeframe: 'M5', timeframes: [{ timeframe: 'M5' }, { timeframe: 'M15' }] },
      chan_evidence: { enabled: false }, price_action_evidence: { enabled: true } })
  })

  it('keeps deterministic fallbacks for missing relationships', () => {
    expect(findStrategyName([], null)).toBe('未配置')
    expect(findStrategyName([], '42')).toBe('策略 #42')
    expect(versionLabel(undefined)).toBe('--')
    expect(formatDateTime('invalid')).toBe('--')
  })
})
