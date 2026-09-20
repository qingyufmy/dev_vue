import { describe, expect, it } from 'vitest'
import type { PublicMarketSnapshotData } from '@aurum/contracts'
import { chartReferenceLevels } from './chart-reference-levels'

type Structure = NonNullable<PublicMarketSnapshotData['structure']>
function line(kind: Structure['lines'][number]['kind'], price: number, day = 18, fromDay = day) {
  return { kind, start: price, end: price, from: `2026-09-${fromDay}T00:00:00Z`, to: `2026-09-${day}T00:00:00Z` }
}
const structure: Structure = { algorithm: 'chan_structure_v8', status: 'ok', reliability: 'high', based_on_closed_bars: 1800, trend: null,
  lines: [line('fractal_bottom', 95), line('fractal_top', 110), line('bi_center', 98, 18, 17), line('bi_center', 105, 18, 17)] }
const through = '2026-09-19T00:00:00Z'

describe('chart reference levels', () => {
  it('selects nearest structural boundaries on both sides and changes side after price crosses', () => {
    expect(chartReferenceLevels(structure, 100, through)).toMatchObject({ support: { price: 98, source: '笔中枢' }, resistance: { price: 105 } })
    expect(chartReferenceLevels(structure, 107, through)).toMatchObject({ support: { price: 105 }, resistance: { price: 110, source: '顶分型' } })
  })
  it('uses only latest pivots and center pair, excluding older, future and forming geometry', () => {
    const data = { ...structure, lines: [...structure.lines, line('fractal_bottom', 99, 17), line('bi_center', 99.5, 16, 15),
      line('forming_segment', 99.8), line('fractal_top', 100.1, 20)] }
    expect(chartReferenceLevels(data, 100, through)).toMatchObject({ support: { price: 98 }, resistance: { price: 105 } })
  })
  it('does not manufacture a level for an absent side, exact touch, or invalid input', () => {
    expect(chartReferenceLevels({ ...structure, lines: [line('fractal_bottom', 95)] }, 95, through)).toEqual({ support: null, resistance: null })
    expect(chartReferenceLevels(structure, 120, through)).toMatchObject({ support: { price: 110 }, resistance: null })
    expect(chartReferenceLevels(null, 100, through)).toEqual({ support: null, resistance: null })
    expect(chartReferenceLevels(structure, NaN, through)).toEqual({ support: null, resistance: null })
  })
})
