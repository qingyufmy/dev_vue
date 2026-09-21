export interface AnalysisSubscriber {
  id: string; userId: number; accountId: string; revision: number
  traderStrategyId: string; traderStrategyVersionId: string
  independentRoles?: boolean
  timezone: string; window: unknown
}
export interface AnalysisSubscriberReader {
  readContextVersion(scope: { subscriptionId: string; userId: number; accountId: string;
    traderStrategyId: string; traderStrategyVersionId: string; analysisStrategyVersionId: string; symbol: string
  }): Promise<{ revision: number; status: string } | null>
  list(scope: { userId: number; analysisStrategyVersionId: string; symbol: string }): Promise<AnalysisSubscriber[]>
  readForEvaluation(scope: { subscriptionId: string; userId: number; accountId: string; subscriptionRevision: number;
    traderStrategyId: string; traderStrategyVersionId: string; analysisStrategyVersionId: string; symbol: string
  }): Promise<Pick<AnalysisSubscriber, 'id' | 'userId' | 'accountId' | 'revision' | 'traderStrategyId' | 'traderStrategyVersionId'> & { independentRoles?: boolean } | null>
}
