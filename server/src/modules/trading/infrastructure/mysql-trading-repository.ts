import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type {
  BridgeExactTradeState, ConnectionCapacityRepository, TradingProjectionRepository, TradingProjectionWrite, TradingReadRepository,
  TrustedBridgeProjectionRepository, TrustedBridgeProjectionWrite,
} from '../application/trading-ports.js'
import type {
  AccountSnapshot, MarketCandle, MarketQuote, OpenPosition, PendingOrder, RealtimeResource,
  TerminalProfileSummary, Timeframe, TradingAccountSummary, TradingContext,
} from '../domain/trading.js'
import { TradingAccessError } from '../domain/trading.js'
import { sha256Canonical } from '../../execution/domain/execution.js'
import { projectionProvesCommandResult } from '../../execution/domain/projection-absorption.js'

interface ContextRow extends RowDataPacket { user_id: number; mode: TradingContext['mode']; trading_account_id: string | null; observer_channel_id: string | null; read_only: number; revision: number }
interface AccountRow extends RowDataPacket { id: string; platform: TradingAccountSummary['platform']; account_login: string; broker_server: string; currency: string; profile_id: string; terminal_instance_id: string | null; bridge_state: TradingAccountSummary['bridgeState']; trade_permission: number; last_seen_at_utc: Date | null }
interface SnapshotRow extends AccountRow { balance: string; equity: string; margin_amount: string; free_margin: string; floating_profit: string; leverage: number | null; timezone_offset_minutes: number | null; clock_status: AccountSnapshot['clockStatus']; observed_at_utc: Date; revision: number }
interface QuoteRow extends RowDataPacket { trading_account_id: string; symbol: string; bid: string; ask: string; last_price: string | null; spread: string; trade_mode: MarketQuote['tradeMode']; observed_at_utc: Date; revision: number }
interface CandleRow extends RowDataPacket { trading_account_id: string; symbol: string; timeframe: Timeframe; open_time_utc: Date; open_price: string; high_price: string; low_price: string; close_price: string; tick_volume: string; closed: number; revision: number }
interface PayloadRow extends RowDataPacket { payload_json: string | OpenPosition | PendingOrder }
interface ProfileRow extends RowDataPacket { id: string; display_name: string; platform: TerminalProfileSummary['platform']; installation_id: string; trading_account_id: string | null; connection_state: TerminalProfileSummary['connectionState']; last_seen_at_utc: Date | null }
interface ObserverRow extends RowDataPacket { id: string; display_name: string; source_trading_account_id: string; active: number }
interface RevisionRow extends RowDataPacket { revision: number }
interface CapacityRow extends RowDataPacket { quantity: number }
interface ReservationProjectionRow extends RowDataPacket {
  reservation_id: string; reservation_revision: number; command_id: string; action: string
  params_json: string | Record<string, unknown>; expected_state_json: string | Record<string, unknown> | null; result_json: string | Record<string, unknown> | null
  action_json: string | Record<string, unknown>; completed_at_utc: Date
}

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  try { await connection.beginTransaction(); const value = await work(connection); await connection.commit(); return value }
  catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
}
const utc = (value: Date | null) => value ? new Date(value).toISOString() : null

function account(row: AccountRow): TradingAccountSummary {
  return { id: String(row.id), platform: row.platform, login: row.account_login, server: row.broker_server, currency: row.currency,
    terminalProfileId: row.profile_id, terminalInstanceId: row.terminal_instance_id, bridgeState: row.bridge_state,
    tradePermission: Boolean(row.trade_permission), lastSeenAt: utc(row.last_seen_at_utc) }
}
function accountSelect() { return `
  SELECT CAST(a.id AS CHAR) AS id, a.platform, a.account_login, a.broker_server, a.currency,
         p.id AS profile_id, b.terminal_instance_id,
         CASE WHEN s.id IS NULL THEN 'offline' ELSE 'online' END AS bridge_state,
         COALESCE(rs.trade_permission, 0) AS trade_permission, s.last_seen_at_utc
  FROM trading_accounts a
  INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.role='owner' AND o.revoked_at_utc IS NULL
  INNER JOIN terminal_account_bindings b ON b.trading_account_id=a.id AND b.unbound_at_utc IS NULL
  INNER JOIN terminal_profiles p ON p.id=b.terminal_profile_id AND p.deleted_at_utc IS NULL
  LEFT JOIN bridge_connection_sessions s ON s.trading_account_id=a.id AND s.connection_epoch=(SELECT s2.connection_epoch FROM bridge_connection_sessions s2 WHERE s2.trading_account_id=a.id AND s2.disconnected_at_utc IS NULL ORDER BY s2.connected_at_utc DESC LIMIT 1)
  LEFT JOIN account_runtime_snapshots rs ON rs.trading_account_id=a.id
  WHERE o.user_id=? AND a.deleted_at_utc IS NULL` }
