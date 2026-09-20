export interface AnalysisWindowReader {
  list(scope: { userId: number; accountId: string; strategyId: string; strategyVersionId: string; symbol: string }):
    Promise<{ timezone: string; window: unknown }[]>
}
