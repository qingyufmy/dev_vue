import { createHash } from 'node:crypto'
import { assertOpaqueId, assertSymbol } from '../../trading/index.js'
import {
  decodeTradeHistoryCursor, encodeTradeHistoryCursor, TradeHistoryError,
  type TradeHistoryFilter, type TradeHistorySide, type TradeHistorySource, type TradeOutcomeFilter,
} from '../domain/trade-history.js'
import type { TradeHistoryRepository } from './trade-history-ports.js'

export interface TradeHistoryQuery {
  accountId: string
  symbol?: string
  side?: string
  source?: string
  outcome?: string
  fromDate?: string
  toDate?: string
  query?: string
  pageSize?: number
  cursor?: string
}

export class TradeHistoryService {
  constructor(private readonly repository: TradeHistoryRepository, private readonly now: () => Date = () => new Date()) {}

  async records(userId: number, input: TradeHistoryQuery) {
    const accountId = validId(input.accountId, 'trading_account_id')
    if (!await this.repository.canReadHistoryAccount(userId, accountId)) throw new TradeHistoryError('trade_history_account_forbidden', 403)
    const normalized = normalize(input, accountId, this.now())
    const page = await this.repository.list(userId, normalized)
    const last = page.items.at(-1)
    return {
      ...page,
      capturedEnd: normalized.capturedEnd,
      nextCursor: page.hasMore && last?.closedAt ? encodeTradeHistoryCursor({
        version: 1, accountId, filterKey: filterKey(normalized), capturedEnd: normalized.capturedEnd,
        closedAt: last.closedAt, id: last.id,
      }) : null,
    }
  }

  async detail(userId: number, recordId: string) {
    const record = await this.repository.find(userId, validId(recordId, 'trade_record_id'))
    if (!record) throw new TradeHistoryError('trade_record_not_found', 404)
    return record
  }
}

function normalize(input: TradeHistoryQuery, accountId: string, now: Date): TradeHistoryFilter {
  const cursor = input.cursor ? decodeTradeHistoryCursor(input.cursor) : null
  const capturedEnd = cursor?.capturedEnd ?? now.toISOString()
  const filter: TradeHistoryFilter = {
    accountId,
    limit: Math.min(Math.max(Number.isFinite(input.pageSize) ? Math.trunc(input.pageSize!) : 50, 1), 100),
    capturedEnd,
    cursor,
  }
  if (input.symbol) filter.symbol = assertSymbol(input.symbol)
  if (input.side) filter.side = oneOf(input.side, ['buy', 'sell'], 'trade_history_side_invalid') as TradeHistorySide
  if (input.source) filter.source = oneOf(input.source, ['system', 'manual', 'other_ea', 'mixed', 'unknown'], 'trade_history_source_invalid') as TradeHistorySource
  if (input.outcome) filter.outcome = oneOf(input.outcome, ['profit', 'loss', 'breakeven'], 'trade_history_outcome_invalid') as TradeOutcomeFilter
  if (input.fromDate) filter.fromBusinessDate = businessDate(input.fromDate, 'trade_history_from_date_invalid')
  if (input.toDate) filter.toBusinessDate = businessDate(input.toDate, 'trade_history_to_date_invalid')
  if (filter.fromBusinessDate && filter.toBusinessDate && filter.fromBusinessDate > filter.toBusinessDate) throw new TradeHistoryError('trade_history_range_invalid', 400)
  if (input.query) {
    const query = input.query.trim()
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(query)) throw new TradeHistoryError('trade_history_query_invalid', 400)
    filter.query = query
  }
  if (cursor && (cursor.accountId !== accountId || cursor.filterKey !== filterKey(filter))) throw new TradeHistoryError('trade_history_cursor_invalid', 400)
  return filter
}

function filterKey(filter: TradeHistoryFilter) {
  return createHash('sha256').update(JSON.stringify({ symbol: filter.symbol ?? null, side: filter.side ?? null, source: filter.source ?? null,
    outcome: filter.outcome ?? null, fromDate: filter.fromBusinessDate ?? null, toDate: filter.toBusinessDate ?? null, query: filter.query ?? null })).digest('hex')
}
function validId(value: string, field: string) { try { return assertOpaqueId(value, field) } catch { throw new TradeHistoryError(`${field}_invalid`, 400) } }
function oneOf(value: string, values: string[], code: string) { if (!values.includes(value)) throw new TradeHistoryError(code, 400); return value }
function businessDate(value: string, code: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TradeHistoryError(code, 400)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new TradeHistoryError(code, 400)
  return value
}
