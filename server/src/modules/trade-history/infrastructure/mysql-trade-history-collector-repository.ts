import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../../bridge/domain/bridge-gateway.js'
import type { BridgeHistoryResource, BridgeQueryResponseEnvelope } from '../../bridge/domain/bridge-query.js'
import type { TradeHistoryCollectorRepository } from '../application/trade-history-collector-ports.js'
import { resolveTradeRecordOwner } from '../application/trade-record-owner.js'
import type { OwnershipInterval } from '../../trading/index.js'
import { provenHistoryRecordSql } from './trade-history-ownership-sql.js'
import {
  decodeTerminalHistoryPage, projectMt4Trade, projectMt5Position,
  type AccountTradeProjection, type TerminalDealFact, type TerminalHistoryFact, type TerminalOrderFact,
} from '../domain/terminal-history-projection.js'

interface SyncRow extends RowDataPacket { fresh_through_utc: Date | null }
interface FactHashRow extends RowDataPacket { id: string; ticket: string; evidence_sha256: string }
interface DealEvidenceRow extends RowDataPacket { id: string; evidence_json: string | Record<string, unknown> }
interface RecordRow extends RowDataPacket { id: string }
interface FailureStateRow extends RowDataPacket { status: string; history_revision: number; fresh_through_utc: Date | null }
interface IntervalRow extends RowDataPacket {
  id: string; user_id: number; trading_account_id: string; role: OwnershipInterval['role']; started_at_utc: Date
  ended_at_utc: Date | null; origin_kind: OwnershipInterval['originKind']; origin_ref: string
}

// Both supported terminal generations post-date this boundary. Starting from a
// fixed epoch avoids silently losing an old account's history on first sync.
const INITIAL_HISTORY_START_MSC = Date.UTC(2000, 0, 1)
const OVERLAP_MSC = 24 * 60 * 60 * 1_000

export class MysqlTradeHistoryCollectorRepository implements TradeHistoryCollectorRepository {
  constructor(private readonly pool: Pool) {}

  async begin(route: BridgeGatewayRoute, now: Date) {
    return transaction(this.pool, async connection => {
      await lockAccount(connection, route)
      await connection.execute(`INSERT INTO trade_history_sync_states_v4
        (trading_account_id,status,history_revision,fresh_through_utc,last_success_at_utc,last_error_code,updated_at_utc)
        VALUES (?,'empty',0,NULL,NULL,NULL,?) ON DUPLICATE KEY UPDATE trading_account_id=VALUES(trading_account_id)`, [route.accountId, now])
      const [rows] = await connection.execute<SyncRow[]>(`SELECT fresh_through_utc FROM trade_history_sync_states_v4
        WHERE trading_account_id=? FOR UPDATE`, [route.accountId])
      const end = now.getTime()
      const prior = rows[0]?.fresh_through_utc?.getTime() ?? null
      const start = Math.max(INITIAL_HISTORY_START_MSC, prior === null ? INITIAL_HISTORY_START_MSC : prior - OVERLAP_MSC)
      await connection.execute(`UPDATE trade_history_sync_states_v4 SET status='syncing',last_error_code=NULL,updated_at_utc=?
        WHERE trading_account_id=?`, [now, route.accountId])
      return { rangeStartUtcMsc: start, rangeEndUtcMsc: end }
    })
  }

