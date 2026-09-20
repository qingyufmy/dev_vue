import type { AccountRiskSummary } from '../domain/risk.js'

export interface PositionProtectionSummaryReader {
  /** Caller holds the account lock; this reader retains state/summary locks in the same transaction. */
  read(userId: number, accountId: string): Promise<AccountRiskSummary | null>
}
