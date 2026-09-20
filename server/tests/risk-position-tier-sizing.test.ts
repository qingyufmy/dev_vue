import { describe, expect, it } from 'vitest'
import { calculatePositionTierVolume, resolvePositionSizeTier, legacyPositionEvidenceCap, positionVolumeExceedsRiskBudget } from '../src/modules/risk/domain/position-tier-sizing.js'

const input = { resolvedTier: 'standard' as const, equity: '10000', maxRiskPerTradePercent: '1', entry: '2500', stopLoss: '2490',
  tickSize: '0.01', tickValue: '1', volumeMin: '0.01', volumeMax: '10', volumeStep: '0.01', maxOrderVolume: '5' }

describe('deterministic position tier sizing', () => {
  it('checks explicit volume without rounding up a barely insufficient budget', () => {
    expect(positionVolumeExceedsRiskBudget({ ...input, volume: '0.1' })).toBe(false)
    expect(positionVolumeExceedsRiskBudget({ ...input, volume: '0.1', equity: '9999.999999999999999999' })).toBe(true)
    expect(positionVolumeExceedsRiskBudget({ ...input, volume: '0.01', maxRiskPerTradePercent: '0' })).toBe(true)
  })
  it('enforces the same strategy and action ceilings for explicit and sized volumes', () => {
    const capped = { ...input, maxRiskPerTradePercent: '2', strategyRiskCeilingPercent: '1', actionRiskCeilingPercent: '0.5' }
    expect(positionVolumeExceedsRiskBudget({ ...capped, volume: '0.05' })).toBe(false)
    expect(positionVolumeExceedsRiskBudget({ ...capped, volume: '0.06' })).toBe(true)
    for (const resolvedTier of ['probe', 'light', 'standard'] as const) {
      const sized = calculatePositionTierVolume({ ...capped, resolvedTier })
      expect(positionVolumeExceedsRiskBudget({ ...capped, resolvedTier, volume: sized.volume })).toBe(false)
    }
  })
  it('takes the strategy ceiling before tier and the action ceiling after tier', () => {
    const base = { ...input, maxRiskPerTradePercent: '2', resolvedTier: 'light' as const }
    expect(calculatePositionTierVolume(base).volume).toBe('0.1')
    expect(calculatePositionTierVolume({ ...base, strategyRiskCeilingPercent: '1' }).volume).toBe('0.05')
    expect(calculatePositionTierVolume({ ...base, actionRiskCeilingPercent: '0.5' }).volume).toBe('0.05')
    expect(calculatePositionTierVolume({ ...base, strategyRiskCeilingPercent: '1', actionRiskCeilingPercent: '0.3' }).volume).toBe('0.03')
  })
  it('never increases an account or tier budget through a larger declared ceiling', () => {
    for (const resolvedTier of ['probe', 'light', 'standard'] as const) {
      const base = { ...input, resolvedTier }
      expect(calculatePositionTierVolume({ ...base, strategyRiskCeilingPercent: '100', actionRiskCeilingPercent: '100' })).toEqual(calculatePositionTierVolume(base))
    }
  })
  it('keeps ceiling precision until downward lot rounding', () => {
    expect(calculatePositionTierVolume({ ...input, actionRiskCeilingPercent: '0.499999999999999999' }).volume).toBe('0.04')
    expect(() => calculatePositionTierVolume({ ...input, actionRiskCeilingPercent: '0.000000000000000001' })).toThrow('position_size_below_minimum')
  })
  it.each(['0', '-1', '101', '1e-2', '01', '0.1234567890123456789', null])('rejects malformed ceiling %s', value => {
    for (const field of ['strategyRiskCeilingPercent', 'actionRiskCeilingPercent']) {
      expect(() => calculatePositionTierVolume({ ...input, [field]: value })).toThrow()
    }
  })
  it('retains legacy confidence thresholds and the partial-market cap', () => {
    expect(legacyPositionEvidenceCap(75, 'complete')).toBe('standard')
    expect(legacyPositionEvidenceCap(74.999, 'complete')).toBe('light')
    expect(legacyPositionEvidenceCap(62, 'complete')).toBe('light')
    expect(legacyPositionEvidenceCap(61.999, 'complete')).toBe('probe')
    expect(legacyPositionEvidenceCap(100, 'partial')).toBe('probe')
    expect(() => legacyPositionEvidenceCap(NaN, 'complete')).toThrow('position_size_evidence_invalid')
    expect(() => legacyPositionEvidenceCap(101, 'complete')).toThrow('position_size_evidence_invalid')
    expect(() => legacyPositionEvidenceCap(80, 'unknown' as never)).toThrow('position_size_evidence_invalid')
  })
  it('applies legacy quarter, half and full risk budgets', () => {
    expect(calculatePositionTierVolume(input).volume).toBe('0.1')
    expect(calculatePositionTierVolume({ ...input, resolvedTier: 'light' }).volume).toBe('0.05')
    expect(calculatePositionTierVolume({ ...input, resolvedTier: 'probe' }).volume).toBe('0.02')
  })
  it('honors the broker lattice origin and both maximums', () => {
    expect(calculatePositionTierVolume({ ...input, volumeMin: '0.03', volumeStep: '0.04' }).volume).toBe('0.07')
    expect(calculatePositionTierVolume({ ...input, maxOrderVolume: '0.06' }).volume).toBe('0.06')
    expect(calculatePositionTierVolume({ ...input, volumeMax: '0.04' }).volume).toBe('0.04')
  })
  it('does not round a barely insufficient budget up to the next lot', () => {
    expect(calculatePositionTierVolume({ ...input, equity: '9999.999999999999999999' }).volume).toBe('0.09')
    expect(() => calculatePositionTierVolume({ ...input, equity: '999' })).toThrow('position_size_below_minimum')
  })
  it('uses absolute stop distance and never invents volume for zero distance', () => {
    expect(calculatePositionTierVolume({ ...input, stopLoss: '2510' }).volume).toBe('0.1')
    expect(() => calculatePositionTierVolume({ ...input, stopLoss: '2500' })).toThrow('position_size_stop_distance_zero')
  })
  it('requires explicit valid decimal data and trade tiers', () => {
    for (const equity of ['NaN', '1e4', '-1', '0', '01', '1.0000000000000000001']) {
      expect(() => calculatePositionTierVolume({ ...input, equity })).toThrow()
    }
    expect(() => calculatePositionTierVolume({ ...input, resolvedTier: 'observe' as never })).toThrow('position_size_tier_invalid')
  })
  it('resolves evidence and add caps without silent defaults', () => {
    expect(resolvePositionSizeTier({ requested: 'standard', evidenceCap: 'light', applyAddCap: false })).toBe('light')
    expect(resolvePositionSizeTier({ requested: 'standard', evidenceCap: 'standard', applyAddCap: true })).toBe('probe')
    expect(resolvePositionSizeTier({ requested: 'probe', evidenceCap: 'standard', applyAddCap: false })).toBe('probe')
    expect(() => resolvePositionSizeTier({ requested: 'unknown', evidenceCap: 'standard', applyAddCap: false })).toThrow()
    expect(() => resolvePositionSizeTier({ requested: 'light', evidenceCap: null, applyAddCap: false })).toThrow()
  })
})