  async persistPage(route: BridgeGatewayRoute, resource: BridgeHistoryResource, response: BridgeQueryResponseEnvelope, now: Date) {
    if (response.payload.resource !== resource) throw new Error('trade_history_resource_mismatch')
    const facts = decodeTerminalHistoryPage(resource, response.payload.items).sort((left, right) => left.ticket.localeCompare(right.ticket))
    await transaction(this.pool, async connection => {
      await lockAccount(connection, route)
      await lockSync(connection, route.accountId)
      await assertFactsCompatible(connection, route.accountId, facts)
      for (const fact of facts) {
        if (fact.kind === 'order') await insertOrder(connection, route, fact, response.payload.observed_at_utc_msc, now)
        else await insertDeal(connection, route, fact, response.payload.observed_at_utc_msc, now)
      }
      if (resource === 'history.trades') {
        for (const fact of facts as TerminalDealFact[]) {
          const projection = projectMt4Trade(fact)
          if (projection) await upsertTradeRecord(connection, route, projection, response.payload.observed_at_utc_msc, now)
        }
      }
      if (resource === 'history.deals') {
        const positions = [...new Set((facts as TerminalDealFact[]).map(fact => fact.positionId).filter((value): value is string => Boolean(value)))].sort()
        for (const positionId of positions) {
          const stored = await loadPositionDeals(connection, route.accountId, positionId)
          const decoded = stored.map(row => decodeTerminalHistoryPage('history.deals', [evidence(row.evidence_json)])[0] as TerminalDealFact)
          const projection = projectMt5Position(positionId, decoded)
          if (projection) await upsertTradeRecord(connection, route, projection, response.payload.observed_at_utc_msc, now)
        }
      }
      await connection.execute('UPDATE trade_history_sync_states_v4 SET updated_at_utc=? WHERE trading_account_id=?', [now, route.accountId])
    })
  }

  async complete(route: BridgeGatewayRoute, freshThroughUtcMsc: number, now: Date) {
    await transaction(this.pool, async connection => {
      await lockAccount(connection, route)
      await lockSync(connection, route.accountId)
      await connection.execute(`UPDATE trade_history_sync_states_v4 SET status='ready',history_revision=history_revision+1,
        fresh_through_utc=?,last_success_at_utc=?,last_error_code=NULL,updated_at_utc=? WHERE trading_account_id=?`, [date(freshThroughUtcMsc), now, now, route.accountId])
      // Rebuild only this derived cache, including former owners. Facts/records
      // are never deleted; removed ownership proof cannot leave a stale total.
      await connection.execute('DELETE FROM account_trade_daily_summaries_v4 WHERE trading_account_id=?', [route.accountId])
      await connection.execute(`INSERT INTO account_trade_daily_summaries_v4
        (user_id,trading_account_id,business_date,terminal_timezone_offset_minutes,trade_count,winning_count,losing_count,gross_profit,commission,swap_amount,fee_amount,net_profit,history_revision,updated_at_utc)
        SELECT r.user_id,r.trading_account_id,r.close_business_date,MIN(r.terminal_timezone_offset_minutes),COUNT(*),SUM(r.net_profit>0),SUM(r.net_profit<0),
          SUM(r.gross_profit),SUM(r.commission),SUM(r.swap_amount),SUM(r.fee_amount),SUM(r.net_profit),s.history_revision,?
        FROM account_trade_records_v4 r INNER JOIN trade_history_sync_states_v4 s ON s.trading_account_id=r.trading_account_id
        WHERE r.trading_account_id=? AND r.status='closed' AND r.close_business_date IS NOT NULL AND ${provenHistoryRecordSql()}
        GROUP BY r.user_id,r.trading_account_id,r.close_business_date,s.history_revision
        HAVING COUNT(DISTINCT r.terminal_timezone_offset_minutes)=1 AND COUNT(r.terminal_timezone_offset_minutes)=COUNT(*)
        ON DUPLICATE KEY UPDATE terminal_timezone_offset_minutes=VALUES(terminal_timezone_offset_minutes),trade_count=VALUES(trade_count),
          winning_count=VALUES(winning_count),losing_count=VALUES(losing_count),gross_profit=VALUES(gross_profit),commission=VALUES(commission),
          swap_amount=VALUES(swap_amount),fee_amount=VALUES(fee_amount),net_profit=VALUES(net_profit),history_revision=VALUES(history_revision),updated_at_utc=VALUES(updated_at_utc)`, [now, route.accountId])
      const [revisionRows] = await connection.execute<(RowDataPacket & { history_revision: number })[]>('SELECT history_revision FROM trade_history_sync_states_v4 WHERE trading_account_id=?', [route.accountId])
      const revision = Number(revisionRows[0]!.history_revision)
      await connection.execute(`INSERT INTO outbox_events
        (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
        VALUES (?, 'trade_history', ?, 'trade.history.changed', ?, 'pending', 0, ?, ?)`, [randomUUID(), route.accountId,
        JSON.stringify({ account_id: route.accountId, status: 'ready', history_revision: String(revision), fresh_through: date(freshThroughUtcMsc).toISOString() }), now, now])
    })
  }

