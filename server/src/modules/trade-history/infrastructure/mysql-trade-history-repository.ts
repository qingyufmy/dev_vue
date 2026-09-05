import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { TradeHistoryRepository, TradeHistoryRepositoryPage } from '../application/trade-history-ports.js'
import { ownHistoryAccountSql, provenHistoryRecordSql } from './trade-history-ownership-sql.js'
import type {
  TradeHistoryDailyPoint, TradeHistoryFilter, TradeHistoryFreshness, TradeHistorySummary,
  TradeRecordAttribution, TradeRecordDeal, TradeRecordDetail, TradeRecordSummary,
} from '../domain/trade-history.js'

interface TradeRow extends RowDataPacket {
  id: string; trading_account_id: string; platform: TradeRecordSummary['platform']; primary_ticket: string; position_id: string | null
  symbol: string; side: TradeRecordSummary['side']; status: TradeRecordSummary['status']; source_classification: TradeRecordSummary['source']
  attribution_status: TradeRecordSummary['attributionStatus']; evidence_status: TradeRecordSummary['evidenceStatus']; volume_opened: string
  entry_price: string; exit_price: string | null; stop_loss: string | null; take_profit: string | null; gross_profit: string
  commission: string; swap_amount: string; fee_amount: string; net_profit: string; opened_at_utc: Date; closed_at_utc: Date | null
  terminal_timezone_offset_minutes: number; evidence_sha256: string; revision: number
}
interface FreshnessRow extends RowDataPacket { status: TradeHistoryFreshness['status']; history_revision: number; fresh_through_utc: Date | null; last_success_at_utc: Date | null }
interface SummaryRow extends RowDataPacket { trade_count: number; winning_count: number; losing_count: number; breakeven_count: number; win_rate_percent: string | null; gross_profit: string; commission: string; swap_amount: string; fee_amount: string; net_profit: string; profit_factor: string | null }
interface DailyRow extends RowDataPacket { business_date: Date | string; trade_count: number; net_profit: string }
interface DealRow extends RowDataPacket { id: string; deal_ticket: string; order_ticket: string | null; role: TradeRecordDeal['role']; side: TradeRecordDeal['side']; entry_kind: TradeRecordDeal['entryKind']; volume: string | null; price: string | null; gross_profit: string; commission: string; swap_amount: string; fee_amount: string; occurred_at_utc: Date }
interface AttributionRow extends RowDataPacket { source_kind: TradeRecordAttribution['kind']; source_id: string; relation_kind: TradeRecordAttribution['relation']; proof_kind: TradeRecordAttribution['proofKind'] }

export class MysqlTradeHistoryRepository implements TradeHistoryRepository {
  constructor(private readonly pool: Pool) {}

  async canReadHistoryAccount(userId: number, accountId: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(ownHistoryAccountSql(), [userId, accountId])
    return Boolean(rows[0])
  }

  async list(userId: number, filter: TradeHistoryFilter): Promise<TradeHistoryRepositoryPage> {
    const base = criteria(userId, filter, false)
    const page = criteria(userId, filter, true)
    const [records, freshnessRows, summaryRows, dailyRows] = await Promise.all([
      this.pool.execute<TradeRow[]>(`${tradeSelect()} ${page.sql} ORDER BY r.closed_at_utc DESC,r.id DESC LIMIT ?`, [...page.params, filter.limit + 1]),
      this.pool.execute<FreshnessRow[]>(`SELECT 'stale' status,MAX(r.revision) history_revision,
        NULL fresh_through_utc,NULL last_success_at_utc
        FROM account_trade_records_v4 r ${base.sql} HAVING COUNT(*)>0`, base.params),
      this.pool.execute<SummaryRow[]>(`SELECT COUNT(*) trade_count,SUM(r.net_profit>0) winning_count,SUM(r.net_profit<0) losing_count,SUM(r.net_profit=0) breakeven_count,
        CASE WHEN COUNT(*)=0 THEN NULL ELSE CAST(ROUND(100*SUM(r.net_profit>0)/COUNT(*),4) AS CHAR) END win_rate_percent,
        CAST(COALESCE(SUM(r.gross_profit),0) AS CHAR) gross_profit,CAST(COALESCE(SUM(r.commission),0) AS CHAR) commission,
        CAST(COALESCE(SUM(r.swap_amount),0) AS CHAR) swap_amount,CAST(COALESCE(SUM(r.fee_amount),0) AS CHAR) fee_amount,
        CAST(COALESCE(SUM(r.net_profit),0) AS CHAR) net_profit,
        CASE WHEN ABS(COALESCE(SUM(CASE WHEN r.net_profit<0 THEN r.net_profit ELSE 0 END),0))=0 THEN NULL
          ELSE CAST(ROUND(COALESCE(SUM(CASE WHEN r.net_profit>0 THEN r.net_profit ELSE 0 END),0)/ABS(SUM(CASE WHEN r.net_profit<0 THEN r.net_profit ELSE 0 END)),8) AS CHAR) END profit_factor
        FROM account_trade_records_v4 r ${base.sql}`, base.params),
      this.pool.execute<DailyRow[]>(`SELECT r.close_business_date business_date,COUNT(*) trade_count,CAST(SUM(r.net_profit) AS CHAR) net_profit
        FROM account_trade_records_v4 r ${base.sql} AND r.close_business_date IS NOT NULL
        GROUP BY r.close_business_date ORDER BY r.close_business_date`, base.params),
    ])
    const rows = records[0]
    const hasMore = rows.length > filter.limit
    const items = rows.slice(0, filter.limit).map(record)
    return {
      items, hasMore,
      freshness: freshness(freshnessRows[0][0]),
      summary: summary(summaryRows[0][0]),
      daily: cumulative(dailyRows[0]),
    }
  }

