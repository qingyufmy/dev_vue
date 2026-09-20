export interface RuntimeStrategyAccess {
  readModelProfileId?(userId: number, strategyId: string, versionId: string): Promise<string | null>
  canUseCurrent(userId: number, strategyId: string, versionId: string): Promise<boolean>
  canUseFrozenReview(userId: number, strategyId: string): Promise<boolean>
}