function accountByIdSelect() { return `
  SELECT CAST(a.id AS CHAR) AS id, a.platform, a.account_login, a.broker_server, a.currency,
         p.id AS profile_id, b.terminal_instance_id,
         CASE WHEN s.id IS NULL THEN 'offline' ELSE 'online' END AS bridge_state,
         0 AS trade_permission, s.last_seen_at_utc
  FROM trading_accounts a
  INNER JOIN terminal_account_bindings b ON b.trading_account_id=a.id AND b.unbound_at_utc IS NULL
  INNER JOIN terminal_profiles p ON p.id=b.terminal_profile_id AND p.deleted_at_utc IS NULL
  LEFT JOIN bridge_connection_sessions s ON s.trading_account_id=a.id AND s.connection_epoch=(SELECT s2.connection_epoch FROM bridge_connection_sessions s2 WHERE s2.trading_account_id=a.id AND s2.disconnected_at_utc IS NULL ORDER BY s2.connected_at_utc DESC LIMIT 1)
  WHERE a.id=? AND a.deleted_at_utc IS NULL` }

export class MysqlTradingRepository implements TradingReadRepository, TradingProjectionRepository, TrustedBridgeProjectionRepository, ConnectionCapacityRepository {
  constructor(private readonly pool: Pool) {}

  async getContext(userId: number) {
    const [rows] = await this.pool.execute<ContextRow[]>('SELECT user_id, mode, CAST(trading_account_id AS CHAR) trading_account_id, CAST(observer_channel_id AS CHAR) observer_channel_id, read_only, revision FROM trading_contexts WHERE user_id=?', [userId])
    const row = rows[0]; return row ? { userId: row.user_id, mode: row.mode, accountId: row.trading_account_id, observerChannelId: row.observer_channel_id, readOnly: Boolean(row.read_only), revision: Number(row.revision) } : null
  }

  async saveContext(next: Omit<TradingContext, 'revision'>, expectedRevision: number | null) {
    return transaction(this.pool, async connection => {
      const [rows] = await connection.execute<ContextRow[]>('SELECT revision FROM trading_contexts WHERE user_id=? FOR UPDATE', [next.userId])
      const current = rows[0]?.revision ?? 0
      if (expectedRevision !== null && Number(current) !== expectedRevision) throw new TradingAccessError('revision_conflict', 409)
      if (next.mode === 'full') {
        const [access] = await connection.execute<RowDataPacket[]>('SELECT 1 FROM trading_account_ownerships WHERE user_id=? AND trading_account_id=? AND role=\'owner\' AND revoked_at_utc IS NULL LIMIT 1 FOR SHARE', [next.userId, next.accountId])
        if (!access[0]) throw new TradingAccessError('trading_account_forbidden', 403)
      } else if (next.mode === 'observer') {
        const [access] = await connection.execute<RowDataPacket[]>('SELECT 1 FROM observer_channel_accesses x INNER JOIN observer_channels c ON c.id=x.observer_channel_id AND c.active=1 WHERE x.user_id=? AND x.observer_channel_id=? AND x.revoked_at_utc IS NULL LIMIT 1 FOR SHARE', [next.userId, next.observerChannelId])
        if (!access[0]) throw new TradingAccessError('trading_account_forbidden', 403)
      }
      const revision = Number(current) + 1
      await connection.execute(`INSERT INTO trading_contexts (user_id,mode,trading_account_id,observer_channel_id,read_only,revision,updated_at_utc) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE mode=VALUES(mode),trading_account_id=VALUES(trading_account_id),observer_channel_id=VALUES(observer_channel_id),read_only=VALUES(read_only),revision=VALUES(revision),updated_at_utc=VALUES(updated_at_utc)`, [next.userId, next.mode, next.accountId, next.observerChannelId, next.readOnly ? 1 : 0, revision])
      return { ...next, revision }
    })
  }

