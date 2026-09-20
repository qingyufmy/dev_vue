import type { ReviewVersion } from '../domain/review.js'

export type ReviewVersionSummary = Omit<ReviewVersion, 'content'>
export interface ReviewHistoricalMetadata {
  caseId: string
  sourceTable: string
  sourceId: string
  sourceStatus: string
  sourceEvidenceStatus: string
  sourceStrategyId: string | null
  sourceStrategyVersion: string | null
  timezoneSource: 'legacy_evidence' | 'legacy_case' | 'default_utc_plus_3'
}
export interface ReviewHistoryReader {
  listVersions(userId: number, caseId: string, options: { limit: number; beforeVersion?: number }): Promise<{ items: ReviewVersionSummary[]; nextBeforeVersion: number | null }>
  version(userId: number, caseId: string, versionId: string): Promise<ReviewVersion>
  metadata(userId: number, caseId: string): Promise<ReviewHistoricalMetadata | null>
}
