import { describe, expect, it } from 'vitest'

import {
  POSITION_SIZE_TIERS, capPositionSizeTier, normalizePositionSizeTier,
  positionSizeFactor, resolvePositionSizeTier,
} from '../../server/routes/ai/position-sizing.js'

describe('position sizing tiers', () => {
  it('uses four fixed tiers and never accepts an arbitrary factor', () => {
    expect(POSITION_SIZE_TIERS).toMatchObject({
      observe:{ factor:0 }, probe:{ factor:0.25 }, light:{ factor:0.5 }, standard:{ factor:1 },
    })
    expect(normalizePositionSizeTier('0.37', 'buy')).toBeNull()
    expect(positionSizeFactor('unknown')).toBe(0)
  })

  it('always maps a hold decision to no position', () => {
    expect(normalizePositionSizeTier('standard', 'hold')).toBe('observe')
    expect(resolvePositionSizeTier({ requestedTier:'standard', signalType:'hold' }))
      .toEqual({ tier:'observe', factor:0, downgraded:false })
  })

  it('caps weak evidence and every add-on at probe risk', () => {
    expect(capPositionSizeTier('standard', 'light')).toBe('light')
    expect(resolvePositionSizeTier({ requestedTier:'standard', signalType:'buy', evidenceCap:'probe' }))
      .toEqual({ tier:'probe', factor:0.25, downgraded:true })
    expect(resolvePositionSizeTier({ requestedTier:'standard', signalType:'buy', evidenceCap:'standard', isAdd:true }))
      .toEqual({ tier:'probe', factor:0.25, downgraded:true })
  })
})
