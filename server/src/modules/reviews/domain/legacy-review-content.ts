import { createHash } from 'node:crypto'
import { ReviewError, type LegacyReviewContent } from './review.js'

export type { LegacyReviewContent } from './review.js'

/** Imported text is immutable evidence, never an inferred V4 assessment. */
export function assertLegacyReviewContent(value: unknown): asserts value is LegacyReviewContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReviewError('review_legacy_content_invalid', 422)
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'originalContentHash,rawText,schemaVersion,sourceId,sourceSha256,sourceTable'
    || v.schemaVersion !== 'review.legacy.v1' || !['period_review_versions', 'manual_trade_review_versions', 'trade_review_versions'].includes(String(v.sourceTable))
    || typeof v.sourceId !== 'string' || !/^[1-9]\d{0,19}$/.test(v.sourceId)
    || typeof v.rawText !== 'string' || Buffer.byteLength(v.rawText) > 16_777_215
    || typeof v.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sourceSha256)
    || v.originalContentHash !== null && (typeof v.originalContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.originalContentHash))
    || createHash('sha256').update(v.rawText).digest('hex') !== v.sourceSha256) throw new ReviewError('review_legacy_content_invalid', 422)
}
