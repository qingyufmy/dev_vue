import type { ArchivedReviewActivity } from './review-archived-activity.js'
export type ReviewActivityKind = keyof ArchivedReviewActivity
export interface ReviewArchivedActivityReader {
  page<K extends ReviewActivityKind>(userId: number, caseId: string, kind: K, options: { limit: number; offset: number }): Promise<{
    items: ArchivedReviewActivity[K]; total: number; nextOffset: number | null
  }>
}
