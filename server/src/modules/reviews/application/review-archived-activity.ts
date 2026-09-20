export interface ArchivedReviewJob {
  id: string
  sourceTable: 'period_review_jobs' | 'manual_trade_review_jobs'
  sourceId: string
  originalStatus: string
  stage: string | null
  attempts: number
  errorCode: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}
export interface ArchivedReviewEvent {
  id: string
  jobId: string
  stage: string | null
  originalStatus: string
  messageCode: string | null
  occurredAt: string
}
export interface ArchivedReviewStage {
  id: string
  jobId: string
  generation: number
  stage: string
  originalStatus: string
  inputHash: string | null
  outputHash: string | null
  hasOutput: boolean
  errorCode: string | null
  createdAt: string
  completedAt: string | null
}
export interface ArchivedReviewActivity {
  jobs: ArchivedReviewJob[]
  events: ArchivedReviewEvent[]
  stages: ArchivedReviewStage[]
}
