import { describe, expect, it } from 'vitest'
import { readPlatformRiskValues } from '../src/modules/risk/index.js'

describe('shared V4 platform policy compatibility', () => {
  it('allows disabled release settings below normal limits without increasing release ceilings', () => {
    const migrated = readPlatformRiskValues({ maxDailyLossPercent: 20, manualReleaseEnabled: false })
    expect(migrated.maxDailyLossPercent).toBe(20)
    expect(migrated.manualReleaseMaxDailyLossPercent).toBe(5)
    expect(() => readPlatformRiskValues({ ...migrated, manualReleaseEnabled: true })).toThrowError(expect.objectContaining({ code: 'risk_platform_manual_release_boundary_invalid' }))
  })

  it('uses the same explicit per-order default for old flat and wrapped V4 JSON', () => {
    const flat = readPlatformRiskValues('{"maxTotalVolume":10}')
    const wrapped = readPlatformRiskValues({ values: { maxTotalVolume: 10 } })
    expect(flat).toEqual(wrapped)
    expect(flat.maxOrderVolume).toBe(0.05)
    expect(flat.maxTotalVolume).toBe(10)
    expect(readPlatformRiskValues({ maxOrderVolume: 0.02 }).maxOrderVolume).toBe(0.02)
  })
  it.each(['{', 'null', '[]', '{"values":null}', '{"maxOrderVolume":null}', '{"maxOrderVolume":0}', '{"maxOrderVolume":"0.1"}', '{"requireStopLoss":false}'])('rejects invalid or contradictory policy %s', raw => {
    expect(() => readPlatformRiskValues(raw)).toThrow()
  })
  it.each([{ max_position_size: 0.1 }, { values: {}, controls: { max_position_size: { allowed_max: 1 } } }, { newUnmappedRule: 7 }])('does not silently discard legacy or unknown semantics', raw => {
    expect(() => readPlatformRiskValues(raw)).toThrowError(expect.objectContaining({ code: 'risk_platform_policy_unmapped' }))
  })
  it('returns independent symbol arrays without mutating stored input or defaults', () => {
    const raw = { allowedSymbols: ['eurusd'] }
    const first = readPlatformRiskValues(raw)
    first.allowedSymbols.push('XAUUSD')
    expect(raw.allowedSymbols).toEqual(['eurusd'])
    expect(readPlatformRiskValues(raw).allowedSymbols).toEqual(['EURUSD'])
  })
})
