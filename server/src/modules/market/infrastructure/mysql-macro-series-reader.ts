import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { MacroSeriesObservation, MacroSeriesQuery, MacroSeriesReader } from '../application/macro-series-reader.js'
import { MarketReadError } from '../domain/calendar.js'

export class MysqlMacroSeriesReader implements MacroSeriesReader {
  constructor(private readonly executor: Pick<Pool, 'execute'>) {}

  async list(query: MacroSeriesQuery): Promise<MacroSeriesObservation[]> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 101) throw new MarketReadError('macro_series_query_invalid', 400)
    const params: (string | number)[] = [query.code, query.asOf, query.asOf, query.accessAt, query.accessAt, query.asOf, query.asOf, query.asOf]
    let filter = ''
    if (query.from) { filter += ' AND o.observation_at_utc>=?'; params.push(query.from) }
    if (query.to) { filter += ' AND o.observation_at_utc<=?'; params.push(query.to) }
    if (query.after) { filter += ' AND o.observation_at_utc>?'; params.push(query.after) }
    params.push(query.limit)
    try {
      const [rows] = await this.executor.execute<RowDataPacket[]>(`WITH ranked AS (SELECT s.series_code code,s.unit,s.value_kind,
        s.freshness_calendar,s.freshness_limit_seconds,s.status,o.observation_at_utc,o.available_at_utc,
        CAST(o.decimal_value AS CHAR) value,
        ROW_NUMBER() OVER (PARTITION BY o.series_id,o.observation_at_utc
          ORDER BY o.available_at_utc DESC,o.ingested_at_utc DESC,o.id DESC) vintage_rank
        FROM macro_series s JOIN macro_data_sources d ON d.id=s.source_id
        JOIN macro_observations o ON o.series_id=s.id
        WHERE s.series_code=? AND s.created_at_utc<=? AND s.updated_at_utc<=?
          AND d.status='approved' AND d.display_allowed=1 AND d.retired_at_utc IS NULL
          AND d.license_reviewed_at_utc<=? AND (d.license_expires_at_utc IS NULL OR d.license_expires_at_utc>?)
          AND o.observation_at_utc<=? AND o.available_at_utc<=? AND o.ingested_at_utc<=?${filter})
        SELECT code,unit,value_kind,freshness_calendar,freshness_limit_seconds,status,
          observation_at_utc,available_at_utc,value FROM ranked WHERE vintage_rank=1
        ORDER BY observation_at_utc LIMIT ?`, params)
      return rows.map(row => {
        const date = (value: unknown) => {
          if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new MarketReadError('macro_series_data_invalid', 503)
          return value.toISOString()
        }
        return { code: row.code, observationAt: date(row.observation_at_utc), availableAt: date(row.available_at_utc),
          value: row.value, unit: row.unit, valueKind: row.value_kind, calendar: row.freshness_calendar,
          freshnessLimitSeconds: row.freshness_limit_seconds, status: row.status }
      })
    } catch (error) { if (error instanceof MarketReadError) throw error; throw new MarketReadError('macro_series_unavailable', 503) }
  }
}
