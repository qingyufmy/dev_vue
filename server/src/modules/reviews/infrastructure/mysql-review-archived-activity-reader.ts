import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { ArchivedReviewActivity } from '../application/review-archived-activity.js'
import type { ReviewActivityKind, ReviewArchivedActivityReader } from '../application/review-archived-activity-reader.js'
import { ReviewError } from '../domain/review.js'
import { decodeReviewArchive, type ReviewArchiveReceipt, type ReviewArchiveReference } from './review-archive-decoder.js'
import { projectReviewArchivedActivity } from './review-archived-activity-projection.js'

/** Owns only review archive reads from the immutable migration ledger, never job execution. */
export class MysqlReviewArchivedActivityReader implements ReviewArchivedActivityReader {
  private readonly cache = new Map<string, { value: ArchivedReviewActivity; bytes: number }>()
  private cacheBytes = 0
  constructor(private readonly pool: Pick<Pool, 'execute'>) {}
  async page<K extends ReviewActivityKind>(userId: number, caseId: string, kind: K, options: { limit: number; offset: number }) {
    if (!['jobs', 'events', 'stages'].includes(kind) || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100
      || !Number.isInteger(options.offset) || options.offset < 0 || options.offset > 10000) throw new ReviewError('review_history_pagination_invalid', 422)
    // Authorize every page, including cache hits; current account owners do not inherit historical cases.
    const [refs] = await this.pool.execute<(RowDataPacket & ReviewArchiveReference)[]>(`SELECT h.archive_run_id runId,h.archive_stream_id streamId,
      h.source_table sourceTable,h.source_id sourceId,h.source_bundle_sha256 bundleHash
      FROM review_cases_v4 c LEFT JOIN review_case_history_v4 h ON h.review_case_id=c.id
      WHERE c.id=? AND c.user_id=? LIMIT 1`, [caseId, userId])
    const ref = refs[0]
    if (!ref) throw new ReviewError('review_case_not_found', 404)
    let value: ArchivedReviewActivity = { jobs: [], events: [], stages: [] }
    if (ref.runId !== null) {
      const key = JSON.stringify([ref.runId, ref.streamId, ref.sourceTable, ref.sourceId, ref.bundleHash])
      const cached = this.cache.get(key)
      if (cached) { value = cached.value; this.cache.delete(key); this.cache.set(key, cached) }
      else {
        const [rows] = await this.pool.execute<(RowDataPacket & ReviewArchiveReceipt)[]>(`SELECT a.source_pk_sha256 pkHash,a.source_bytes_sha256 sourceHash,
          a.source_payload_json source,r.source_bytes_sha256 receiptHash,r.source_pk_json receiptPk,r.transformed_sha256 transformedHash,r.targets_json targets
          FROM data_migration_source_rows a JOIN data_migration_row_receipts r
          ON r.run_id=a.run_id AND r.stream_id=a.stream_id AND r.source_pk_sha256=a.source_pk_sha256
          WHERE a.run_id=? AND a.stream_id=?
          ORDER BY CAST(JSON_UNQUOTE(JSON_EXTRACT(a.source_payload_json,'$.chunkIndex')) AS UNSIGNED) LIMIT 257`, [ref.runId, ref.streamId])
        value = projectReviewArchivedActivity(decodeReviewArchive(rows, ref))
        const bytes = Buffer.byteLength(JSON.stringify(value))
        if (bytes <= 8 * 1024 * 1024) {
          while (this.cache.size >= 32 || this.cacheBytes + bytes > 8 * 1024 * 1024) {
            const oldest = this.cache.keys().next().value!
            this.cacheBytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest)
          }
          this.cache.set(key, { value, bytes }); this.cacheBytes += bytes
        }
      }
    }
    const all = value[kind], end = options.offset + options.limit
    return { items: structuredClone(all.slice(options.offset, end)) as ArchivedReviewActivity[K], total: all.length, nextOffset: end < all.length ? end : null }
  }
}
