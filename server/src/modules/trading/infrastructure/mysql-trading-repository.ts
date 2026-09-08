import { MysqlTradingContextWriter } from './mysql-trading-context-writer.js'
import { resolveStoredAccountClock } from './mysql-account-clock.js'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type {
  BridgeExactTradeState, ConnectionCapacityRepository, TradingProjectionRepository, TradingProjectionWrite, TradingReadRepository,
  TrustedBridgeProjectionRepository, TrustedBridgeProjectionWrite,
} from '../application/trading-ports.js'
import { MysqlObserverAccessReader } from './mysql-observer-access-reader.js'
import type { BridgeGatewayLeaseStore } from '../../bridge/index.js'
import type {
  AccountSnapshot, MarketCandle, MarketQuote, OpenPosition, PendingOrder, RealtimeResource,
  TerminalProfileSummary, Timeframe, TradingAccountSummary, TradingContext,
} from '../domain/trading.js'
import { TradingAccessError } from '../domain/trading.js'
import { sha256Canonical } from '../../execution/domain/execution.js'
import { projectionProvesCommandResult } from '../../execution/domain/projection-absorption.js'

interface ContextRow extends RowDataPacket { user_id: number; mode: TradingContext['mode']; trading_account_id: string | null; observer_channel_id: string | null; read_only: number; revision: number }
interface AccountRow extends RowDataPacket {
  id: string; platform: TradingAccountSummary['platform']; account_login: string; broker_server: string; currency: string
  owner_user_id: number | null; ownership_interval_id: string | null; ownership_revision: string | number | null
  profile_id: string | null; terminal_instance_id: string | null; bridge_state: TradingAccountSummary['bridgeState']
  trade_permission: number; snapshot_trade_permission: number; connection_paused: number
  last_seen_at_utc: Date | null
}
interface SnapshotRow extends AccountRow, ProjectionSourceRow { balance: string; equity: string; margin_amount: string; free_margin: string; floating_profit: string; leverage: number | null; timezone_offset_minutes: number | null; clock_status: AccountSnapshot['clockStatus']; observed_at_utc: Date; revision: number }
interface QuoteRow extends RowDataPacket { trading_account_id: string; symbol: string; bid: string; ask: string; last_price: string | null; spread: string; trade_mode: MarketQuote['tradeMode']; observed_at_utc: Date; revision: number }
interface CandleRow extends RowDataPacket { trading_account_id: string; symbol: string; timeframe: Timeframe; open_time_utc: Date; open_price: string; high_price: string; low_price: string; close_price: string; tick_volume: string; closed: number; revision: number }
interface PayloadRow extends RowDataPacket { payload_json: string | OpenPosition | PendingOrder }
interface ProfileRow extends RowDataPacket { id: string; display_name: string; platform: TerminalProfileSummary['platform']; installation_id: string; trading_account_id: string | null; connection_state: TerminalProfileSummary['connectionState']; last_seen_at_utc: Date | null }
interface RevisionRow extends RowDataPacket { revision: number }
interface CapacityRow extends RowDataPacket { quantity: number }
interface SessionHeartbeatRow extends RowDataPacket { last_seen_at_utc: Date }
interface ProjectionSourceRow extends RowDataPacket {
  revision: string | number
  source_user_id: number | null; source_interval_id: string | null; source_ownership_revision: string | number | null
  source_profile_id: string | null; source_instance_id: string | null; source_connection_epoch: string | number | null
  projection_revision: string | number | null
}
interface ProjectionPayloadRow extends RowDataPacket { payload_json: string | OpenPosition | PendingOrder; revision: string | number }
interface OwnershipProofRow extends RowDataPacket { interval_id: string; ownership_revision: string | number }
interface CredentialProofRow extends RowDataPacket { id: string | number }
interface PermissionRow extends ProjectionSourceRow { trade_permission: number }
interface ReservationProjectionRow extends RowDataPacket {
  reservation_id: string; reservation_revision: number; command_id: string; action: string
  params_json: string | Record<string, unknown>; expected_state_json: string | Record<string, unknown> | null; result_json: string | Record<string, unknown> | null
  action_json: string | Record<string, unknown>; completed_at_utc: Date
}

interface CurrentProjectionContext {
  row: AccountRow
  userId: number
  intervalId: string
  ownershipRevision: string
  profileId: string
  instanceId: string
}

