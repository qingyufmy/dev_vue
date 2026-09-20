import type { RiskJsonObject } from '../domain/risk-action.js'

export interface AccountRiskSummaryReader {
  read(userId: number, accountId: string): Promise<{ revision: number; data: RiskJsonObject } | null>
  readRevision(userId: number, accountId: string): Promise<number | null>
}
