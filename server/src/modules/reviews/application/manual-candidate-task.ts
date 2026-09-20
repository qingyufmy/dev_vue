export type ManualCandidatePageResult = { status: 'unresolved'; reason: string } | {
  status: 'processed'; nextRecordId: string | null
  results: Array<{ recordId: string; result: { status: 'unresolved'; reason: string }
    | { status: 'created' | 'updated' | 'unchanged' | 'already_reviewed'; candidateId: string; revision: number } }>
}
export interface ManualCandidatePageProcessor {
  run(taskId: string, afterRecordId: string | null): Promise<ManualCandidatePageResult>
}
export interface ManualCandidateTaskRunner {
  run(taskId: string): Promise<{ state: 'pending' | 'waiting' | 'succeeded'; retryAt: string | null }>
}
