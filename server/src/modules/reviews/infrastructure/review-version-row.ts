import type { RowDataPacket } from 'mysql2/promise'
import { ReviewError, type ReviewVersion, type ReviewContent } from '../domain/review.js'
import { assertLegacyReviewContent, type LegacyReviewContent } from '../domain/legacy-review-content.js'
import { reviewIsoTime } from './review-sql-time.js'

export interface VersionRow extends RowDataPacket {
  id: string; review_case_id: string; version_number: number; author_kind: 'ai' | 'user'; conclusion_code: ReviewVersion['conclusion']
  content_json: string | object; full_analysis_text: string; created_at_utc: Date
}
export function versionDto(row: VersionRow): ReviewVersion { const content = reviewContent(row); return { id: row.id, caseId: row.review_case_id, versionNumber: Number(row.version_number), authorKind: row.author_kind, conclusion: row.conclusion_code, content, createdAt: reviewIsoTime(row.created_at_utc) } }
export function reviewContent(row: VersionRow): ReviewContent | LegacyReviewContent {
  const content = (typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json) as Record<string, unknown>
  if (content.schemaVersion === 'review.legacy.v1') {
    const legacy = { ...content, rawText: row.full_analysis_text }
    assertLegacyReviewContent(legacy)
    if (row.conclusion_code !== null) throw new ReviewError('review_legacy_content_invalid', 409)
    return legacy
  }
  return { ...content, fullAnalysisText: row.full_analysis_text } as unknown as ReviewContent
}
