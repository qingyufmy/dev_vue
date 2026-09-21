import { describe, expect, it } from 'vitest'
import { buildCenters } from '../src/modules/market/domain/chan-v8/centers.js'
import { evaluateGapEndpointConfirmation } from '../src/modules/market/domain/chan-v8/features.js'
import { buildActiveSegmentCandidate, buildSegments, buildSegmentsFromAnchor } from '../src/modules/market/domain/chan-v8/segments.js'
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
  it.each([false, true])('keeps a locally confirmed detached tail out of the connected segment chain (mirror=%s)', mirror => {
    // Frozen H1 stroke endpoints from XAUUSD.s. Segment 115-119 is confirmed;
    // the candidate at 120 later retires and the re-anchored tail at 146 has
    // a local non-gap endpoint. Publishing that tail as a segment would leave
    // an unrepresented gap in the segment chain.
    const prices = [4310.92,4396.9,4367.17,4411.35,4377.35,4428.85,4386.17,4406.63,
      4327.25,4527.24,4450.66,4680.82,4625.19,4696.65,4605.37,4673.8,4583.16,
      4643.08,4565.01,4617.99,4571.64,4631.99,4396.36,4464.06,4426.2,4461.84,
      4282.53,4397.65,4381.17,4510.76,4470.48,4487.17,4365.79,4438.35,4381.14,
      4442.96,4387.85,4412.84,4341.4,4434.06,4389.63,4434.47,4300.87,4357.21,
      4289.84,4355.33,4253.61,4317.37,4261.37,4310.67,4275.52,4367.8,4273.98,
      4381.86,4334.32,4399.6,4342.77,4383.32]
    const points = prices.map(price => mirror ? 10_000 - price : price)
    const items = points.slice(0, -1).map((start, index) =>
      bi(115 + index, index % 2 === 0
        ? (mirror ? 'down' : 'up') : (mirror ? 'up' : 'down'), start, points[index + 1]!))

    const result = buildSegmentsFromAnchor(items, { trustedStart:true })
    const firstDirection = mirror ? 'down' : 'up'
    const secondDirection = mirror ? 'up' : 'down'

    expect(result.segments.map(segment => [segment.dir, segment.start_bi_id, segment.end_bi_id]))
      .toEqual([[firstDirection,115,119]])
    expect(result.candidate).toMatchObject({
      dir:secondDirection,
      bi_ids:expect.arrayContaining([146,171]),
      confirmation_state:'awaiting_segment_chain_connection',
      confirmation_required:'connected_segment_chain',
      pending_endpoint_feature_bi_id:153,
      pending_endpoint_segment_bi_id:152,
    })
    const confirmedBoundaries = new Map<number, number>()
    for (let length = 3; length <= items.length; length++) {
      const prefix = buildSegmentsFromAnchor(items.slice(0, length), { trustedStart:true })
      for (const [startBiId, endBiId] of confirmedBoundaries) {
        expect(prefix.segments.find(segment => segment.start_bi_id === startBiId)?.end_bi_id).toBe(endBiId)
      }
      for (const segment of prefix.segments) confirmedBoundaries.set(segment.start_bi_id, segment.end_bi_id)
    }
  })
})