  async listAccounts(userId: number) { const [rows] = await this.pool.execute<AccountRow[]>(`${accountSelect()} ORDER BY a.id`, [userId]); return rows.map(account) }
  async findAccount(accountId: string) { const [rows] = await this.pool.execute<AccountRow[]>(`${accountByIdSelect()} LIMIT 1`, [accountId]); return rows[0] ? account(rows[0]) : null }
  async findOwnedAccount(userId: number, accountId: string) { const [rows] = await this.pool.execute<AccountRow[]>(`${accountSelect()} AND a.id=? LIMIT 1`, [userId, accountId]); return rows[0] ? account(rows[0]) : null }

  async listTerminalProfiles(userId: number) {
    const [rows] = await this.pool.execute<ProfileRow[]>(`SELECT p.id,p.display_name,p.platform,p.installation_id,CAST(b.trading_account_id AS CHAR) trading_account_id,CASE WHEN s.id IS NULL THEN 'offline' ELSE 'online' END connection_state,s.last_seen_at_utc FROM terminal_profiles p LEFT JOIN terminal_account_bindings b ON b.terminal_profile_id=p.id AND b.unbound_at_utc IS NULL LEFT JOIN bridge_connection_sessions s ON s.terminal_profile_id=p.id AND s.connection_epoch=(SELECT s2.connection_epoch FROM bridge_connection_sessions s2 WHERE s2.terminal_profile_id=p.id AND s2.disconnected_at_utc IS NULL ORDER BY s2.connected_at_utc DESC LIMIT 1) WHERE p.user_id=? AND p.deleted_at_utc IS NULL ORDER BY p.updated_at_utc DESC`, [userId])
    return rows.map(row => ({ id: row.id, displayName: row.display_name, platform: row.platform, installationId: row.installation_id, accountId: row.trading_account_id, connectionState: row.connection_state, lastSeenAt: utc(row.last_seen_at_utc) }))
  }
  async listObserverChannels(userId: number) {
    const [rows] = await this.pool.execute<ObserverRow[]>(`SELECT CAST(c.id AS CHAR) id,c.display_name,CAST(c.source_trading_account_id AS CHAR) source_trading_account_id,c.active FROM observer_channels c INNER JOIN observer_channel_accesses x ON x.observer_channel_id=c.id AND x.user_id=? AND x.revoked_at_utc IS NULL WHERE c.active=1 ORDER BY c.id`, [userId])
    return rows.map(row => ({ id: row.id, displayName: row.display_name, sourceAccountId: row.source_trading_account_id, active: Boolean(row.active) }))
  }

  async getAccountSnapshot(accountId: string) {
    const [rows] = await this.pool.execute<SnapshotRow[]>(`SELECT CAST(a.id AS CHAR) id,a.platform,a.account_login,a.broker_server,a.currency,p.id profile_id,b.terminal_instance_id,CASE WHEN s.id IS NULL THEN 'offline' ELSE 'online' END bridge_state,s.last_seen_at_utc,snap.trade_permission,snap.balance,snap.equity,snap.margin_amount,snap.free_margin,snap.floating_profit,snap.leverage,snap.timezone_offset_minutes,snap.clock_status,snap.observed_at_utc,snap.revision FROM trading_accounts a INNER JOIN terminal_account_bindings b ON b.trading_account_id=a.id AND b.unbound_at_utc IS NULL INNER JOIN terminal_profiles p ON p.id=b.terminal_profile_id AND p.deleted_at_utc IS NULL INNER JOIN account_runtime_snapshots snap ON snap.trading_account_id=a.id LEFT JOIN bridge_connection_sessions s ON s.trading_account_id=a.id AND s.disconnected_at_utc IS NULL WHERE a.id=? AND a.deleted_at_utc IS NULL ORDER BY s.connected_at_utc DESC LIMIT 1`, [accountId])
    const row = rows[0]
    return row ? { ...account(row), balance: String(row.balance), equity: String(row.equity), margin: String(row.margin_amount), freeMargin: String(row.free_margin), floatingProfit: String(row.floating_profit), leverage: row.leverage, timezoneOffsetMinutes: row.timezone_offset_minutes, clockStatus: row.clock_status, observedAt: utc(row.observed_at_utc)!, revision: Number(row.revision) } : null
  }

