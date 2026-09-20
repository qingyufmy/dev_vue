/** Historical IDs and account IDs belong to the retained legacy namespace only. */
export interface ArchivedSignalSummary {
  legacy_id: string
  symbol: string
  timeframe: string
  signal_type: string
  created_at_utc: string
}
export interface ArchivedSignalDetail extends ArchivedSignalSummary {
  analysis: string | null
  reasoning: string | null
  inference_task_id: string | null
}
export interface ArchivedSignalReader {
  list(userId: number, input: { limit: number; beforeId?: string }): Promise<{ items: ArchivedSignalSummary[]; nextCursor: string | null }>
  get(userId: number, id: string): Promise<ArchivedSignalDetail | null>
}