  async fail(route: BridgeGatewayRoute, code: string, now: Date) {
    await transaction(this.pool, async connection => {
      await lockAccount(connection, route)
      const [rows] = await connection.execute<FailureStateRow[]>(`SELECT status,history_revision,fresh_through_utc
        FROM trade_history_sync_states_v4 WHERE trading_account_id=? FOR UPDATE`, [route.accountId])
      const state = rows[0]
      if (!state) return
      await connection.execute(`UPDATE trade_history_sync_states_v4 SET status='failed',last_error_code=?,updated_at_utc=?
        WHERE trading_account_id=?`, [code.slice(0, 128), now, route.accountId])
      if (state.status === 'failed') return
      await connection.execute(`INSERT INTO outbox_events
        (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
        VALUES (?, 'trade_history', ?, 'trade.history.changed', ?, 'pending', 0, ?, ?)`, [randomUUID(), route.accountId,
        JSON.stringify({ account_id: route.accountId, status: 'failed', history_revision: String(state.history_revision), fresh_through: state.fresh_through_utc?.toISOString() ?? null }), now, now])
    })
  }
}

async function lockAccount(connection: PoolConnection, route: BridgeGatewayRoute) {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT id FROM trading_accounts WHERE id=? AND platform=? FOR UPDATE', [route.accountId, route.platform])
  if (!rows[0]) throw new Error('trade_history_account_invalid')
}

async function lockSync(connection: PoolConnection, accountId: string) {
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT trading_account_id FROM trade_history_sync_states_v4
    WHERE trading_account_id=? AND status='syncing' FOR UPDATE`, [accountId])
  if (!rows[0]) throw new Error('trade_history_sync_not_active')
}

async function assertFactsCompatible(connection: PoolConnection, accountId: string, facts: TerminalHistoryFact[]) {
  const orders = facts.filter((fact): fact is TerminalOrderFact => fact.kind === 'order')
  const deals = facts.filter((fact): fact is TerminalDealFact => fact.kind === 'deal')
  await assertKind('terminal_history_orders_v4', 'order_ticket', orders)
  await assertKind('terminal_history_deals_v4', 'deal_ticket', deals)
  async function assertKind(table: string, ticketColumn: string, values: TerminalHistoryFact[]) {
    if (!values.length) return
    const placeholders = values.map(() => '?').join(',')
    const [rows] = await connection.execute<FactHashRow[]>(`SELECT id,${ticketColumn} ticket,evidence_sha256 FROM ${table}
      WHERE trading_account_id=? AND ${ticketColumn} IN (${placeholders}) FOR UPDATE`, [accountId, ...values.map(fact => fact.ticket)])
    const hashes = new Map(rows.map(row => [row.ticket, row.evidence_sha256]))
    for (const fact of values) if (hashes.has(fact.ticket) && hashes.get(fact.ticket) !== fact.evidenceHash) throw new Error('trade_history_fact_conflict')
  }
}

async function insertOrder(connection: PoolConnection, route: BridgeGatewayRoute, fact: TerminalOrderFact, observed: number, now: Date) {
  await connection.execute(`INSERT IGNORE INTO terminal_history_orders_v4
    (id,trading_account_id,platform,order_ticket,position_id,symbol,side,order_kind,order_state,volume_initial,volume_remaining,price_open,stop_loss,take_profit,magic,terminal_reason,terminal_comment,setup_at_utc,done_at_utc,terminal_timezone_offset_minutes,evidence_sha256,evidence_json,observed_at_utc,created_at_utc,updated_at_utc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [randomUUID(), route.accountId, route.platform, fact.ticket, fact.positionId, fact.symbol, fact.side,
    fact.orderKind, fact.orderState, fact.volumeInitial, fact.volumeRemaining, fact.priceOpen, fact.stopLoss, fact.takeProfit, fact.magic, fact.terminalReason,
    fact.terminalComment, nullableDate(fact.setupAtUtcMsc), nullableDate(fact.doneAtUtcMsc), route.timezoneOffsetMinutes, fact.evidenceHash, fact.evidenceJson, date(observed), now, now])
}