  async listSymbols(accountId: string) {
    const [rows] = await this.pool.execute<(RowDataPacket & { symbol: string })[]>(`SELECT symbol FROM market_quotes WHERE trading_account_id=? UNION SELECT symbol FROM market_candles WHERE trading_account_id=? ORDER BY symbol`, [accountId, accountId]); return rows.map(row => row.symbol)
  }
  async getQuote(accountId: string, symbol: string) { const [rows] = await this.pool.execute<QuoteRow[]>('SELECT CAST(trading_account_id AS CHAR) trading_account_id,symbol,bid,ask,last_price,spread,trade_mode,observed_at_utc,revision FROM market_quotes WHERE trading_account_id=? AND symbol=?', [accountId, symbol]); const row = rows[0]; return row ? { accountId: row.trading_account_id, symbol: row.symbol, bid: String(row.bid), ask: String(row.ask), last: row.last_price === null ? null : String(row.last_price), spread: String(row.spread), tradeMode: row.trade_mode, observedAt: utc(row.observed_at_utc)!, revision: Number(row.revision) } : null }
  async listCandles(accountId: string, symbol: string, timeframe: Timeframe, limit: number) {
    const [rows] = await this.pool.execute<CandleRow[]>(`SELECT * FROM (SELECT CAST(trading_account_id AS CHAR) trading_account_id,symbol,timeframe,open_time_utc,open_price,high_price,low_price,close_price,tick_volume,closed,revision FROM market_candles WHERE trading_account_id=? AND symbol=? AND timeframe=? ORDER BY open_time_utc DESC LIMIT ?) tail ORDER BY open_time_utc`, [accountId, symbol, timeframe, limit])
    return rows.map(row => ({ accountId: row.trading_account_id, symbol: row.symbol, timeframe: row.timeframe, openTime: utc(row.open_time_utc)!, open: String(row.open_price), high: String(row.high_price), low: String(row.low_price), close: String(row.close_price), tickVolume: String(row.tick_volume), closed: Boolean(row.closed), revision: Number(row.revision) }))
  }
  async listPositions(accountId: string) {
    const [rows] = await this.pool.execute<PayloadRow[]>('SELECT payload_json FROM open_position_snapshots WHERE trading_account_id=? ORDER BY ticket', [accountId])
    return { revision: await this.latestRevision(accountId, 'positions', 'open'), items: rows.map(row => parsePayload<OpenPosition>(row.payload_json)) }
  }
  async listPendingOrders(accountId: string) {
    const [rows] = await this.pool.execute<PayloadRow[]>('SELECT payload_json FROM pending_order_snapshots WHERE trading_account_id=? ORDER BY ticket', [accountId])
    return { revision: await this.latestRevision(accountId, 'pending_orders', 'open'), items: rows.map(row => parsePayload<PendingOrder>(row.payload_json)) }
  }
  async latestRevision(accountId: string, resource: RealtimeResource, resourceId: string) { const [rows] = await this.pool.execute<RevisionRow[]>('SELECT revision FROM trading_projection_revisions WHERE trading_account_id=? AND resource_kind=? AND resource_id=?', [accountId, resource, resourceId]); return Number(rows[0]?.revision ?? 0) }
  async getPurchasedCapacity(userId: number) { const [rows] = await this.pool.execute<CapacityRow[]>(`SELECT COALESCE(SUM(quantity),0) quantity FROM bridge_connection_capacity_grants WHERE user_id=? AND revoked_at_utc IS NULL AND starts_at_utc<=UTC_TIMESTAMP(3) AND (expires_at_utc IS NULL OR expires_at_utc>UTC_TIMESTAMP(3))`, [userId]); return Number(rows[0]?.quantity ?? 0) }

  async applyProjection(input: TradingProjectionWrite) {
    return transaction(this.pool, connection => applyProjectionWrite(connection, input))
  }

  async applyTrustedProjection(input: TrustedBridgeProjectionWrite) {
    return transaction(this.pool, async connection => {
      const route = input.route
      await connection.execute('SELECT id FROM trading_accounts WHERE id=? AND deleted_at_utc IS NULL FOR UPDATE', [route.accountId])
      const [sessions] = await connection.execute<RowDataPacket[]>(`SELECT id FROM bridge_connection_sessions
        WHERE user_id=? AND trading_account_id=? AND terminal_profile_id=? AND terminal_instance_id=?
          AND connection_epoch_v4=? AND disconnected_at_utc IS NULL LIMIT 1 FOR UPDATE`, [
        route.userId, route.accountId, route.terminalProfileId, route.terminalInstanceId, route.connectionEpoch,
      ])
      if (!sessions[0] || input.projection.accountId !== route.accountId) throw new TradingAccessError('trading_context_invalid', 403)
      const applied = await applyProjectionWrite(connection, input.projection)
      if (!applied) return { applied: false, absorbedReservationIds: [] }
      if (input.projection.resource !== 'positions' && input.projection.resource !== 'pending_orders') {
        return { applied: true, absorbedReservationIds: [] }
      }
      const entityKind = input.projection.resource === 'positions' ? 'position' : 'pending_order'
      if (!('tradeStates' in input)) throw new TradingAccessError('trading_context_invalid', 400)
      await replaceExactTradeStates(connection, route.accountId, entityKind, route.terminalInstanceId, route.connectionEpoch,
        input.projection.revision, input.tradeStates, input.observedAt)
      const absorbedReservationIds = await absorbProjectedReservations(connection, route.accountId, entityKind, input.projection.revision,
        input.observedAt, input.tradeStates, new Date().toISOString())
      return { applied: true, absorbedReservationIds }
    })
  }
}

