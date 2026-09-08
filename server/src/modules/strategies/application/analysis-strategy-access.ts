/** Strategy ownership and publication eligibility in the caller's transaction. */
export interface AnalysisStrategyAccess {
  /** Locks the current strategy for sharing; never starts or commits a transaction. */
  canUse(userId: number, strategyId: string): Promise<boolean>
}
