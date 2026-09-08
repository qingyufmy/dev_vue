import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { MacroSnapshotQuery, PublicMacroSnapshotReader, ReadableMacroSnapshot } from '../application/macro-snapshot-reader.js'
import { MarketReadError } from '../domain/calendar.js'

function date(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new MarketReadError('macro_snapshot_data_invalid', 503)
  return value.toISOString()
}
function jsonDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(value)) throw new MarketReadError('macro_snapshot_data_invalid', 503)
  return date(new Date(value.replace(' ', 'T') + 'Z'))
}

export class MysqlPublicMacroSnapshotReader implements PublicMacroSnapshotReader {
  constructor(private readonly executor: Pick<Pool, 'execute'>) {}

  async list(query: MacroSnapshotQuery): Promise<ReadableMacroSnapshot[]> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 101) throw new MarketReadError('macro_snapshot_query_invalid', 400)
    const params: (string | number)[] = [query.accessAt, query.accessAt, query.asOf, query.asOf]
    let filter = ''
    if (query.id !== undefined) { filter += ' AND p.id=?'; params.push(query.id) }
    if (query.latest) {
      filter += " AND p.publication_status='published' AND p.superseded_at_utc IS NULL AND p.valid_until_utc>? AND p.freshness_status IN ('fresh','partial') AND p.health_status IN ('healthy','degraded')"
      params.push(query.accessAt)
    }
    if (query.after) {
      filter += ' AND (p.published_at_utc<? OR (p.published_at_utc=? AND p.id<?))'
      params.push(query.after.publishedAt, query.after.publishedAt, query.after.id)
    }
    params.push(query.limit)
    try {
      const [rows] = await this.executor.execute<RowDataPacket[]>(`SELECT p.id,p.schema_version,
        CAST(p.revision AS CHAR) revision,CAST(p.business_date AS CHAR) business_date,
        p.horizon,p.data_cutoff_at_utc,p.published_at_utc,p.valid_until_utc,p.freshness_status,
        p.content_sha256,p.payload_json,l.observations
        FROM macro_research_snapshots p JOIN LATERAL (
        SELECT JSON_ARRAYAGG(JSON_OBJECT('factorCode',m.factor_code,
          'observationAt',CAST(o.observation_at_utc AS CHAR),'availableAt',CAST(o.available_at_utc AS CHAR),
          'ingestedAt',CAST(o.ingested_at_utc AS CHAR),'value',CAST(o.decimal_value AS CHAR))) observations
        FROM macro_snapshot_observations m
        LEFT JOIN macro_observations o ON o.id=m.observation_id
        LEFT JOIN macro_series s ON s.id=o.series_id
        LEFT JOIN macro_data_sources d ON d.id=s.source_id
        WHERE m.snapshot_id=p.id
        HAVING MIN(CASE WHEN d.status='approved' AND d.display_allowed=1 AND d.derived_data_allowed=1
          AND d.retired_at_utc IS NULL AND d.license_reviewed_at_utc<=?
          AND (d.license_expires_at_utc IS NULL OR d.license_expires_at_utc>?) THEN 1 ELSE 0 END)=1) l ON TRUE
        WHERE p.owner_scope='platform' AND p.owner_user_id IS NULL AND p.schema_version=1
          AND p.publication_status IN ('published','superseded') AND p.published_at_utc<=?
          AND p.data_cutoff_at_utc<=?${filter}
        ORDER BY p.published_at_utc DESC,p.id DESC LIMIT ?`, params)
      return rows.map(row => {
        const observations: unknown = typeof row.observations === 'string' ? JSON.parse(row.observations) : row.observations
        if (!Array.isArray(observations) || observations.length === 0) throw new MarketReadError('macro_snapshot_lineage_invalid', 503)
        return { record: { id: row.id, schemaVersion: row.schema_version, revision: row.revision, businessDate: row.business_date,
          horizon: row.horizon, dataCutoffAt: date(row.data_cutoff_at_utc), publishedAt: date(row.published_at_utc), validUntil: date(row.valid_until_utc),
          status: row.freshness_status, contentSha256: row.content_sha256, payload: row.payload_json },
        observations: observations.map(item => ({ factorCode: item.factorCode, observationAt: jsonDate(item.observationAt),
          availableAt: jsonDate(item.availableAt), ingestedAt: jsonDate(item.ingestedAt), value: item.value })) }
      })
    } catch (error) { if (error instanceof MarketReadError) throw error; throw new MarketReadError('macro_snapshot_unavailable', 503) }
  }
}
