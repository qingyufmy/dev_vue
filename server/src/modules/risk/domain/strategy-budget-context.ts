export interface StrategyBudgetContext {
  decisionId: string; decisionRevision: number; userId: number; accountId: string; subscriptionRevision: number
  decisionHash: string; snapshotId: string; snapshotHash: string; strategyId: string; versionId: string
  promptHash: string; configHash: string; strategyRiskCeilingPercent?: string
  strategyRiskSelection?: { marketRegime: string | null; source: 'declared_regime' | 'default' }
}
