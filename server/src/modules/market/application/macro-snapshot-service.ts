import { MarketReadError } from '../domain/calendar.js'
import { macroSnapshotSummary } from '../domain/macro-snapshot.js'
import type { PublicMacroSnapshotReader } from './macro-snapshot-reader.js'
import { projectReadableMacroSnapshot } from './macro-snapshot-projection.js'
import type { CalendarService } from './calendar-service.js'

function utc(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new MarketReadError('macro_snapshot_query_invalid', 400)
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,191}$/.test(value)) throw new MarketReadError('macro_snapshot_query_invalid', 400)
  return value
}

export class MacroSnapshotService {
  constructor(private readonly reader: PublicMacroSnapshotReader, private readonly calendar: Pick<CalendarService, 'list'>,
    private readonly now = () => new Date()) {}

  async list(input: { limit?: number; cursor?: string }) {
    const limit = input.limit ?? 20, now = this.now().toISOString()
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new MarketReadError('macro_snapshot_query_invalid', 400)
    let asOf = now, after: { publishedAt: string; id: string } | undefined
    if (input.cursor !== undefined) {
      try {
        if (!input.cursor || input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw Error('cursor')
        const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        if (cursor.scope !== 'macro-snapshots-v1') throw Error('cursor')
        asOf = utc(cursor.asOf)
        after = { publishedAt: utc(cursor.publishedAt), id: id(cursor.id) }
        if (asOf > now || after.publishedAt > asOf) throw Error('cursor')
      } catch { throw new MarketReadError('macro_snapshot_cursor_invalid', 400) }
    }
    const rows = await this.reader.list({ asOf, accessAt: now, limit: limit + 1, ...(after ? { after } : {}) })
    let previous = after
    const snapshots = rows.map(row => {
      const snapshot = projectReadableMacroSnapshot(row, now)
      if (snapshot.published_at > asOf || (previous && (snapshot.published_at > previous.publishedAt
        || (snapshot.published_at === previous.publishedAt && snapshot.id >= previous.id)))) throw new MarketReadError('macro_snapshot_data_invalid', 503)
      previous = { publishedAt: snapshot.published_at, id: snapshot.id }
      return snapshot
    })
    const items = snapshots.slice(0, limit).map(macroSnapshotSummary), last = items.at(-1), hasMore = rows.length > limit
    return { items, has_more: hasMore, next_cursor: hasMore && last
      ? Buffer.from(JSON.stringify({ scope: 'macro-snapshots-v1', asOf, publishedAt: last.published_at, id: last.id })).toString('base64url') : null }
  }

  async find(snapshotId: string) {
    const wanted = id(snapshotId), now = this.now().toISOString()
    const rows = await this.reader.list({ asOf: now, accessAt: now, id: wanted, limit: 1 })
    if (!rows[0]) throw new MarketReadError('macro_snapshot_not_found', 404)
    if (rows[0].record.id !== wanted) throw new MarketReadError('macro_snapshot_data_invalid', 503)
    return projectReadableMacroSnapshot(rows[0], now)
  }

  async latest() {
    const snapshot = await this.latestAt(this.now().toISOString())
    if (!snapshot) throw new MarketReadError('macro_snapshot_not_found', 404)
    return snapshot
  }

  async overview() {
    const now = this.now().toISOString()
    const [snapshot, events] = await Promise.all([this.latestAt(now), this.calendar.list({ from: now,
      to: new Date(Date.parse(now) + 7 * 86400000).toISOString(), importance: 'high', limit: 20 })])
    return { snapshot: snapshot ? macroSnapshotSummary(snapshot) : null, high_impact_events: events.items }
  }

  private async latestAt(now: string) {
    const rows = await this.reader.list({ asOf: now, accessAt: now, latest: true, limit: 1 })
    if (!rows[0]) return null
    const snapshot = projectReadableMacroSnapshot(rows[0], now)
    if (snapshot.valid_until <= now || !['fresh', 'partial'].includes(snapshot.status)) throw new MarketReadError('macro_snapshot_data_invalid', 503)
    return snapshot
  }
}
