import { describe, expect, it } from 'vitest'
import { buildCenters } from '../src/modules/market/domain/chan-v8/centers.js'
import { evaluateGapEndpointConfirmation } from '../src/modules/market/domain/chan-v8/features.js'
import { buildActiveSegmentCandidate, buildSegments } from '../src/modules/market/domain/chan-v8/segments.js'
import type { ChanBi } from '../src/modules/market/domain/chan-v8/types.js'

const bi = (id: number, dir: 'up' | 'down', start: number, end: number): ChanBi => ({
  id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end),
  run_id: 1, start_idx: id * 5, end_idx: id * 5 + 5, raw_start_idx: id * 5,
  raw_end_idx: id * 5 + 5, confirmed: true,
})

describe('v8 structure semantics', () => {
  it('does not promote touching intervals into a center', () => {
    expect(buildCenters([bi(1, 'up', 0, 1), bi(2, 'down', 2, 1), bi(3, 'up', 0, 1)])).toEqual([])
  })
  it('retains the initial center overlap when later components extend its fluctuation', () => {
    const items = [bi(1, 'up', 0, 10), bi(2, 'down', 9, 2), bi(3, 'up', 3, 8),
      bi(4, 'down', 20, 4), bi(5, 'up', 30, 40)]
    const before = structuredClone(items)
    expect(buildCenters(items)).toEqual([expect.objectContaining({ zl: 3, zh: 8,
      fluctuation_low: 0, fluctuation_high: 20, component_ids: [1, 2, 3, 4],
      status: 'closed', departure_component_id: 5, closed_by_segment_id: 5 })])
    expect(items).toEqual(before)
  })
  it('invalidates a pending upward endpoint when the old direction sets a higher high', () => {
    expect(evaluateGapEndpointConfirmation([bi(1, 'down', 10, 5), bi(2, 'up', 5, 11)], 0, 'up'))
      .toEqual({ confirmed: false, state: 'invalidated_by_old_direction_extreme', invalidated_by_bi_id: 2 })
    expect(evaluateGapEndpointConfirmation([], 0, 'up')).toEqual({ confirmed: false, state: 'endpoint_missing' })
  })
  it('does not invent confirmation from an untrusted short prefix', () => {
    expect(buildSegments([bi(1, 'up', 0, 2), bi(2, 'down', 2, 1)], { trustedStart: false }))
      .toMatchObject({ segments: [], candidate: null, stable: false, supportCount: 0, validatorCount: 0 })
  })
  it('re-anchors the active candidate after an old candidate origin is broken', () => {
    const items = [
      bi(1, 'down', 130, 110), bi(2, 'up', 110, 140), bi(3, 'down', 140, 115),
      bi(4, 'up', 115, 145), bi(5, 'down', 145, 120), bi(6, 'up', 120, 142),
      bi(7, 'down', 142, 118), bi(8, 'up', 118, 138), bi(9, 'down', 138, 116),
    ]
    const result = buildActiveSegmentCandidate(items, 0)
    expect(result.historicalCandidate).toMatchObject({ dir:'down', start_price:130 })
    expect(result.candidate).toMatchObject({ dir:'up', start_price:110, bi_ids:[2,3,4,5,6,7,8,9] })
  })
})