interface LiveRouteState {
  online: boolean
  epoch: string | null
  lastSeenAtUtc: Date | null
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
    terminalProfileId: row.profile_id ?? null, terminalInstanceId: row.terminal_instance_id, bridgeState: row.bridge_state,
    tradePermission: Number(row.trade_permission) === 1, lastSeenAt: utc(row.last_seen_at_utc) }
}
function currentAccountSelect(withUser: boolean, withAccount = false) { return `
  SELECT CAST(a.id AS CHAR) AS id, a.platform, a.account_login, a.broker_server, a.currency,
         o.user_id AS owner_user_id, o.interval_id AS ownership_interval_id, a.ownership_revision,
         CASE WHEN COUNT(b.terminal_profile_id)=1 AND COUNT(p.id)=1 THEN MIN(p.id) ELSE NULL END AS profile_id,
         CASE WHEN COUNT(b.terminal_profile_id)=1 AND COUNT(p.id)=1 THEN MIN(b.terminal_instance_id) ELSE NULL END AS terminal_instance_id,
         CASE WHEN COALESCE(settings.connection_paused, 0)=1 THEN 'paused' ELSE 'offline' END AS bridge_state,
         CASE WHEN COALESCE(settings.connection_paused, 0)=1 THEN 0 ELSE COALESCE(rs.trade_permission, 0) END AS trade_permission,
         COALESCE(rs.trade_permission, 0) AS snapshot_trade_permission,
         COALESCE(settings.connection_paused, 0) AS connection_paused,
         NULL AS last_seen_at_utc
  FROM trading_accounts a
  INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.role='owner' AND o.revoked_at_utc IS NULL
  INNER JOIN trading_account_ownership_intervals oi ON oi.id=o.interval_id AND oi.user_id=o.user_id
    AND oi.trading_account_id=o.trading_account_id AND oi.role='owner' AND oi.ended_at_utc IS NULL
    AND oi.started_at_utc=o.granted_at_utc AND oi.started_at_utc<=UTC_TIMESTAMP(3)
  INNER JOIN users u ON u.id=o.user_id AND u.deletion_status='active' AND u.deleted_at IS NULL
  LEFT JOIN terminal_account_bindings b ON b.trading_account_id=a.id AND b.unbound_at_utc IS NULL
  LEFT JOIN terminal_profiles p ON p.id=b.terminal_profile_id AND p.user_id=o.user_id
    AND p.platform=a.platform AND p.deleted_at_utc IS NULL
  LEFT JOIN user_trading_account_settings settings ON settings.user_id=o.user_id AND settings.trading_account_id=a.id
  LEFT JOIN account_runtime_snapshots rs ON rs.trading_account_id=a.id
  WHERE a.deleted_at_utc IS NULL AND o.revision=a.ownership_revision${withUser ? ' AND o.user_id=?' : ''}${withAccount ? ' AND a.id=?' : ''}
  GROUP BY a.id,a.platform,a.account_login,a.broker_server,a.currency,o.user_id,o.interval_id,a.ownership_revision,
    settings.connection_paused,rs.trade_permission` }

function historyAccountSelect() { return `
  SELECT CAST(a.id AS CHAR) AS id, a.platform, a.account_login, a.broker_server, a.currency,
         NULL AS owner_user_id, NULL AS ownership_interval_id, NULL AS ownership_revision,
         NULL AS profile_id, NULL AS terminal_instance_id, 'offline' AS bridge_state,
         0 AS trade_permission, 0 AS snapshot_trade_permission, 0 AS connection_paused,
         NULL AS last_seen_at_utc
  FROM trading_accounts a
  INNER JOIN users u ON u.id=? AND u.deletion_status='active' AND u.deleted_at IS NULL
  WHERE EXISTS (
    SELECT 1 FROM trading_account_ownership_intervals i
    WHERE i.user_id=u.id AND i.trading_account_id=a.id AND i.role='owner'
      AND i.started_at_utc<=UTC_TIMESTAMP(3)
  )` }

function accountByIdSelect() { return `
  SELECT CAST(a.id AS CHAR) AS id, a.platform, a.account_login, a.broker_server, a.currency,
         NULL AS owner_user_id, NULL AS ownership_interval_id, NULL AS ownership_revision,
         CASE WHEN COUNT(b.terminal_profile_id)=1 AND COUNT(p.id)=1 THEN MIN(p.id) ELSE NULL END AS profile_id,
         CASE WHEN COUNT(b.terminal_profile_id)=1 AND COUNT(p.id)=1 THEN MIN(b.terminal_instance_id) ELSE NULL END AS terminal_instance_id,
         'offline' AS bridge_state, 0 AS trade_permission, 0 AS snapshot_trade_permission, 0 AS connection_paused,
         NULL AS last_seen_at_utc
  FROM trading_accounts a
  LEFT JOIN terminal_account_bindings b ON b.trading_account_id=a.id AND b.unbound_at_utc IS NULL
  LEFT JOIN terminal_profiles p ON p.id=b.terminal_profile_id AND p.deleted_at_utc IS NULL
  WHERE a.id=? AND a.deleted_at_utc IS NULL
  GROUP BY a.id,a.platform,a.account_login,a.broker_server,a.currency` }

function accountProjectionFields() { return `
        pp.user_id AS source_user_id, pp.ownership_interval_id AS source_interval_id,
        pp.ownership_revision AS source_ownership_revision, pp.terminal_profile_id AS source_profile_id,
        pp.terminal_instance_id AS source_instance_id, pp.connection_epoch AS source_connection_epoch,
        pp.projection_revision AS projection_revision, pp.terminal_profile_id AS profile_id,
        pp.terminal_instance_id AS terminal_instance_id, 'offline' AS bridge_state,
        snap.trade_permission AS trade_permission, snap.trade_permission AS snapshot_trade_permission,
        0 AS connection_paused, NULL AS last_seen_at_utc`
}

