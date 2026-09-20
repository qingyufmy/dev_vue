/** Strategies owns subscription schedules; advancement is a compare-and-set operation. */
export interface DueAnalysisSchedule {
  subscriptionId: string
  userId: number
  marketSourceAccountId: string
  strategyId: string
  strategyVersionId: string
  symbol: string
  cadenceSeconds: number
  nextDueAt: string
  receiveTimezone: string
  receiveWindow: unknown
}

export interface AnalysisScheduleStore {
  listDue(now: string, limit: number): Promise<DueAnalysisSchedule[]>
  advance(subscriptionId: string, expectedDueAt: string, nextDueAt: string): Promise<boolean>
}
