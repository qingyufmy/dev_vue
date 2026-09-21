import { describe, expect, it } from 'vitest'
import { __computeChanTest } from '../src/modules/market/domain/chan-v8/compute-chan.js'

describe('Chan cross-window candidates', () => {
  it('always includes the actual authoritative window when live history is one bar short', () => {
    expect(__computeChanTest.candidateWindowCounts([1_400, 1_600, 1_800], 1_799))
      .toEqual([1_400, 1_600, 1_799])
  })
})
