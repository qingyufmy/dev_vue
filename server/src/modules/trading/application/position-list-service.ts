import { TradingAccessError, type OpenPosition } from '../domain/trading.js'

interface OwnedPositionReader {
  positions(userId: number, accountId: string): Promise<{ revision: number; items: OpenPosition[] }>
}

export class PositionListService {
  constructor(private readonly reader: OwnedPositionReader) {}

  async list(userId: number, accountId: string, pageSize = 50, cursor?: string) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new TradingAccessError('position_page_invalid', 400)
    let previous: { userId: number; accountId: string; revision: number; ticket: string } | undefined
    if (cursor !== undefined) {
      try {
        if (!cursor || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error('cursor')
        previous = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (!previous || previous.userId !== userId || previous.accountId !== accountId
          || !Number.isSafeInteger(previous.revision) || previous.revision < 0
          || typeof previous.ticket !== 'string' || !previous.ticket) throw Error('cursor')
      } catch { throw new TradingAccessError('position_cursor_invalid', 400) }
    }
    const snapshot = await this.reader.positions(userId, accountId)
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
      || snapshot.items.some(item => item.accountId !== accountId || !item.ticket)
      || new Set(snapshot.items.map(item => item.ticket)).size !== snapshot.items.length) {
      throw new TradingAccessError('position_snapshot_invalid', 503)
    }
    if (previous && (previous.revision !== snapshot.revision || !snapshot.items.some(item => item.ticket === previous.ticket))) {
      throw new TradingAccessError('position_snapshot_changed', 409)
    }
    // Ticket text remains exact, including values beyond JavaScript's safe integer range.
    const rows = [...snapshot.items].sort((a, b) => a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : 0)
      .filter(item => !previous || item.ticket > previous.ticket)
    const items = rows.slice(0, pageSize), hasMore = rows.length > pageSize
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ userId, accountId, revision: snapshot.revision,
      ticket: items.at(-1)!.ticket })).toString('base64url') : null
    return { items, revision: snapshot.revision, hasMore, nextCursor }
  }
}
