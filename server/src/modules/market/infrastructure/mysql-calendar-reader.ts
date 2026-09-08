import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { CalendarPageQuery, CalendarReader } from '../application/calendar-reader.js'
import { MarketReadError, type CalendarEvent } from '../domain/calendar.js'

const schedule = 'COALESCE(r.scheduled_at_utc,e.scheduled_at_utc)'
const select = `SELECT e.id,e.provider_event_id,e.country_code country,e.currency_code currency,e.title,
  ${schedule} scheduled_at,e.time_precision,e.importance,e.period_label period,e.unit,
  CAST(r.previous_value AS CHAR) previous,CAST(r.consensus_value AS CHAR) consensus,
  CAST(r.actual_value AS CHAR) actual,CAST(r.revised_previous_value AS CHAR) revised_previous,
  COALESCE(r.status,e.status) status,COALESCE(r.provider_updated_at_utc,e.provider_updated_at_utc) provider_updated_at,
  CAST(e.revision AS CHAR) revision
  FROM economic_calendar_events e JOIN macro_data_sources s ON s.id=e.source_id
  LEFT JOIN economic_calendar_event_revisions r ON r.id=(
    SELECT v.id FROM economic_calendar_event_revisions v WHERE v.event_id=e.id
      AND v.available_at_utc<=? AND v.ingested_at_utc<=?
    ORDER BY v.revision_number DESC,v.id DESC LIMIT 1)
  WHERE s.status='approved' AND s.display_allowed=1 AND s.retired_at_utc IS NULL
    AND s.license_reviewed_at_utc IS NOT NULL AND s.license_reviewed_at_utc<=?
    AND (s.license_expires_at_utc IS NULL OR s.license_expires_at_utc>?)
    AND e.created_at_utc<=? AND e.updated_at_utc<=?`

function event(row: RowDataPacket): CalendarEvent {
  const date = (value: unknown): string => {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new MarketReadError('calendar_data_invalid', 503)
    return value.toISOString()
  }
  return { id: row.id, provider_event_id: row.provider_event_id, country: row.country, currency: row.currency,
    title: row.title, scheduled_at: date(row.scheduled_at), time_precision: row.time_precision, importance: row.importance,
    period: row.period, unit: row.unit, previous: row.previous, consensus: row.consensus, actual: row.actual,
    revised_previous: row.revised_previous, status: row.status,
    provider_updated_at: row.provider_updated_at === null ? null : date(row.provider_updated_at), revision: row.revision }
}

export class MysqlCalendarReader implements CalendarReader {
  constructor(private readonly executor: Pick<Pool, 'execute'>) {}
  async list(query: CalendarPageQuery, now: string) {
    const params: (string | number)[] = Array(6).fill(now)
    let filter = ` AND ${schedule}>=? AND ${schedule}<=?`
    params.push(query.from, query.to)
    if (query.importance !== undefined) { filter += ' AND e.importance=?'; params.push(query.importance) }
    if (query.after) {
      filter += ` AND (${schedule}>? OR (${schedule}=? AND e.id>?))`
      params.push(query.after.scheduledAt, query.after.scheduledAt, query.after.id)
    }
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 101) throw new MarketReadError('calendar_query_invalid', 400)
    params.push(query.limit)
    return this.read(`${select}${filter} ORDER BY ${schedule},e.id LIMIT ?`, params)
  }
  async find(id: string, now: string) {
    return (await this.read(`${select} AND e.id=? LIMIT 1`, [...Array(6).fill(now), id]))[0] ?? null
  }
  private async read(sql: string, params: (string | number)[]) {
    try { const [rows] = await this.executor.execute<RowDataPacket[]>(sql, params); return rows.map(event) }
    catch (error) { if (error instanceof MarketReadError) throw error; throw new MarketReadError('calendar_unavailable', 503) }
  }
}
