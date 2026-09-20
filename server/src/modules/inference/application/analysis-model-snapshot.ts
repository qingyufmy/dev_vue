import type { AnalysisInputSnapshot } from '../domain/inference.js'

/** Durable calculation history is audit evidence, never model-visible context. */
export function analysisModelSnapshot(snapshot: AnalysisInputSnapshot): AnalysisInputSnapshot {
  const { calculation_archive: _archive, ...market } = snapshot.market
  return structuredClone({ ...snapshot, market })
}
