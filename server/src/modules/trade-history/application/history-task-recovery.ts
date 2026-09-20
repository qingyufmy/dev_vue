export interface HistoryTaskRecovery {
  schedule(limit: number): Promise<number>
}
