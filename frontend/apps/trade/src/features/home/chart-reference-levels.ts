import type { PublicMarketSnapshotData } from '@aurum/contracts'

type Structure = PublicMarketSnapshotData['structure']
export interface ChartReferenceLevel { price: number; source: string; at: string }
export interface ChartReferenceLevels { support: ChartReferenceLevel | null; resistance: ChartReferenceLevel | null }

/** Display references only: recent confirmed pivots and latest center bounds.
 * Their side is relative to the current price, never an entry/exit instruction. */
export function chartReferenceLevels(structure: Structure, price: number, through: string): ChartReferenceLevels {
  const empty = { support: null, resistance: null }
  const end = Date.parse(through)
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(end)) return empty
  const sources: Record<string, string> = { fractal_top: '顶分型', fractal_bottom: '底分型', center: '段中枢', bi_center: '笔中枢' }
  const lines = (structure?.lines ?? []).filter(line => sources[line.kind] && Date.parse(line.to) <= end
    && Number.isFinite(line.start) && line.start > 0)
  const candidates: ChartReferenceLevel[] = []
  for (const [kind, source] of Object.entries(sources)) {
    const group = lines.filter(line => line.kind === kind).sort((a, b) => Date.parse(b.to) - Date.parse(a.to) || Date.parse(b.from) - Date.parse(a.from))
    const latest = group[0]
    if (!latest) continue
    for (const line of group.filter(line => line.from === latest.from && line.to === latest.to)) {
      candidates.push({ price: line.start, source, at: line.to })
    }
  }
  return {
    support: candidates.filter(level => level.price < price).sort((a, b) => b.price - a.price || Date.parse(b.at) - Date.parse(a.at))[0] ?? null,
    resistance: candidates.filter(level => level.price > price).sort((a, b) => a.price - b.price || Date.parse(b.at) - Date.parse(a.at))[0] ?? null,
  }
}
