import { describe, expect, it } from 'vitest'
import { defaultConfig, findStrategyName, formatDateTime, versionLabel } from '../model/strategy-presentation'

describe('strategy presentation', () => {
  it('uses production-equivalent analysis data defaults', () => {
    expect(defaultConfig('analysis')).toEqual({ timeframes: ['M5', 'M15', 'H1', 'H4'], candle_limit: 300 })
    expect(defaultConfig('trader')).toEqual({})
  })

  it('keeps deterministic fallbacks for missing relationships', () => {
    expect(findStrategyName([], null)).toBe('未配置')
    expect(findStrategyName([], '42')).toBe('策略 #42')
    expect(versionLabel(undefined)).toBe('--')
    expect(formatDateTime('invalid')).toBe('--')
  })
})
