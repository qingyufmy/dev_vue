import type { StrategyExecutionConfigScope } from '../../strategies/index.js'

export interface DecisionStrategyEvidenceScope {
  decisionId: string; decisionRevision: number; userId: number; accountId: string
}
export interface DecisionStrategyEvidence extends DecisionStrategyEvidenceScope {
  decisionHash: string; snapshotId: string; snapshotHash: string
  strategyScope: StrategyExecutionConfigScope
  analysisMarketRegime?: string
}
/** Frozen trader lineage only; current authorization belongs to strategies. */
export interface DecisionStrategyEvidenceReader {
  read(scope: DecisionStrategyEvidenceScope): Promise<DecisionStrategyEvidence | null>
}
