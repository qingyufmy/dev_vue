import type { MarketAnalysisResult } from '../domain/inference.js'

export interface EntryAnalysisScope {
  decisionId: string; riskDecisionId: string; userId: number; accountId: string
  strategyId: string; strategyVersionId: string; symbol: string
}
export interface TradeDecisionEntryAnalysis extends EntryAnalysisScope {
  analysisId: string; analysisStrategyId: string; analysisStrategyVersionId: string
  analysisHash: string; result: MarketAnalysisResult
  inputSnapshotId: string; inputSnapshotHash: string; inputCapturedAt: string
  traderInputSnapshotId: string; traderInputSnapshotHash: string
}
export interface TradeDecisionEntryAnalysisReader {
  /** Historical proof only. Caller owns authorization and one consistent read snapshot. */
  read(scope: EntryAnalysisScope): Promise<TradeDecisionEntryAnalysis | null>
}
