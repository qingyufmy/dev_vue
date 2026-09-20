import type { JsonObject } from '../domain/inference.js'
import type { TradeDecisionOrigin } from './trade-decision-origin-reader.js'
import type { FrozenAnalysisAtr } from '../domain/frozen-analysis-atr.js'

export interface TradeDecisionAnalysis extends TradeDecisionOrigin {
  analysisId: string
  snapshotId: string
  snapshotHash: string
  symbol: string
  capturedAt: string
  market: JsonObject
  atr: FrozenAnalysisAtr
}

export interface TradeDecisionAnalysisReader {
  /** Exact historical analysis input; null means unproven lineage, not missing ATR. */
  read(input: { decisionId: string; riskDecisionId: string; userId: number; accountId: string }): Promise<TradeDecisionAnalysis | null>
}