  async find(userId: number, recordId: string): Promise<TradeRecordDetail | null> {
    const [records, deals, attributions] = await Promise.all([
      this.pool.execute<TradeRow[]>(`${tradeSelect()} WHERE r.user_id=? AND r.id=? AND ${provenHistoryRecordSql()} LIMIT 1`, [userId, recordId]),
      this.pool.execute<DealRow[]>(`SELECT d.id,d.deal_ticket,d.order_ticket,x.role,d.side,d.entry_kind,CAST(d.volume AS CHAR) volume,CAST(d.price AS CHAR) price,
        CAST(d.gross_profit AS CHAR) gross_profit,CAST(d.commission AS CHAR) commission,CAST(d.swap_amount AS CHAR) swap_amount,
        CAST(d.fee_amount AS CHAR) fee_amount,d.occurred_at_utc FROM account_trade_record_deals_v4 x
        INNER JOIN account_trade_records_v4 r ON r.id=x.trade_record_id AND r.user_id=?
        INNER JOIN terminal_history_deals_v4 d ON d.id=x.terminal_deal_id AND d.trading_account_id=r.trading_account_id
        WHERE x.trade_record_id=? AND ${provenHistoryRecordSql()}
          AND d.occurred_at_utc>=r.opened_at_utc AND d.occurred_at_utc<=r.closed_at_utc ORDER BY x.sequence_number`, [userId, recordId]),
      this.pool.execute<AttributionRow[]>(`SELECT a.source_kind,a.source_id,a.relation_kind,a.proof_kind FROM account_trade_attributions_v4 a
        INNER JOIN account_trade_records_v4 r ON r.id=a.trade_record_id AND r.user_id=?
        WHERE a.trade_record_id=? AND ${provenHistoryRecordSql()} ORDER BY a.id`, [userId, recordId]),
    ])
    const row = records[0][0]
    if (!row) return null
    return {
      ...record(row), evidenceHash: row.evidence_sha256,
      deals: deals[0].map(deal), attributions: attributions[0].map(attribution),
    }
  }
}

function tradeSelect() { return `SELECT r.id,CAST(r.trading_account_id AS CHAR) trading_account_id,r.platform,r.primary_ticket,r.position_id,r.symbol,r.side,r.status,
  r.source_classification,r.attribution_status,r.evidence_status,CAST(r.volume_opened AS CHAR) volume_opened,CAST(r.entry_price AS CHAR) entry_price,
  CAST(r.exit_price AS CHAR) exit_price,CAST(r.stop_loss AS CHAR) stop_loss,CAST(r.take_profit AS CHAR) take_profit,
  CAST(r.gross_profit AS CHAR) gross_profit,CAST(r.commission AS CHAR) commission,CAST(r.swap_amount AS CHAR) swap_amount,
  CAST(r.fee_amount AS CHAR) fee_amount,CAST(r.net_profit AS CHAR) net_profit,r.opened_at_utc,r.closed_at_utc,
  r.terminal_timezone_offset_minutes,r.evidence_sha256,r.revision FROM account_trade_records_v4 r` }

