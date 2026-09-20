import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { StrategyObserverInventoryReader } from '../application/strategy-observer-inventory-reader.js'
import type { StrategyObserverAccessReader } from '../application/observer-ports.js'
import type { AccountLiveRouteReader } from '../application/account-live-route-reader.js'
import type { TradingReadRepository } from '../application/trading-ports.js'
import type { OpenPosition, PendingOrder } from '../domain/trading.js'
import { isPositiveDatabaseId } from '../domain/account-access.js'
import { sha256Canonical } from '../../../shared/canonical-json.js'

interface SourceRow extends RowDataPacket { resource_kind: string; revision: string | number; observed_at: string }
interface ItemRow extends RowDataPacket { ticket: string; revision: string | number; payload_json: unknown }

export class MysqlStrategyObserverInventoryReader implements StrategyObserverInventoryReader {
  constructor(private readonly connection: Pick<PoolConnection, 'execute'>,
    private readonly access: StrategyObserverAccessReader,
    private readonly accounts: Pick<TradingReadRepository, 'findOwnedAccount'>,
    private readonly routes: AccountLiveRouteReader,
    private readonly now: () => Date = () => new Date()) {}

  async read(input: Parameters<StrategyObserverInventoryReader['read']>[0]) {
    const scope = { ...input }, asOf = Date.parse(scope.asOf), started = this.now().getTime()
    if (!Number.isFinite(asOf) || new Date(asOf).toISOString() !== scope.asOf
      || !Number.isFinite(started) || started < asOf || started - asOf > 30_000) return null
    const proof = await this.access.read(scope)
    if (!proof || proof.analysisStrategyId !== scope.analysisStrategyId || proof.authorization.userId !== scope.userId
      || proof.authorization.accountId !== scope.sourceAccountId) return null
    const authorization = structuredClone(proof.authorization)
    const account = await this.accounts.findOwnedAccount(authorization.operatorUserId, scope.sourceAccountId)
    const current = await this.routes.current(scope.sourceAccountId)
    if (!account || !current) return null
    const route = structuredClone(current)
    if (account.id !== scope.sourceAccountId || account.bridgeState === 'paused'
      || route.accountId !== account.id || route.userId !== authorization.operatorUserId || route.platform !== account.platform
      || route.brokerServer !== account.server || route.login !== account.login
      || !route.terminalProfileId || route.terminalProfileId !== account.terminalProfileId
      || !route.terminalInstanceId || route.terminalInstanceId !== account.terminalInstanceId
      || !route.connectionId || !Number.isSafeInteger(route.connectionEpoch) || route.connectionEpoch < 1) return null
    const [sources] = await this.connection.execute<SourceRow[]>(`SELECT pr.resource_kind,pr.revision,
      DATE_FORMAT(pp.observed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') observed_at
      FROM trading_projection_revisions pr INNER JOIN trading_projection_provenance_v4 pp
        ON pp.trading_account_id=pr.trading_account_id AND pp.resource_kind=pr.resource_kind
        AND pp.resource_id=pr.resource_id AND pp.projection_revision=pr.revision
      INNER JOIN trading_account_ownerships o ON o.trading_account_id=pp.trading_account_id
        AND o.user_id=pp.user_id AND o.interval_id=pp.ownership_interval_id AND o.revision=pp.ownership_revision
        AND o.role='owner' AND o.revoked_at_utc IS NULL
      WHERE pr.trading_account_id=? AND pr.resource_id='open' AND pr.resource_kind IN ('positions','pending_orders')
        AND pp.user_id=? AND pp.ownership_revision=? AND pp.terminal_profile_id=? AND pp.terminal_instance_id=? AND pp.connection_epoch=?
        AND EXISTS (SELECT 1 FROM bridge_connection_sessions s WHERE s.user_id=pp.user_id
          AND s.trading_account_id=pp.trading_account_id AND s.terminal_profile_id=pp.terminal_profile_id
          AND s.terminal_instance_id=pp.terminal_instance_id AND s.connection_epoch_v4=pp.connection_epoch
          AND s.connection_epoch=? AND s.disconnected_at_utc IS NULL
          AND s.last_seen_at_utc>=UTC_TIMESTAMP(3)-INTERVAL 45 SECOND)`,
    [scope.sourceAccountId, authorization.operatorUserId, authorization.ownershipRevision, route.terminalProfileId,
      route.terminalInstanceId, route.connectionEpoch, `v4:${route.connectionId}`])
    if (sources.length !== 2) return null
    const positionsSource = sources.find(row => row.resource_kind === 'positions')
    const pendingSource = sources.find(row => row.resource_kind === 'pending_orders')
    if (!positionsSource || !pendingSource) return null
    const observed = sources.map(row => typeof row.observed_at === 'string' && /\.\d{3}000Z$/.test(row.observed_at)
      ? Date.parse(row.observed_at.replace(/(\.\d{3})000Z$/, '$1Z')) : NaN)
    if (observed.some(value => !Number.isFinite(value) || value > asOf || started - value > 30_000)
      || sources.some(row => !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1)) return null
    const positions = await this.collection<OpenPosition>('open_position_snapshots', scope.sourceAccountId, Number(positionsSource.revision))
    const pendingOrders = await this.collection<PendingOrder>('pending_order_snapshots', scope.sourceAccountId, Number(pendingSource.revision))
    if (!positions || !pendingOrders) return null
    const latestRoute = await this.routes.current(scope.sourceAccountId), completed = this.now().getTime()
    if (!latestRoute || sha256Canonical(latestRoute) !== sha256Canonical(route) || !Number.isFinite(completed)
      || completed < started || completed - Math.min(...observed) > 30_000
      || !Number.isFinite(Date.parse(authorization.expiresAtUtc)) || Date.parse(authorization.expiresAtUtc) <= completed) return null
    return { analysisStrategyId: scope.analysisStrategyId, authorization, route,
      observedAt: new Date(Math.min(...observed)).toISOString(),
      positions: { revision: Number(positionsSource.revision), observedAt: new Date(observed[sources.indexOf(positionsSource)]!).toISOString(), items: positions },
      pendingOrders: { revision: Number(pendingSource.revision), items: pendingOrders } }
  }

  private async collection<T extends OpenPosition | PendingOrder>(table: 'open_position_snapshots' | 'pending_order_snapshots', accountId: string, revision: number): Promise<T[] | null> {
    const [rows] = await this.connection.execute<ItemRow[]>(`SELECT CAST(ticket AS CHAR) ticket,revision,payload_json FROM ${table}
      WHERE trading_account_id=? ORDER BY ticket LIMIT 1001`, [accountId])
    if (rows.length > 1000) return null
    const result: T[] = [], tickets = new Set<string>()
    for (const row of rows) {
      if (Number(row.revision) !== revision || !isPositiveDatabaseId(row.ticket) || tickets.has(row.ticket)) return null
      let value: T
      try { value = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : structuredClone(row.payload_json) } catch { return null }
      if (!value || value.accountId !== accountId || value.ticket !== row.ticket || value.revision !== revision
        || typeof value.symbol !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.symbol)) return null
      if (table === 'open_position_snapshots' && 'positionIdentifier' in value
        && value.positionIdentifier !== null && !isPositiveDatabaseId(value.positionIdentifier)) return null
      tickets.add(row.ticket); result.push(value)
    }
    return result
  }
}
