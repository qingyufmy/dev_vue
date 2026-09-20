type Component = { id: number; low: number; high: number; start_price: number; end_price: number }
export type Center = { id: number; zl: number; zh: number; component_level: string; entry_component_id: number | null; start_component_id: number; end_component_id: number; departure_component_id: number | null; component_ids: number[]; start_segment_id: number; end_segment_id: number; segment_ids: number[]; entry_segment_id: number | null; departure_segment_id: number | null; fluctuation_low: number; fluctuation_high: number; level: string; status: string; closed_by_segment_id: number | null }

export function buildCenters(components: readonly Component[], options: { componentLevel?: 'bi' | 'segment'; leadingSegmentIsEntry?: boolean } = {}) {
  if (components.length < 3) return []
  const componentLevel = options.componentLevel === 'bi' ? 'bi' : 'segment'
  const centers = []
  // A trusted anchor is the start of the already-confirmed entry segment.
  // Keep that leading segment outside the three-segment centre core so an
  // anchored rebuild reproduces the same entry/core identity as the full
  // authoritative history instead of shifting the centre forward by one.
  let i = options.leadingSegmentIsEntry === true ? 1 : 0
  while (i + 2 < components.length) {
    const initial = components.slice(i, i + 3)
    const ranges = initial.map((item): [number, number] => [
      Number.isFinite(item.low) ? item.low : Math.min(item.start_price, item.end_price),
      Number.isFinite(item.high) ? item.high : Math.max(item.start_price, item.end_price),
    ])
    const zl = Math.max(ranges[0]![0], ranges[1]![0], ranges[2]![0])
    const zh = Math.min(ranges[0]![1], ranges[1]![1], ranges[2]![1])
    if (!(zl < zh)) { i++; continue }

    const center: Center = {
      id: centers.length + 1,
      zl,
      zh,
      component_level: componentLevel,
      entry_component_id: components[i - 1]?.id ?? null,
      start_component_id: initial[0]!.id,
      end_component_id: initial[2]!.id,
      departure_component_id: null,
      component_ids: initial.map(item => item.id),
      start_segment_id: initial[0]!.id,
      end_segment_id: initial[2]!.id,
      segment_ids: initial.map(item => item.id),
      entry_segment_id: componentLevel === 'segment' ? (components[i - 1]?.id ?? null) : null,
      departure_segment_id: null,
      fluctuation_low: Math.min(...ranges.map(range => range[0])),
      fluctuation_high: Math.max(...ranges.map(range => range[1])),
      level: '',
      status: 'confirmed',
      closed_by_segment_id: null,
    }
    let j = i + 3
    while (j < components.length) {
      const item = components[j]!
      const low = Number.isFinite(item.low) ? item.low : Math.min(item.start_price, item.end_price)
      const high = Number.isFinite(item.high) ? item.high : Math.max(item.start_price, item.end_price)
      if (Math.max(center.zl, low) >= Math.min(center.zh, high)) {
        center.closed_by_segment_id = item.id
        center.departure_component_id = item.id
        if (componentLevel === 'segment') center.departure_segment_id = item.id
        break
      }
      center.fluctuation_low = Math.min(center.fluctuation_low, low)
      center.fluctuation_high = Math.max(center.fluctuation_high, high)
      center.segment_ids.push(item.id)
      center.component_ids.push(item.id)
      center.end_segment_id = item.id
      center.end_component_id = item.id
      center.status = 'extended'
      j++
    }
    if (j < components.length) center.status = 'closed'
    centers.push(center)
    i = j < components.length ? j : components.length
  }
  return centers
}