function criteria(userId: number, filter: TradeHistoryFilter, includeCursor: boolean) {
  const conditions = ['r.user_id=?', 'r.trading_account_id=?', "r.status='closed'", 'r.closed_at_utc IS NOT NULL', 'r.closed_at_utc<=?', provenHistoryRecordSql()]
  const params: Array<string | number> = [userId, filter.accountId, filter.capturedEnd]
  if (filter.symbol) { conditions.push('r.symbol=?'); params.push(filter.symbol) }
  if (filter.side) { conditions.push('r.side=?'); params.push(filter.side) }
  if (filter.source) { conditions.push('r.source_classification=?'); params.push(filter.source) }
  if (filter.outcome) conditions.push(filter.outcome === 'profit' ? 'r.net_profit>0' : filter.outcome === 'loss' ? 'r.net_profit<0' : 'r.net_profit=0')
  if (filter.fromBusinessDate) { conditions.push('r.close_business_date>=?'); params.push(filter.fromBusinessDate) }
  if (filter.toBusinessDate) { conditions.push('r.close_business_date<=?'); params.push(filter.toBusinessDate) }
  if (filter.query) { conditions.push('(r.primary_ticket=? OR r.position_id=? OR r.symbol=?)'); params.push(filter.query, filter.query, filter.query.toUpperCase()) }
  if (includeCursor && filter.cursor) {
    conditions.push('(r.closed_at_utc<? OR (r.closed_at_utc=? AND r.id<?))')
    params.push(filter.cursor.closedAt, filter.cursor.closedAt, filter.cursor.id)
  }
  return { sql: `WHERE ${conditions.join(' AND ')}`, params }
}

function record(row: TradeRow): TradeRecordSummary {
  return { id: row.id, accountId: row.trading_account_id, platform: row.platform, primaryTicket: row.primary_ticket,
    positionId: row.position_id, symbol: row.symbol, side: row.side, status: row.status, source: row.source_classification,
    attributionStatus: row.attribution_status, evidenceStatus: row.evidence_status, volume: String(row.volume_opened), entryPrice: String(row.entry_price),
    exitPrice: nullable(row.exit_price), stopLoss: nullable(row.stop_loss), takeProfit: nullable(row.take_profit), grossProfit: String(row.gross_profit),
    commission: String(row.commission), swap: String(row.swap_amount), fee: String(row.fee_amount), netProfit: String(row.net_profit),
    openedAt: utc(row.opened_at_utc)!, closedAt: utc(row.closed_at_utc), terminalTimezoneOffsetMinutes: Number(row.terminal_timezone_offset_minutes), revision: Number(row.revision) }
}
function deal(row: DealRow): TradeRecordDeal { return { id: row.id, dealTicket: row.deal_ticket, orderTicket: row.order_ticket, role: row.role, side: row.side,
  entryKind: row.entry_kind, volume: nullable(row.volume), price: nullable(row.price), grossProfit: String(row.gross_profit), commission: String(row.commission),
  swap: String(row.swap_amount), fee: String(row.fee_amount), occurredAt: utc(row.occurred_at_utc)! } }
function attribution(row: AttributionRow): TradeRecordAttribution { return { kind: row.source_kind, sourceId: row.source_id, relation: row.relation_kind, proofKind: row.proof_kind } }
function freshness(row?: FreshnessRow): TradeHistoryFreshness { return row ? { status: row.status, historyRevision: Number(row.history_revision), freshThrough: utc(row.fresh_through_utc), lastSuccessAt: utc(row.last_success_at_utc) } : { status: 'empty', historyRevision: 0, freshThrough: null, lastSuccessAt: null } }
function summary(row?: SummaryRow): TradeHistorySummary { return row ? { tradeCount: Number(row.trade_count), winningCount: Number(row.winning_count), losingCount: Number(row.losing_count), breakevenCount: Number(row.breakeven_count), winRatePercent: nullable(row.win_rate_percent), grossProfit: String(row.gross_profit), commission: String(row.commission), swap: String(row.swap_amount), fee: String(row.fee_amount), netProfit: String(row.net_profit), profitFactor: nullable(row.profit_factor) } : { tradeCount: 0, winningCount: 0, losingCount: 0, breakevenCount: 0, winRatePercent: null, grossProfit: '0', commission: '0', swap: '0', fee: '0', netProfit: '0', profitFactor: null } }
function cumulative(rows: DailyRow[]): TradeHistoryDailyPoint[] { let total = '0'; return rows.map(row => { total = decimalAdd(total, String(row.net_profit)); return { businessDate: businessDate(row.business_date), tradeCount: Number(row.trade_count), netProfit: String(row.net_profit), cumulativeNetProfit: total } }) }
function decimalAdd(left: string, right: string) { const scale = Math.max(fraction(left), fraction(right)); const factor = 10n ** BigInt(scale); const parse = (value: string) => { const [whole, decimals = ''] = value.split('.'); const sign = whole!.startsWith('-') ? -1n : 1n; const digits = whole!.replace('-', '') + decimals.padEnd(scale, '0'); return sign * BigInt(digits || '0') }; const value = parse(left) + parse(right); const sign = value < 0 ? '-' : ''; const digits = (value < 0 ? -value : value).toString().padStart(scale + 1, '0'); return scale ? `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}` : `${sign}${digits}` }
function fraction(value: string) { return value.split('.')[1]?.length ?? 0 }
function nullable(value: unknown) { return value === null || value === undefined ? null : String(value) }
function utc(value: Date | null) { return value ? new Date(value).toISOString() : null }
function businessDate(value: Date | string) { return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10) }