function projectionSourceFields() { return `
    pr.revision, pp.user_id AS source_user_id, pp.ownership_interval_id AS source_interval_id,
    pp.ownership_revision AS source_ownership_revision, pp.terminal_profile_id AS source_profile_id,
    pp.terminal_instance_id AS source_instance_id, pp.connection_epoch AS source_connection_epoch,
    pp.projection_revision AS projection_revision`
}

function projectionResourceId(_resource: 'positions' | 'pending_orders') { return 'open' }

export class MysqlTradingRepository implements TradingReadRepository, TradingProjectionRepository, TrustedBridgeProjectionRepository, ConnectionCapacityRepository {
  constructor(
    private readonly pool: Pool,
    private readonly gatewayLeases: Pick<BridgeGatewayLeaseStore, 'current'> | null = null,
    observerAccessReader?: MysqlObserverAccessReader,
  ) { this.observerAccessReader = observerAccessReader ?? new MysqlObserverAccessReader(pool) }

  private readonly observerAccessReader: MysqlObserverAccessReader

  async getContext(userId: number) {
    const [rows] = await this.pool.execute<ContextRow[]>('SELECT user_id, mode, CAST(trading_account_id AS CHAR) trading_account_id, CAST(observer_channel_id AS CHAR) observer_channel_id, read_only, revision FROM trading_contexts WHERE user_id=?', [userId])
    const row = rows[0]
    if (!row) return null
    const context = { userId: row.user_id, mode: row.mode, accountId: row.trading_account_id, observerChannelId: row.observer_channel_id, readOnly: row.mode === 'observer' ? true : Boolean(row.read_only), revision: Number(row.revision) } satisfies TradingContext
    if (context.mode !== 'observer') return context
    if (!context.observerChannelId) {
      return { ...context, mode: 'blocked' as const, accountId: null, observerChannelId: null, readOnly: true }
    }
    const allowed = await this.observerAccessReader.authorize(userId, context.observerChannelId, context.accountId ?? undefined)
    if (allowed && (context.accountId === null || allowed.accountId === context.accountId)) return context
    return { ...context, mode: 'blocked' as const, accountId: null, observerChannelId: null, readOnly: true }
  }

  saveContext(next: Omit<TradingContext, 'revision'>, expectedRevision: number | null) {
    return new MysqlTradingContextWriter(this.pool, this.observerAccessReader).saveContext(next, expectedRevision)
  }

  async listAccounts(userId: number, access: 'current' | 'history' = 'current') {
    if (access === 'history') {
      const [rows] = await this.pool.execute<AccountRow[]>(`${historyAccountSelect()} ORDER BY a.id`, [userId])
      return rows.map(account)
    }
    const [rows] = await this.pool.execute<AccountRow[]>(`${currentAccountSelect(true)} ORDER BY a.id`, [userId])
    return Promise.all(rows.map(row => this.hydrateCurrentAccount(row, userId)))
  }

  async findAccount(accountId: string) {
    const [rows] = await this.pool.execute<AccountRow[]>(accountByIdSelect(), [accountId])
    return rows.length === 1 ? account(rows[0]!) : null
  }

  async findOwnedAccount(userId: number, accountId: string) {
    const [rows] = await this.pool.execute<AccountRow[]>(currentAccountSelect(true, true), [userId, accountId])
    if (rows.length !== 1) return null
    return this.hydrateCurrentAccount(rows[0]!, userId)
  }

  async listTerminalProfiles(userId: number) {
    const [rows] = await this.pool.execute<ProfileRow[]>(`SELECT p.id,p.display_name,p.platform,p.installation_id,CAST(b.trading_account_id AS CHAR) trading_account_id,CASE WHEN s.id IS NULL THEN 'offline' ELSE 'online' END connection_state,s.last_seen_at_utc FROM terminal_profiles p LEFT JOIN terminal_account_bindings b ON b.terminal_profile_id=p.id AND b.unbound_at_utc IS NULL LEFT JOIN bridge_connection_sessions s ON s.terminal_profile_id=p.id AND s.connection_epoch=(SELECT s2.connection_epoch FROM bridge_connection_sessions s2 WHERE s2.terminal_profile_id=p.id AND s2.disconnected_at_utc IS NULL ORDER BY s2.connected_at_utc DESC LIMIT 1) WHERE p.user_id=? AND p.deleted_at_utc IS NULL ORDER BY p.updated_at_utc DESC`, [userId])
    return rows.map(row => ({ id: row.id, displayName: row.display_name, platform: row.platform, installationId: row.installation_id, accountId: row.trading_account_id, connectionState: row.connection_state, lastSeenAt: utc(row.last_seen_at_utc) }))
  }
  async listObserverChannels(userId: number) {
    return this.observerAccessReader.list(userId)
  }

