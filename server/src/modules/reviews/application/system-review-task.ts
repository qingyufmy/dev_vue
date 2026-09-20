export type SystemReviewPageResult = { status: 'unresolved'; reason: string } | {
  status: 'processed'; nextRecordId: string | null
  results: Array<{ recordId: string; result: { status: 'unresolved'; reason: string }
    | { status: 'queued' | 'unchanged'; caseId: string } }>
}
export interface SystemReviewPageProcessor {
  run(taskId: string, afterRecordId: string | null): Promise<SystemReviewPageResult>
}
export interface SystemReviewTaskRunner {
  run(taskId: string): Promise<{ state: 'pending' | 'waiting' | 'succeeded'; retryAt: string | null }>
}
