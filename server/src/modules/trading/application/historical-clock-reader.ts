export interface HistoricalClockBoundaryScope {
  userId: number
  accountId: string
  ownershipIntervalId: string
  utcMsc: number
  asOfUtcMsc: number
}
export interface HistoricalClockBoundaryReader {
  resolveLocal(scope: Omit<HistoricalClockBoundaryScope, 'utcMsc'> & { localMidnightMsc: number }): Promise<{
    utcMsc: number; offsetMinutes: number; evidenceRef: string
  } | null>
  /** Caller authorizes current and historical ownership; this port verifies stored clock observations. */
  read(scope: HistoricalClockBoundaryScope): Promise<{
    utcMsc: number; offsetMinutes: number; evidenceRef: string
  } | null>
}
