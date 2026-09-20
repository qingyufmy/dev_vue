/** Historical IDs and account IDs belong to the retained legacy namespace only. */
export interface ArchivedExecutionSummary {
  legacy_id: string
  legacy_account_id: string | null
  symbol: string | null
  action: string
  status: string
  created_at_utc: string
}
export interface ArchivedExecutionDetail extends ArchivedExecutionSummary {
  trade_ticket: string | null
  pending_ticket: string | null
  error_code: string | null
  completed_at_utc: string | null
}
export interface ArchivedExecutionReader {
  list(userId: number, input: { limit: number; beforeId?: string }): Promise<{ items: ArchivedExecutionSummary[]; nextCursor: string | null }>
  get(userId: number, id: string): Promise<ArchivedExecutionDetail | null>
}