  async getAccountSnapshot(accountId: string, userId: number) {
    const context = await this.currentProjectionContext(accountId, userId)
    if (!context) return null
    const [rows] = await this.pool.execute<SnapshotRow[]>(`SELECT
        CAST(snap.trading_account_id AS CHAR) id,a.platform,a.account_login,a.broker_server,a.currency,
        ${accountProjectionFields()}, snap.balance,snap.equity,snap.margin_amount,snap.free_margin,
        snap.floating_profit,snap.leverage,snap.timezone_offset_minutes,snap.clock_status,snap.observed_at_utc,snap.revision
      FROM account_runtime_snapshots snap
      INNER JOIN trading_accounts a ON a.id=snap.trading_account_id AND a.deleted_at_utc IS NULL
      INNER JOIN trading_projection_revisions pr ON pr.trading_account_id=snap.trading_account_id
        AND pr.resource_kind='account.metrics' AND pr.resource_id='current' AND pr.revision=snap.revision
      INNER JOIN trading_projection_provenance_v4 pp ON pp.trading_account_id=pr.trading_account_id
        AND pp.resource_kind=pr.resource_kind AND pp.resource_id=pr.resource_id
        AND pp.projection_revision=pr.revision
      WHERE snap.trading_account_id=? AND pp.user_id=? AND pp.ownership_interval_id=?
        AND pp.ownership_revision=? AND pp.terminal_profile_id=? AND pp.terminal_instance_id=?`, [
      accountId, context.userId, context.intervalId, context.ownershipRevision,
      context.profileId, context.instanceId,
    ])
    const row = rows.length === 1 ? rows[0]! : null
    if (!row || !projectionSourceMatches(row, context)) return null
    const latestContext = await this.currentProjectionContext(accountId, userId)
    if (!latestContext || !sameProjectionContext(context, latestContext)) return null
    const latestSource = await this.projectionSource(accountId, 'account.metrics', 'current')
    if (!latestSource || !projectionSourcesEqual(row, latestSource) || !projectionSourceMatches(latestSource, latestContext)) return null
    const live = await this.liveRoute(latestContext)
    if (live.online && String(row.source_connection_epoch) !== String(live.epoch)) return null
    const summary = await this.hydrateCurrentAccount(latestContext.row, latestContext.userId)
    return {
      ...summary, tradePermission: summary.tradePermission && Number(row.trade_permission) === 1,
      balance: String(row.balance), equity: String(row.equity), margin: String(row.margin_amount),
      freeMargin: String(row.free_margin), floatingProfit: String(row.floating_profit), leverage: row.leverage,
      timezoneOffsetMinutes: row.timezone_offset_minutes, clockStatus: row.clock_status,
      observedAt: utc(row.observed_at_utc)!, revision: Number(row.revision),
    }
  }

  private async hydrateCurrentAccount(row: AccountRow, userId: number) {
    const base = account({ ...row, bridge_state: Number(row.connection_paused) === 1 ? 'paused' : 'offline', trade_permission: 0, last_seen_at_utc: null })
    if (base.bridgeState === 'paused' || row.owner_user_id === null || row.ownership_interval_id === null
      || row.ownership_revision === null || !row.profile_id || !row.terminal_instance_id) return base
    const context: CurrentProjectionContext = {
      row, userId, intervalId: String(row.ownership_interval_id), ownershipRevision: String(row.ownership_revision),
      profileId: row.profile_id, instanceId: row.terminal_instance_id,
    }
    const live = await this.liveRoute(context)
    if (!live.online) return base
    const tradePermission = await this.currentSnapshotTradePermission(context, live)
    return { ...base, bridgeState: 'online' as const, tradePermission, lastSeenAt: utc(live.lastSeenAtUtc) }
  }

  private async currentSnapshotTradePermission(context: CurrentProjectionContext, live: LiveRouteState) {
    if (!live.online) return false
    try {
      const [rows] = await this.pool.execute<PermissionRow[]>(`SELECT ${projectionSourceFields()}, snap.trade_permission
        FROM account_runtime_snapshots snap
        INNER JOIN trading_projection_revisions pr ON pr.trading_account_id=snap.trading_account_id
          AND pr.resource_kind='account.metrics' AND pr.resource_id='current' AND pr.revision=snap.revision
        INNER JOIN trading_projection_provenance_v4 pp ON pp.trading_account_id=pr.trading_account_id
          AND pp.resource_kind=pr.resource_kind AND pp.resource_id=pr.resource_id
          AND pp.projection_revision=pr.revision
        WHERE snap.trading_account_id=?`, [context.row.id])
      const source = rows.length === 1 ? rows[0]! : null
      return Boolean(source && Number(source.trade_permission) === 1 && projectionSourceMatches(source, context)
        && String(source.source_connection_epoch) === String(live.epoch))
    } catch {
      return false
    }
  }

