import { MarketReadError } from '../domain/calendar.js'
import type { MacroSeriesObservation, MacroSeriesReader } from './macro-series-reader.js'

export interface MacroSeriesFreshness {
  evaluate(point: MacroSeriesObservation, asOf: string): 'fresh' | 'stale' | 'missing' | 'disabled' | 'invalid'
}

function utc(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new MarketReadError('macro_series_query_invalid', 400)
  return value
}

export class MacroSeriesService {
  constructor(private readonly reader: MacroSeriesReader, private readonly freshness: MacroSeriesFreshness,
    private readonly now = () => new Date()) {}

  async list(input: { code: string; from?: string; to?: string; limit?: number; cursor?: string }) {
    const limit = input.limit ?? 20
    if (typeof input.code !== 'string' || input.code.length < 1 || input.code.length > 64
      || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new MarketReadError('macro_series_query_invalid', 400)
    const from = input.from === undefined ? undefined : utc(input.from)
    const to = input.to === undefined ? undefined : utc(input.to)
    if (from && to && from > to) throw new MarketReadError('macro_series_query_invalid', 400)
    const scope = JSON.stringify([input.code, from ?? null, to ?? null])
    const now = this.now().toISOString()
    let asOf = now, after: string | undefined
    if (input.cursor !== undefined) {
      try {
        if (!input.cursor || input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw Error('cursor')
        const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        if (cursor.scope !== scope) throw Error('cursor')
        asOf = utc(cursor.asOf); after = utc(cursor.after)
        if (asOf > now || after > asOf || (from && after < from) || (to && after > to)) throw Error('cursor')
      } catch { throw new MarketReadError('macro_series_cursor_invalid', 400) }
    }
    const rows = await this.reader.list({ code: input.code, asOf, accessAt: now, limit: limit + 1,
      ...(from ? { from } : {}), ...(to ? { to } : {}), ...(after ? { after } : {}) })
    // Each observation time has exactly one selected vintage; it is the page key.
    let previous = after
    for (const row of rows) {
      let observationAt: string, availableAt: string
      try { observationAt = utc(row.observationAt); availableAt = utc(row.availableAt) }
      catch { throw new MarketReadError('macro_series_data_invalid', 503) }
      if (row.code !== input.code || observationAt > asOf || availableAt > asOf
        || (previous && observationAt <= previous) || (from && observationAt < from) || (to && observationAt > to)) {
        throw new MarketReadError('macro_series_data_invalid', 503)
      }
      previous = observationAt
    }
    const selected = rows.slice(0, limit), hasMore = rows.length > limit, last = selected.at(-1)
    const items = selected.map(point => ({ code: point.code, observation_at: point.observationAt,
      available_at: point.availableAt, value: point.value, unit: point.unit,
      freshness: point.status !== 'enabled' ? 'disabled' as const
        : point.valueKind !== 'decimal' ? 'invalid' as const : this.freshness.evaluate(point, asOf) }))
    return { items, has_more: hasMore, next_cursor: hasMore && last
      ? Buffer.from(JSON.stringify({ scope, asOf, after: last.observationAt })).toString('base64url') : null }
  }
}