function parsePayload<T>(value: string | object): T { return (typeof value === 'string' ? JSON.parse(value) : value) as T }
async function replaceCollection(connection: PoolConnection, table: 'open_position_snapshots' | 'pending_order_snapshots', accountId: string, revision: number, items: Array<OpenPosition | PendingOrder>) {
  await connection.execute(`DELETE FROM ${table} WHERE trading_account_id=?`, [accountId])
  for (const item of [...items].sort((a, b) => a.ticket.localeCompare(b.ticket))) await connection.execute(`INSERT INTO ${table} (trading_account_id,ticket,payload_json,revision,observed_at_utc) VALUES (?,?,?,?,UTC_TIMESTAMP(3))`, [accountId, item.ticket, JSON.stringify(item), revision])
}

async function applyProjectionWrite(connection: PoolConnection, input: TradingProjectionWrite) {
  await connection.execute('INSERT IGNORE INTO trading_projection_revisions (trading_account_id,resource_kind,resource_id,revision,updated_at_utc) VALUES (?,?,?,0,UTC_TIMESTAMP(3))', [input.accountId, input.resource, input.resourceId])
  const [rows] = await connection.execute<RevisionRow[]>('SELECT revision FROM trading_projection_revisions WHERE trading_account_id=? AND resource_kind=? AND resource_id=? FOR UPDATE', [input.accountId, input.resource, input.resourceId])
  if (Number(rows[0]?.revision ?? 0) >= input.revision) return false
  switch (input.resource) {
    case 'account.metrics':
      await connection.execute(`INSERT INTO account_runtime_snapshots (trading_account_id,balance,equity,margin_amount,free_margin,floating_profit,leverage,timezone_offset_minutes,clock_status,trade_permission,observed_at_utc,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE balance=VALUES(balance),equity=VALUES(equity),margin_amount=VALUES(margin_amount),free_margin=VALUES(free_margin),floating_profit=VALUES(floating_profit),leverage=VALUES(leverage),timezone_offset_minutes=VALUES(timezone_offset_minutes),clock_status=VALUES(clock_status),trade_permission=VALUES(trade_permission),observed_at_utc=VALUES(observed_at_utc),revision=VALUES(revision)`, [input.data.id, input.data.balance, input.data.equity, input.data.margin, input.data.freeMargin, input.data.floatingProfit, input.data.leverage, input.data.timezoneOffsetMinutes, input.data.clockStatus, input.data.tradePermission ? 1 : 0, input.data.observedAt, input.data.revision])
      break
    case 'market.quote':
      await connection.execute(`INSERT INTO market_quotes (trading_account_id,symbol,bid,ask,last_price,spread,trade_mode,observed_at_utc,revision) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE bid=VALUES(bid),ask=VALUES(ask),last_price=VALUES(last_price),spread=VALUES(spread),trade_mode=VALUES(trade_mode),observed_at_utc=VALUES(observed_at_utc),revision=VALUES(revision)`, [input.data.accountId, input.data.symbol, input.data.bid, input.data.ask, input.data.last, input.data.spread, input.data.tradeMode, input.data.observedAt, input.data.revision])
      break
    case 'market.candle':
      await connection.execute(`INSERT INTO market_candles (trading_account_id,symbol,timeframe,open_time_utc,open_price,high_price,low_price,close_price,tick_volume,closed,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE high_price=VALUES(high_price),low_price=VALUES(low_price),close_price=VALUES(close_price),tick_volume=VALUES(tick_volume),closed=VALUES(closed),revision=VALUES(revision)`, [input.data.accountId, input.data.symbol, input.data.timeframe, input.data.openTime, input.data.open, input.data.high, input.data.low, input.data.close, input.data.tickVolume, input.data.closed ? 1 : 0, input.data.revision])
      break
    case 'positions': await replaceCollection(connection, 'open_position_snapshots', input.accountId, input.revision, input.data); break
    case 'pending_orders': await replaceCollection(connection, 'pending_order_snapshots', input.accountId, input.revision, input.data); break
  }
  await connection.execute('UPDATE trading_projection_revisions SET revision=?,updated_at_utc=UTC_TIMESTAMP(3) WHERE trading_account_id=? AND resource_kind=? AND resource_id=?', [input.revision, input.accountId, input.resource, input.resourceId])
  return true
}