  private async projectionSource(accountId: string, resource: 'account.metrics' | 'positions' | 'pending_orders', resourceId: string) {
    const [rows] = await this.pool.execute<ProjectionSourceRow[]>(`SELECT ${projectionSourceFields()}
      FROM trading_projection_revisions pr
      LEFT JOIN trading_projection_provenance_v4 pp ON pp.trading_account_id=pr.trading_account_id
        AND pp.resource_kind=pr.resource_kind AND pp.resource_id=pr.resource_id
      WHERE pr.trading_account_id=? AND pr.resource_kind=? AND pr.resource_id=?`, [accountId, resource, resourceId])
    return rows.length === 1 ? rows[0]! : null
  }

  private async currentProjectionContext(accountId: string, userId: number): Promise<CurrentProjectionContext | null> {
    const [rows] = await this.pool.execute<AccountRow[]>(currentAccountSelect(true, true), [userId, accountId])
    const row = rows.length === 1 ? rows[0]! : null
    if (!row || row.owner_user_id === null || row.ownership_interval_id === null || row.ownership_revision === null
      || row.profile_id === null || row.terminal_instance_id === null) return null
    return {
      row, userId: row.owner_user_id, intervalId: row.ownership_interval_id,
      ownershipRevision: String(row.ownership_revision), profileId: row.profile_id, instanceId: row.terminal_instance_id,
    }
  }

  private async liveRoute(context: CurrentProjectionContext): Promise<LiveRouteState> {
    if (Number(context.row.connection_paused) === 1 || !this.gatewayLeases) return { online: false, epoch: null, lastSeenAtUtc: null }
    let route: Awaited<ReturnType<BridgeGatewayLeaseStore['current']>>
    try { route = await this.gatewayLeases.current(context.row.id) }
    catch { return { online: false, epoch: null, lastSeenAtUtc: null } }
    if (!route || route.userId !== context.userId || route.accountId !== context.row.id
      || route.platform !== context.row.platform || route.brokerServer !== context.row.broker_server
      || route.login !== context.row.account_login || route.terminalProfileId !== context.profileId
      || route.terminalInstanceId !== context.instanceId || typeof route.connectionId !== 'string' || route.connectionId.length < 1
      || !Number.isSafeInteger(route.connectionEpoch) || route.connectionEpoch < 1) {
      return { online: false, epoch: null, lastSeenAtUtc: null }
    }
    try {
      const [sessions] = await this.pool.execute<SessionHeartbeatRow[]>(`SELECT s.last_seen_at_utc
        FROM bridge_connection_sessions s
        INNER JOIN trading_accounts a ON a.id=s.trading_account_id AND a.platform=?
          AND BINARY a.broker_server=BINARY ? AND BINARY a.account_login=BINARY ?
        INNER JOIN users u ON u.id=s.user_id AND u.deletion_status='active' AND u.deleted_at IS NULL
        INNER JOIN terminal_profiles p ON p.id=s.terminal_profile_id AND p.user_id=s.user_id
          AND p.platform=a.platform AND p.deleted_at_utc IS NULL
        INNER JOIN terminal_account_bindings b ON b.trading_account_id=s.trading_account_id
          AND b.terminal_profile_id=s.terminal_profile_id AND b.terminal_instance_id=s.terminal_instance_id
          AND b.unbound_at_utc IS NULL
        WHERE s.user_id=? AND s.trading_account_id=? AND s.terminal_profile_id=? AND s.terminal_instance_id=?
          AND s.connection_epoch_v4=? AND s.connection_epoch=? AND s.disconnected_at_utc IS NULL
          AND s.last_seen_at_utc>=UTC_TIMESTAMP(3)-INTERVAL 45 SECOND`, [
        context.row.platform, context.row.broker_server, context.row.account_login,
        route.userId, route.accountId, route.terminalProfileId, route.terminalInstanceId,
        route.connectionEpoch, `v4:${route.connectionId}`,
      ])
      if (sessions.length !== 1) return { online: false, epoch: null, lastSeenAtUtc: null }
      return { online: true, epoch: String(route.connectionEpoch), lastSeenAtUtc: sessions[0]!.last_seen_at_utc }
    } catch {
      return { online: false, epoch: null, lastSeenAtUtc: null }
    }
  }

  private async listPrivateCollection<T extends OpenPosition | PendingOrder>(
    accountId: string,
    userId: number,
    resource: 'positions' | 'pending_orders',
    table: 'open_position_snapshots' | 'pending_order_snapshots',
  ) {
    const context = await this.currentProjectionContext(accountId, userId)
    if (!context) return { revision: 0, items: [] as T[] }
    const source = await this.projectionSource(accountId, resource, projectionResourceId(resource))
    const revision = Number(source?.revision ?? 0)
    if (!source || !projectionSourceMatches(source, context)) return { revision: 0, items: [] as T[] }
    const live = await this.liveRoute(context)
    if (live.online && String(source.source_connection_epoch) !== String(live.epoch)) return { revision: 0, items: [] as T[] }
    const [rows] = await this.pool.execute<ProjectionPayloadRow[]>(`SELECT payload_json,revision FROM ${table}
      WHERE trading_account_id=? AND revision=? ORDER BY ticket`, [accountId, revision])
    const latestContext = await this.currentProjectionContext(accountId, userId)
    const latestSource = await this.projectionSource(accountId, resource, projectionResourceId(resource))
    if (!latestContext || !sameProjectionContext(context, latestContext) || !latestSource
      || !projectionSourcesEqual(source, latestSource) || !projectionSourceMatches(latestSource, latestContext)) {
      return { revision: 0, items: [] as T[] }
    }
    const latestLive = await this.liveRoute(latestContext)
    if (latestLive.online && String(latestSource.source_connection_epoch) !== String(latestLive.epoch)) return { revision: 0, items: [] as T[] }
    const items: T[] = []
    for (const row of rows) {
      if (Number(row.revision) !== revision) return { revision: 0, items: [] as T[] }
      const item = parsePayload<T>(row.payload_json)
      if (item.accountId !== accountId) return { revision: 0, items: [] as T[] }
      items.push(item)
    }
    return { revision, items }
  }

