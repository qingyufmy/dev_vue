import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { ReviewHistoryReader, ReviewHistoricalMetadata, ReviewVersionSummary } from '../application/review-history-reader.js'
import { ReviewError } from '../domain/review.js'
import { reviewIsoTime } from './review-sql-time.js'
import { versionDto, type VersionRow } from './review-version-row.js'

export class MysqlReviewHistoryReader implements ReviewHistoryReader {
  constructor(private readonly pool: Pick<Pool, 'execute'>) {}
  async listVersions(userId: number, caseId: string, options: { limit: number; beforeVersion?: number }) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100 || options.beforeVersion !== undefined
      && (!Number.isInteger(options.beforeVersion) || options.beforeVersion < 1 || options.beforeVersion > 4294967295)) throw new ReviewError('review_history_pagination_invalid', 422)
    const [cases] = await this.pool.execute<RowDataPacket[]>('SELECT id FROM review_cases_v4 WHERE id=? AND user_id=? LIMIT 1', [caseId, userId])
    if (!cases[0]) throw new ReviewError('review_case_not_found', 404)
    const [rows] = await this.pool.execute<VersionRow[]>(`SELECT v.id,v.review_case_id,v.version_number,v.author_kind,v.conclusion_code,v.created_at_utc
      FROM review_versions_v4 v JOIN review_cases_v4 c ON c.id=v.review_case_id
      WHERE c.id=? AND c.user_id=?${options.beforeVersion === undefined ? '' : ' AND v.version_number<?'}
      ORDER BY v.version_number DESC LIMIT ?`, [caseId, userId, ...(options.beforeVersion === undefined ? [] : [options.beforeVersion]), String(options.limit + 1)])
    const selected = rows.slice(0, options.limit)
    const items: ReviewVersionSummary[] = selected.map(row => ({ id: row.id, caseId: row.review_case_id, versionNumber: Number(row.version_number),
      authorKind: row.author_kind, conclusion: row.conclusion_code, createdAt: reviewIsoTime(row.created_at_utc) }))
    return { items, nextBeforeVersion: rows.length > options.limit ? items.at(-1)!.versionNumber : null }
  }
  async version(userId: number, caseId: string, versionId: string) {
    const [rows] = await this.pool.execute<VersionRow[]>(`SELECT v.id,v.review_case_id,v.version_number,v.author_kind,v.conclusion_code,
      v.created_at_utc,p.content_json,p.full_analysis_text FROM review_versions_v4 v
      JOIN review_cases_v4 c ON c.id=v.review_case_id JOIN review_version_payloads_v4 p ON p.review_version_id=v.id
      WHERE c.user_id=? AND c.id=? AND v.id=? LIMIT 1`, [userId, caseId, versionId])
    if (!rows[0]) throw new ReviewError('review_version_not_found', 404)
    return versionDto(rows[0])
  }
  async metadata(userId: number, caseId: string) {
    const [rows] = await this.pool.execute<(RowDataPacket & { id: string; source_table: string | null; source_id: string; source_status: string;
      source_evidence_status: string; source_strategy_id: string | null; source_strategy_version: string | null; timezone_source: ReviewHistoricalMetadata['timezoneSource'] })[]>(
      `SELECT c.id,h.source_table,h.source_id,h.source_status,h.source_evidence_status,h.source_strategy_id,h.source_strategy_version,h.timezone_source
       FROM review_cases_v4 c LEFT JOIN review_case_history_v4 h ON h.review_case_id=c.id WHERE c.id=? AND c.user_id=? LIMIT 1`, [caseId, userId])
    const row = rows[0]
    if (!row) throw new ReviewError('review_case_not_found', 404)
    return row.source_table === null ? null : { caseId: row.id, sourceTable: row.source_table, sourceId: row.source_id,
      sourceStatus: row.source_status, sourceEvidenceStatus: row.source_evidence_status, sourceStrategyId: row.source_strategy_id,
      sourceStrategyVersion: row.source_strategy_version, timezoneSource: row.timezone_source }
  }
}