async function insertDeal(connection: PoolConnection, route: BridgeGatewayRoute, fact: TerminalDealFact, observed: number, now: Date) {
  await connection.execute(`INSERT IGNORE INTO terminal_history_deals_v4
    (id,trading_account_id,platform,deal_ticket,order_ticket,position_id,symbol,deal_kind,entry_kind,side,volume,price,gross_profit,commission,swap_amount,fee_amount,magic,terminal_reason,terminal_comment,occurred_at_utc,terminal_timezone_offset_minutes,evidence_sha256,evidence_json,observed_at_utc,created_at_utc,updated_at_utc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [randomUUID(), route.accountId, route.platform, fact.ticket, fact.orderTicket, fact.positionId, fact.symbol,
    fact.dealKind, fact.entryKind, fact.side, fact.volume, fact.price, fact.grossProfit, fact.commission, fact.swap, fact.fee, fact.magic, fact.terminalReason,
    fact.terminalComment, date(fact.occurredAtUtcMsc), route.timezoneOffsetMinutes, fact.evidenceHash, fact.evidenceJson, date(observed), now, now])
}

async function loadPositionDeals(connection: PoolConnection, accountId: string, positionId: string) {
  const [rows] = await connection.execute<DealEvidenceRow[]>(`SELECT id,evidence_json FROM terminal_history_deals_v4
    WHERE trading_account_id=? AND position_id=? ORDER BY occurred_at_utc,deal_ticket FOR UPDATE`, [accountId, positionId])
  return rows
}

async function upsertTradeRecord(connection: PoolConnection, route: BridgeGatewayRoute, projection: AccountTradeProjection, observed: number, now: Date) {
  const [intervalRows] = await connection.execute<IntervalRow[]>(`SELECT id,user_id,CAST(trading_account_id AS CHAR) trading_account_id,
    role,started_at_utc,ended_at_utc,origin_kind,origin_ref FROM trading_account_ownership_intervals
    WHERE trading_account_id=? AND role='owner' AND started_at_utc<=?
      AND (ended_at_utc IS NULL OR ended_at_utc>?)
      AND (ended_at_utc IS NULL OR ended_at_utc>started_at_utc)
    ORDER BY started_at_utc,id LIMIT 2 FOR SHARE`, [route.accountId, date(projection.closedAtUtcMsc), date(projection.openedAtUtcMsc)])
  const intervals: OwnershipInterval[] = intervalRows.map(row => ({
    id: row.id, userId: row.user_id, accountId: row.trading_account_id, role: row.role,
    startedAtUtc: row.started_at_utc.toISOString(), endedAtUtc: row.ended_at_utc?.toISOString() ?? null,
    originKind: row.origin_kind, originRef: row.origin_ref,
  }))
  const owner = resolveTradeRecordOwner(route.accountId, projection, intervals, now)
  const businessDate = terminalBusinessDate(projection.closedAtUtcMsc, route.timezoneOffsetMinutes!)
  await connection.execute(`INSERT INTO account_trade_records_v4
    (id,user_id,trading_account_id,stable_trade_key,platform,primary_ticket,position_id,symbol,side,status,source_classification,attribution_status,evidence_status,
      volume_opened,volume_closed,entry_price,exit_price,stop_loss,take_profit,gross_profit,commission,swap_amount,fee_amount,net_profit,opened_at_utc,closed_at_utc,
      close_business_date,terminal_timezone_offset_minutes,evidence_sha256,observed_at_utc,legacy_source_table,legacy_id,created_at_utc,updated_at_utc,revision,ownership_interval_id)
    VALUES (?,?,?,?,?,?,?,?,?,'closed','unknown','unresolved',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,1,?)
    ON DUPLICATE KEY UPDATE ownership_interval_id=IF(user_id IS NULL OR user_id=VALUES(user_id),VALUES(ownership_interval_id),NULL),
      user_id=COALESCE(user_id,VALUES(user_id)),evidence_status=VALUES(evidence_status),volume_opened=VALUES(volume_opened),volume_closed=VALUES(volume_closed),
      entry_price=VALUES(entry_price),exit_price=VALUES(exit_price),stop_loss=VALUES(stop_loss),take_profit=VALUES(take_profit),gross_profit=VALUES(gross_profit),
      commission=VALUES(commission),swap_amount=VALUES(swap_amount),fee_amount=VALUES(fee_amount),net_profit=VALUES(net_profit),opened_at_utc=VALUES(opened_at_utc),
      closed_at_utc=VALUES(closed_at_utc),close_business_date=VALUES(close_business_date),terminal_timezone_offset_minutes=VALUES(terminal_timezone_offset_minutes),
      observed_at_utc=VALUES(observed_at_utc),updated_at_utc=VALUES(updated_at_utc),revision=IF(evidence_sha256=VALUES(evidence_sha256),revision,revision+1),evidence_sha256=VALUES(evidence_sha256)`, [
    randomUUID(), owner?.userId ?? null, route.accountId, projection.stableKey, route.platform, projection.primaryTicket, projection.positionId, projection.symbol, projection.side,
    projection.evidenceStatus, projection.volumeOpened, projection.volumeClosed, projection.entryPrice, projection.exitPrice, projection.stopLoss, projection.takeProfit,
    projection.grossProfit, projection.commission, projection.swap, projection.fee, projection.netProfit, date(projection.openedAtUtcMsc), date(projection.closedAtUtcMsc),
    businessDate, route.timezoneOffsetMinutes, projection.evidenceHash, date(observed), now, now, owner?.intervalId ?? null,
  ])
  const [records] = await connection.execute<RecordRow[]>(`SELECT id FROM account_trade_records_v4
    WHERE trading_account_id=? AND stable_trade_key=? FOR UPDATE`, [route.accountId, projection.stableKey])
  const recordId = records[0]!.id
  let sequence = 0
  for (const deal of projection.dealTickets) {
    const [facts] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT id FROM terminal_history_deals_v4
      WHERE trading_account_id=? AND deal_ticket=? LIMIT 1`, [route.accountId, deal.ticket])
    if (!facts[0]) continue
    sequence += 1
    await connection.execute(`INSERT INTO account_trade_record_deals_v4 (trade_record_id,terminal_deal_id,sequence_number,role)
      VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE role=VALUES(role)`, [recordId, facts[0].id, sequence, deal.role])
  }
}

function evidence(value: string | Record<string, unknown>) { return typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value }
function date(value: number) { return new Date(value) }
function nullableDate(value: number | null) { return value === null ? null : date(value) }
function terminalBusinessDate(utcMsc: number, offsetMinutes: number) { return new Date(utcMsc + offsetMinutes * 60_000).toISOString().slice(0, 10) }
async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) { const connection = await pool.getConnection(); try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result } catch (error) { await connection.rollback(); throw error } finally { connection.release() } }
