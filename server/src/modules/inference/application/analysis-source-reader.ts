import type { JsonObject } from '../domain/inference.js'
/** Historical analysis provenance, not current authorization or live inventory. */
export interface AnalysisSource {
  analysisId: string
  sourceAccountId: string
  strategyVersionId: string
  snapshotId: string
  snapshotHash: string
  priceActionEvents?: JsonObject
}

export interface AnalysisSourceReader {
  read(scope: { userId: number; analysisId: string; analysisStrategyId: string; symbol: string }): Promise<AnalysisSource | null>
}
