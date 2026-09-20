import { windowCanObserve, type WindowEvidence } from './window-evidence.js'

export function selectEvidenceConsensus<T>(candidates: readonly T[], keySelector: (candidate: T) => string | null) {
  const groups = new Map<string, T[]>()
  let eligibleCount = 0
  for (const candidate of candidates) {
    const key = keySelector(candidate)
    if (!key) continue
    eligibleCount++
    const group = groups.get(key) || []
    group.push(candidate)
    groups.set(key, group)
  }
  const group = [...groups.values()]
    .filter(item => item.length >= 2 && item.length * 2 > eligibleCount)
    .sort((a, b) => b.length - a.length)[0] || null
  return { group, eligibleCount }
}

export function conservativeDivergence<T extends { strength?: string; area_ratio?: number | null; peak_ratio?: number | null }>(items: readonly T[]) {
  const strengthRank: Record<string, number> = { none:0, weak:1, strong:2 }
  return [...items].sort((a, b) => (
    (strengthRank[a?.strength ?? ''] ?? 0) - (strengthRank[b?.strength ?? ''] ?? 0)
    || (Number(b?.area_ratio) || 0) - (Number(a?.area_ratio) || 0)
    || (Number(b?.peak_ratio) || 0) - (Number(a?.peak_ratio) || 0)
  ))[0]
}

export function majorityEvidenceItems<C extends WindowEvidence, T, R = T | undefined>(candidates: readonly C[], listSelector: (candidate: C) => readonly T[], keySelector: (item: T) => string | null, validatorCount: number,
  selectItem: (items: T[]) => R = (items => items[0]) as (items: T[]) => R, evidenceStartSelector: ((item: T) => number | null) | null = null) {
  const evidence = new Map<string, { entries: {candidate: C; item: T}[]; items: T[] }>()
  for (const candidate of candidates) {
    const seen = new Set()
    for (const item of listSelector(candidate)) {
      const key = keySelector(item)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const group = evidence.get(key) || { entries:[] as {candidate: C; item: T}[], items:[] as T[] }
      group.entries.push({ candidate, item })
      group.items.push(item)
      evidence.set(key, group)
    }
  }
  return [...evidence.values()].map(group => {
    const evidenceStart = evidenceStartSelector ? Number(evidenceStartSelector(group.items[0]!)) : null
    const eligible = evidenceStartSelector
      ? candidates.filter(candidate => windowCanObserve(candidate, evidenceStart))
      : candidates.slice(0, validatorCount)
    const supportItems = group.entries
      .filter(entry => !evidenceStartSelector || windowCanObserve(entry.candidate, evidenceStart))
      .map(entry => entry.item)
    return { eligibleCount:eligible.length, supportItems }
  }).filter(group => (
    group.supportItems.length >= 2 && group.supportItems.length * 2 > group.eligibleCount
  )).map(group => selectItem(group.supportItems))
}
