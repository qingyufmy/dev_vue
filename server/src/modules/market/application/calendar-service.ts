import { MarketReadError, type CalendarImportance } from '../domain/calendar.js'
import type { CalendarReader } from './calendar-reader.js'

function utc(value: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new MarketReadError('calendar_query_invalid', 400)
  return value
}
export class CalendarService {
  constructor(private readonly reader: CalendarReader, private readonly now = () => new Date()) {}

  async list(input: { from: string; to: string; importance?: CalendarImportance; limit?: number; cursor?: string }) {
    const from = utc(input.from), to = utc(input.to), limit = input.limit ?? 20
    if (from > to || !Number.isInteger(limit) || limit < 1 || limit > 100
      || (input.importance !== undefined && !['low', 'medium', 'high', 'unknown'].includes(input.importance))) throw new MarketReadError('calendar_query_invalid', 400)
    const scope = JSON.stringify([from, to, input.importance ?? null])
    let after: { scheduledAt: string; id: string } | undefined
    if (input.cursor !== undefined) {
      try {
        if (!input.cursor || input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw Error('cursor')
        const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        if (value.scope !== scope || typeof value.id !== 'string' || !/^[A-Za-z0-9._:-]{1,191}$/.test(value.id)) throw Error('cursor')
        after = { scheduledAt: utc(value.scheduledAt), id: value.id }
        if (after.scheduledAt < from || after.scheduledAt > to) throw Error('cursor')
      } catch { throw new MarketReadError('calendar_cursor_invalid', 400) }
    }
    const rows = await this.reader.list({ from, to, ...(input.importance !== undefined ? { importance: input.importance } : {}),
      limit: limit + 1, ...(after ? { after } : {}) }, this.now().toISOString())
    const items = rows.slice(0, limit), hasMore = rows.length > limit
    const last = items.at(-1)
    return { items, has_more: hasMore, next_cursor: hasMore && last
      ? Buffer.from(JSON.stringify({ scope, scheduledAt: last.scheduled_at, id: last.id })).toString('base64url') : null }
  }

  async find(id: string) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,191}$/.test(id)) throw new MarketReadError('calendar_query_invalid', 400)
    const event = await this.reader.find(id, this.now().toISOString())
    if (!event) throw new MarketReadError('calendar_event_not_found', 404)
    return event
  }
}