async function replaceExactTradeStates(connection: PoolConnection, accountId: string, entityKind: 'position' | 'pending_order', terminalInstanceId: string,
  connectionEpoch: number, revision: number, states: BridgeExactTradeState[], observedAt: string) {
  await connection.execute('DELETE FROM bridge_trade_state_snapshots_v4 WHERE trading_account_id=? AND entity_kind=?', [accountId, entityKind])
  for (const state of [...states].sort((left, right) => left.ticket.localeCompare(right.ticket))) {
    const stateJson = JSON.stringify(state)
    await connection.execute(`INSERT INTO bridge_trade_state_snapshots_v4
      (trading_account_id,entity_kind,ticket,terminal_instance_id,connection_epoch,projection_revision,state_json,state_sha256,observed_at_utc,updated_at_utc)
      VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [
      accountId, entityKind, state.ticket, terminalInstanceId, connectionEpoch, revision, stateJson, sha256Canonical(state), observedAt,
    ])
  }
}

async function absorbProjectedReservations(connection: PoolConnection, accountId: string, entityKind: 'position' | 'pending_order', projectionRevision: number,
  observedAt: string, states: BridgeExactTradeState[], now: string) {
  const [rows] = await connection.execute<ReservationProjectionRow[]>(`SELECT r.id reservation_id,r.revision reservation_revision,c.id command_id,c.action,
      p.params_json,p.expected_state_json,ip.action_json,cr.result_json,cr.completed_at_utc
    FROM risk_reservations_v4 r
    INNER JOIN execution_intents i ON i.id=r.execution_intent_id AND i.status='succeeded'
    INNER JOIN execution_intent_payloads ip ON ip.execution_intent_id=i.id
    INNER JOIN bridge_commands_v4 c ON c.execution_intent_id=i.id AND c.status='succeeded' AND c.result_sha256 IS NOT NULL
    INNER JOIN bridge_command_payloads_v4 p ON p.bridge_command_id=c.id
    INNER JOIN bridge_command_results_v4 cr ON cr.bridge_command_id=c.id AND cr.result_sha256=c.result_sha256 AND cr.conflict=0
    WHERE r.trading_account_id=? AND r.status='committed' ORDER BY r.id FOR UPDATE`, [accountId])
  const byTicket = new Map(states.map(state => [state.ticket, state]))
  const absorbed: string[] = []
  for (const row of rows) {
    const params = parsePayload<Record<string, unknown>>(row.params_json)
    const expectedState = row.expected_state_json ? parsePayload<BridgeExactTradeState>(row.expected_state_json) : null
    const result = row.result_json ? parsePayload<Record<string, unknown>>(row.result_json) : null
    const sourceAction = parsePayload<{ expectedState?: Record<string, unknown> }>(row.action_json)
    const expectedRevision = Number(sourceAction.expectedState?.[entityKind === 'position' ? 'positionsRevision' : 'pendingOrdersRevision'])
    if (!Number.isSafeInteger(expectedRevision) || projectionRevision <= expectedRevision
      || Date.parse(observedAt) < new Date(row.completed_at_utc).getTime()) continue
    if (!projectionProvesCommandResult({ action: row.action, entityKind, params, expectedState, result, states: byTicket })) continue
    const [update] = await connection.execute<ResultSetHeader>(`UPDATE risk_reservations_v4
      SET status='absorbed',released_at_utc=?,release_reason='trusted_projection_absorbed',updated_at_utc=?,revision=revision+1
      WHERE id=? AND status='committed' AND revision=?`, [now, now, row.reservation_id, row.reservation_revision])
    if (update.affectedRows !== 1) continue
    await connection.execute(`INSERT INTO risk_reservation_events_v4
      (risk_reservation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,occurred_at_utc)
      VALUES (?,'risk.reservation.absorbed','committed','absorbed','trusted_projection_absorbed',?,?,?)`, [
      row.reservation_id, row.reservation_revision, row.reservation_revision + 1, now,
    ])
    absorbed.push(row.reservation_id)
  }
  return absorbed
}