  async listSymbols(accountId: string) {
    const [rows] = await this.pool.execute<(RowDataPacket & { symbol: string })[]>(`SELECT symbol FROM market_quotes WHERE trading_account_id=? UNION SELECT symbol FROM market_candles WHERE trading_account_id=? ORDER BY symbol`, [accountId, accountId]); return rows.map(row => row.symbol)
  }
  async getQuote(accountId: string, symbol: string) { const [rows] = await this.pool.execute<QuoteRow[]>('SELECT CAST(trading_account_id AS CHAR) trading_account_id,symbol,bid,ask,last_price,spread,trade_mode,observed_at_utc,revision FROM market_quotes WHERE trading_account_id=? AND symbol=?', [accountId, symbol]); const row = rows[0]; return row ? { accountId: row.trading_account_id, symbol: row.symbol, bid: String(row.bid), ask: String(row.ask), last: row.last_price === null ? null : String(row.last_price), spread: String(row.spread), tradeMode: row.trade_mode, observedAt: utc(row.observed_at_utc)!, revision: Number(row.revision) } : null }
  async listCandles(accountId: string, symbol: string, timeframe: Timeframe, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TradingAccessError('market_candle_limit_invalid', 422)
    const [rows] = await this.pool.execute<CandleRow[]>(`SELECT * FROM (SELECT CAST(trading_account_id AS CHAR) trading_account_id,symbol,timeframe,open_time_utc,open_price,high_price,low_price,close_price,tick_volume,closed,revision FROM market_candles WHERE trading_account_id=? AND symbol=? AND timeframe=? ORDER BY open_time_utc DESC LIMIT ?) tail ORDER BY open_time_utc`, [accountId, symbol, timeframe, String(limit)])
    return rows.map(row => ({ accountId: row.trading_account_id, symbol: row.symbol, timeframe: row.timeframe, openTime: utc(row.open_time_utc)!, open: String(row.open_price), high: String(row.high_price), low: String(row.low_price), close: String(row.close_price), tickVolume: String(row.tick_volume), closed: Boolean(row.closed), revision: Number(row.revision) }))
  }
  async listPositions(accountId: string, userId: number) {
    return this.listPrivateCollection<OpenPosition>(accountId, userId, 'positions', 'open_position_snapshots')
  }
  async listPendingOrders(accountId: string, userId: number) {
    return this.listPrivateCollection<PendingOrder>(accountId, userId, 'pending_orders', 'pending_order_snapshots')
  }
  async latestRevision(accountId: string, resource: RealtimeResource, resourceId: string) { const [rows] = await this.pool.execute<RevisionRow[]>('SELECT revision FROM trading_projection_revisions WHERE trading_account_id=? AND resource_kind=? AND resource_id=?', [accountId, resource, resourceId]); return Number(rows[0]?.revision ?? 0) }
  async getPurchasedCapacity(userId: number) { const [rows] = await this.pool.execute<CapacityRow[]>(`SELECT COALESCE(SUM(quantity),0) quantity FROM bridge_connection_capacity_grants WHERE user_id=? AND revoked_at_utc IS NULL AND starts_at_utc<=UTC_TIMESTAMP(3) AND (expires_at_utc IS NULL OR expires_at_utc>UTC_TIMESTAMP(3))`, [userId]); return Number(rows[0]?.quantity ?? 0) }

  async applyProjection(input: TradingProjectionWrite) {
    return transaction(this.pool, async connection => {
      if (!await lockProjectionRevision(connection, input)) return false
      return writeLockedProjection(connection, input)
    })
  }

