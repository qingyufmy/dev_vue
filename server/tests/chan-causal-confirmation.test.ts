import { describe, expect, it } from 'vitest'
import { normalizeBarsForChan, detectFractals } from '../src/modules/market/domain/chan-v8/bars.js'
import { summarizeLatestConfirmedFractal } from '../src/modules/market/domain/chan-v8/bi-summary.js'
import { findSegmentEndpoint } from '../src/modules/market/domain/chan-v8/features.js'
import { buildSegmentsFromAnchor } from '../src/modules/market/domain/chan-v8/segments.js'
import type { ChanBi } from '../src/modules/market/domain/chan-v8/types.js'

describe('causal Chan confirmation', () => {
  it.each(['top', 'bottom'] as const)('keeps first confirmation of an unchanged %s through right-bar inclusion', type => {
    const ranges = [[10, 8], [12, 10], [11, 9], [10.5, 9.5], [10.2, 9.8]]
    const rates = ranges.map(([h, l], i) => {
      const high = type === 'top' ? h! : 30 - l!, low = type === 'top' ? l! : 30 - h!
      return { high, low, open: (high + low) / 2, close: (high + low) / 2,
        time_utc_msc: Date.UTC(2026, 8, 18) + i * 300_000 }
    })
    for (let length = 3; length <= rates.length; length++) {
      const prefix = rates.slice(0, length), bars = normalizeBarsForChan(prefix)
      const fractal = summarizeLatestConfirmedFractal(detectFractals(bars), bars, prefix)
      expect(fractal).toMatchObject({ type, time_utc_msc: rates[1]!.time_utc_msc,
        confirmed_by_bar_time_utc_msc: rates[2]!.time_utc_msc })
    }
    const bars = normalizeBarsForChan(rates.slice(0, 2))
    expect(detectFractals(bars)).toEqual([])
  })

  // Price endpoints from the frozen H4 regression. No account or order data.
  const prices = [4595.25, 4447.75, 4541.48, 4424.03, 4515.28, 4268.69,
    4363.67, 4023.99, 4369.19, 4313.3, 4382.27, 4121.79, 4220.56,
    3959.35, 4095.99, 3943.66, 4202.79, 4021.78, 4138, 3983.56,
    4081.06, 3959.66, 4166.03, 4022.05, 4116.15, 4010.35]
  it.each([false, true])('does not publish a later endpoint while an earlier gap is pending (mirror=%s)', mirror => {
    const points = prices.map(p => mirror ? 10_000 - p : p)
    const bis: ChanBi[] = points.slice(1).map((end, i) => ({
      id: i + 1, run_id: 1, dir: end > points[i]! ? 'up' : 'down',
      start_price: points[i]!, end_price: end, high: Math.max(points[i]!, end), low: Math.min(points[i]!, end),
      start_idx: i * 5, end_idx: i * 5 + 5, raw_start_idx: i * 5, raw_end_idx: i * 5 + 5, confirmed: true,
    }))
    const direction = mirror ? 'up' : 'down'
    expect(findSegmentEndpoint(bis.slice(0, -1), 0, direction)).toBeNull()
    expect(buildSegmentsFromAnchor(bis.slice(0, -1)).segments).toEqual([])
    expect(findSegmentEndpoint(bis, 0, direction)).toMatchObject({ endpointIndex: 15, hasGap: true })
    expect(buildSegmentsFromAnchor(bis).segments[0]).toMatchObject({ dir: direction,
      end_price: points[15], confirmation: 'gap_reverse_confirmed' })
    // The invalidated earlier gap (endpoint 7) must not hold up the valid one.
    expect(buildSegmentsFromAnchor(bis).segments[0]!.end_bi_id).toBe(15)
  })
})