  async applyTrustedProjection(input: TrustedBridgeProjectionWrite) {
    return transaction(this.pool, async connection => {
      const route = input.route
      // A connection id identifies a production gateway route.  Its frozen
      // device/ownership proof is mandatory there; the id-less path remains
      // for the in-process projector used by legacy/offline callers.
      const gatewayRoute = route.connectionId !== undefined
      let gatewayProof: {
        connectionId: string
        installationId: string
        credentialGeneration: number
        ownershipRevision: string
      } | null = null
      if (gatewayRoute) {
        const { connectionId, installationId, credentialGeneration, ownershipRevision } = route
        if (typeof connectionId !== 'string' || connectionId.length === 0 || typeof installationId !== 'string' || installationId.length === 0
          || typeof ownershipRevision !== 'string' || !/^[1-9][0-9]*$/.test(ownershipRevision)) {
          throw new TradingAccessError('trading_context_invalid', 403)
        }
        if (typeof credentialGeneration !== 'number' || !Number.isSafeInteger(credentialGeneration) || credentialGeneration <= 0) {
          throw new TradingAccessError('trading_context_invalid', 403)
        }
        gatewayProof = { connectionId, installationId, credentialGeneration, ownershipRevision }
      }
      const [accounts] = await connection.execute<RowDataPacket[]>('SELECT id FROM trading_accounts WHERE id=? AND deleted_at_utc IS NULL FOR UPDATE', [route.accountId])
      if (accounts.length !== 1 || input.projection.accountId !== route.accountId) throw new TradingAccessError('trading_context_invalid', 403)
      const [owners] = await connection.execute<OwnershipProofRow[]>(`SELECT o.interval_id,a.ownership_revision
        FROM trading_accounts a
        INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.user_id=?
          AND o.role='owner' AND o.revoked_at_utc IS NULL
        INNER JOIN trading_account_ownership_intervals oi ON oi.id=o.interval_id AND oi.user_id=o.user_id
          AND oi.trading_account_id=o.trading_account_id AND oi.role='owner' AND oi.ended_at_utc IS NULL
          AND oi.started_at_utc=o.granted_at_utc AND oi.started_at_utc<=UTC_TIMESTAMP(3)
        INNER JOIN users u ON u.id=o.user_id AND u.deletion_status='active' AND u.deleted_at IS NULL
        WHERE a.id=? AND o.revision=a.ownership_revision
        FOR UPDATE`, [route.userId, route.accountId])
      if (gatewayProof && (owners.length !== 1 || String(owners[0]!.ownership_revision) !== gatewayProof.ownershipRevision)) {
        throw new TradingAccessError('trading_context_invalid', 403)
      }
      if (gatewayProof) {
        const [credentials] = await connection.execute<CredentialProofRow[]>(`SELECT s.id
          FROM bridge_refresh_sessions s
          INNER JOIN users u ON u.id=s.user_id
          INNER JOIN terminal_profiles p ON p.id=s.profile_id AND p.user_id=s.user_id
            AND p.installation_id=? AND p.deleted_at_utc IS NULL
          WHERE s.user_id=? AND s.installation_id=? AND s.profile_id=? AND s.generation=?
            AND s.credential_version=4 AND s.revoked_at IS NULL
            AND u.deletion_status='active' AND u.deleted_at IS NULL
            AND (u.role='admin' OR (u.plan='pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at>UTC_TIMESTAMP(3))))
          FOR UPDATE`, [gatewayProof.installationId, route.userId, gatewayProof.installationId, route.terminalProfileId, gatewayProof.credentialGeneration])
        if (credentials.length !== 1) throw new TradingAccessError('trading_context_invalid', 403)
      }
      const [bindings] = await connection.execute<RowDataPacket[]>(`SELECT b.terminal_profile_id
        FROM terminal_account_bindings b
        INNER JOIN terminal_profiles p ON p.id=b.terminal_profile_id AND p.user_id=?
          AND p.id=? AND p.platform=(SELECT platform FROM trading_accounts WHERE id=?) AND p.deleted_at_utc IS NULL
        WHERE b.trading_account_id=? AND b.terminal_instance_id=? AND b.unbound_at_utc IS NULL
        FOR UPDATE`, [route.userId, route.terminalProfileId, route.accountId, route.accountId, route.terminalInstanceId])
      const [sessions] = await connection.execute<RowDataPacket[]>(`SELECT s.id
        FROM bridge_connection_sessions s
        INNER JOIN trading_accounts a ON a.id=s.trading_account_id AND a.deleted_at_utc IS NULL
        WHERE s.user_id=? AND s.trading_account_id=? AND s.terminal_profile_id=? AND s.terminal_instance_id=?
          AND s.connection_epoch_v4=? AND s.disconnected_at_utc IS NULL
          ${gatewayProof ? 'AND s.connection_epoch=?' : ''}
        FOR UPDATE`, gatewayProof ? [
          route.userId, route.accountId, route.terminalProfileId, route.terminalInstanceId,
          route.connectionEpoch, `v4:${gatewayProof.connectionId}`,
        ] : [route.userId, route.accountId, route.terminalProfileId, route.terminalInstanceId, route.connectionEpoch])
      if (owners.length !== 1 || bindings.length !== 1 || sessions.length !== 1) throw new TradingAccessError('trading_context_invalid', 403)
      const ownership = { intervalId: owners[0]!.interval_id, ownershipRevision: String(owners[0]!.ownership_revision) }
      if (!await lockProjectionRevision(connection, input.projection)) return { applied: false, absorbedReservationIds: [] }
      const clock = await resolveStoredAccountClock(connection, input, ownership)
      const projection = input.projection.resource === 'account.metrics' && clock
        ? { ...input.projection, data: { ...input.projection.data, ...clock } } : input.projection
      await writeLockedProjection(connection, projection)
      await writeProjectionProvenance(connection, input, ownership)
      if (input.projection.resource !== 'positions' && input.projection.resource !== 'pending_orders') {
        return { applied: true, absorbedReservationIds: [], ...(clock ? { clock } : {}) }
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
function projectionSourceMatches(source: ProjectionSourceRow, context: CurrentProjectionContext) {
  const revision = Number(source.revision)
  const projectionRevision = Number(source.projection_revision)
  const epoch = Number(source.source_connection_epoch)
  return Number(source.source_user_id) === context.userId
    && source.source_interval_id === context.intervalId
    && String(source.source_ownership_revision) === context.ownershipRevision
    && source.source_profile_id === context.profileId
    && source.source_instance_id === context.instanceId
    && Number.isSafeInteger(revision) && revision > 0
    && Number.isSafeInteger(projectionRevision) && projectionRevision === revision
    && Number.isSafeInteger(epoch) && epoch > 0
}
function sameProjectionContext(left: CurrentProjectionContext, right: CurrentProjectionContext) {
  return left.userId === right.userId && left.intervalId === right.intervalId
    && left.ownershipRevision === right.ownershipRevision && left.profileId === right.profileId
    && left.instanceId === right.instanceId && left.row.id === right.row.id
}
function projectionSourcesEqual(left: ProjectionSourceRow, right: ProjectionSourceRow) {
  return Number(left.revision) === Number(right.revision)
    && Number(left.source_user_id) === Number(right.source_user_id)
    && left.source_interval_id === right.source_interval_id
    && String(left.source_ownership_revision) === String(right.source_ownership_revision)
    && left.source_profile_id === right.source_profile_id
    && left.source_instance_id === right.source_instance_id
    && String(left.source_connection_epoch) === String(right.source_connection_epoch)
    && Number(left.projection_revision) === Number(right.projection_revision)
}

async function writeProjectionProvenance(
  connection: PoolConnection,
  input: TrustedBridgeProjectionWrite,
  ownership: { intervalId: string; ownershipRevision: string },
) {
  const resource = input.projection.resource
  if (resource !== 'account.metrics' && resource !== 'positions' && resource !== 'pending_orders') return
  const observedAt = resource === 'account.metrics'
    ? input.projection.data.observedAt
    : 'observedAt' in input ? input.observedAt : null
  if (!observedAt) return
  await connection.execute(`INSERT INTO trading_projection_provenance_v4
    (trading_account_id,resource_kind,resource_id,user_id,ownership_interval_id,ownership_revision,
      terminal_profile_id,terminal_instance_id,connection_epoch,projection_revision,observed_at_utc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),ownership_interval_id=VALUES(ownership_interval_id),
      ownership_revision=VALUES(ownership_revision),terminal_profile_id=VALUES(terminal_profile_id),
      terminal_instance_id=VALUES(terminal_instance_id),connection_epoch=VALUES(connection_epoch),
      projection_revision=VALUES(projection_revision),observed_at_utc=VALUES(observed_at_utc)`, [
    input.projection.accountId, resource, input.projection.resourceId, input.route.userId, ownership.intervalId,
    ownership.ownershipRevision, input.route.terminalProfileId, input.route.terminalInstanceId,
    input.route.connectionEpoch, input.projection.revision, observedAt,
  ])
}
async function replaceCollection(connection: PoolConnection, table: 'open_position_snapshots' | 'pending_order_snapshots', accountId: string, revision: number, items: Array<OpenPosition | PendingOrder>) {
  await connection.execute(`DELETE FROM ${table} WHERE trading_account_id=?`, [accountId])
  for (const item of [...items].sort((a, b) => a.ticket.localeCompare(b.ticket))) await connection.execute(`INSERT INTO ${table} (trading_account_id,ticket,payload_json,revision,observed_at_utc) VALUES (?,?,?,?,UTC_TIMESTAMP(3))`, [accountId, item.ticket, JSON.stringify(item), revision])
}

async function lockProjectionRevision(connection: PoolConnection, input: TradingProjectionWrite) {
  await connection.execute('INSERT IGNORE INTO trading_projection_revisions (trading_account_id,resource_kind,resource_id,revision,updated_at_utc) VALUES (?,?,?,0,UTC_TIMESTAMP(3))', [input.accountId, input.resource, input.resourceId])
  const [rows] = await connection.execute<RevisionRow[]>('SELECT revision FROM trading_projection_revisions WHERE trading_account_id=? AND resource_kind=? AND resource_id=? FOR UPDATE', [input.accountId, input.resource, input.resourceId])
  return Number(rows[0]?.revision ?? 0) < input.revision
}

async function writeLockedProjection(connection: PoolConnection, input: TradingProjectionWrite) {
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
