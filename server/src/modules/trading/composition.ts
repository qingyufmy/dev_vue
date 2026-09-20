import { TerminalMarketService, type TerminalChanChartCalculator } from './application/terminal-market-service.js'
import { MysqlMarketHistoryWriter } from './infrastructure/mysql-market-history-writer.js'
export function createMarketHistoryIO(pool: Pool, cache: Redis, accounts: Pick<TradingReadRepository, 'findOwnedAccount'>) {
  const reader = new TerminalMarketService({ ownedAccount: async (userId, accountId) => {
    const account = await accounts.findOwnedAccount(userId, accountId)
    if (!account) throw new Error('market_history_account_unavailable')
    return account
  } }, new RedisTerminalMarketReader(cache))
  const writer = new MysqlMarketHistoryWriter(pool)
  return { read: reader.resolvedCandles.bind(reader), write: writer.write.bind(writer) }
}
import { RedisTerminalMarketReader } from './infrastructure/redis-terminal-market-reader.js'
import { terminalMarketRoutes } from './transport/http/terminal-market-routes.js'
import { RedisMarketDemandPublisher } from './infrastructure/redis-market-demand-publisher.js'
import { BROWSER_REALTIME_EVENT_CHANNEL } from './application/browser-realtime-protocol.js'
import type { BrowserRealtimeEvent } from './application/trading-ports.js'
export function createPublicMarketEventTransport(listener: Redis, publisher: Redis, receive: (event: BrowserRealtimeEvent) => void, failed: (code: string) => void) {
  const subscriber = new RedisBrowserRealtimeSubscriber(listener, { publish: receive, invalidateObserverAuthorization() {} }, undefined, failed)
  return { start: () => subscriber.start(), close: () => subscriber.close(),
    publish: (event: BrowserRealtimeEvent) => publisher.publish(BROWSER_REALTIME_EVENT_CHANNEL, JSON.stringify(event)) }
}
export function createMarketStreamDemands(cache: Redis, failed: (code: string) => void) {
  return new RedisMarketDemandPublisher(cache, failed)
}
import type { AnalysisStrategyAccess } from '../strategies/index.js'
export { createAccountInventorySummaryReader } from './infrastructure/mysql-account-inventory-summary-reader.js'
export { createMysqlOwnedHistoryAccess } from './infrastructure/mysql-owned-history-access.js'
import { MysqlObserverAccessReader } from './infrastructure/mysql-observer-access-reader.js'
import { MysqlStrategyObserverInventoryReader } from './infrastructure/mysql-strategy-observer-inventory-reader.js'
import type { ActivePrincipalAccess, AccountPrincipalReader, AdminPrincipalAccess } from '../auth/index.js'
import type { ContextWritePort } from './application/context-write-port.js'
import { assertMysqlTradingSchemaReady } from './infrastructure/mysql-schema-readiness.js'
import { createMysqlContextWritePort } from './infrastructure/mysql-context-write-port.js'
import type { BrowserRealtimePublication, BrowserRealtimeSessions } from './application/browser-realtime-ports.js'
import { BrowserRealtimeSession } from './transport/realtime/browser-realtime-session.js'
import type { AccountClockReader } from './application/account-clock-reader.js'
import type { AccountLiveRouteReader } from './application/account-live-route-reader.js'
import { readTransactionAccountClock } from './infrastructure/mysql-transaction-account-clock.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { Redis } from 'ioredis'
import type { FastifyPluginAsync } from 'fastify'
import { tradingRoutes } from './transport/http/trading-routes.js'
import { observerManagementRoutes } from './transport/http/observer-management-routes.js'
import type { AccountRegistration } from './application/account-registration.js'
import type { ConnectionCapacityRepository, TradingReadRepository, PublicCachedMarketReader } from './application/trading-ports.js'
import type { TradeSessionAuthenticator, ObserverManagementRequestAuthenticator } from './application/request-authentication.js'
import { PositionListService } from './application/position-list-service.js'
import { positionListRoutes } from './transport/http/position-list-routes.js'
import { TradingService, ConnectionCapacityService } from './application/trading-service.js'
import { ObserverManagementService } from './application/observer-management-service.js'
import { ObserverPublicationService } from './application/observer-publication-service.js'
import { BridgeStreamProjector } from './application/bridge-stream-projector.js'
import type { BridgeProjectionPort } from './application/bridge-projection-port.js'
import type { ProjectionReservationAbsorber } from './application/projection-reservation-absorber.js'
import { MysqlAccountRegistration } from './infrastructure/mysql-account-registration.js'
import { MysqlTradingRepository, readExecutionPendingSnapshot } from './infrastructure/mysql-trading-repository.js'
import { MysqlObserverSnapshotReader } from './infrastructure/mysql-observer-snapshot-reader.js'
import { MysqlObserverManagementRepository } from './infrastructure/mysql-observer-management-repository.js'
import { RedisConnectionLeaseStore } from './infrastructure/redis-connection-lease-store.js'
import { RedisBrowserRealtimePublisher } from './infrastructure/redis-browser-realtime-publisher.js'
import { RedisBrowserRealtimeSubscriber } from './infrastructure/redis-browser-realtime-subscriber.js'
import { BrowserRealtimeHub } from './transport/realtime/browser-realtime-hub.js'

type GatewayLeases = AccountLiveRouteReader & { count?(userId: number): Promise<number> }

export const assertTradingSchemaReady = assertMysqlTradingSchemaReady

export function createTradingHttp(service: TradingService, capacity: ConnectionCapacityService, auth: TradeSessionAuthenticator, contextCommands: ContextWritePort, terminalMarket?: TerminalMarketService): FastifyPluginAsync {
  return async app => {
    await app.register(tradingRoutes, { prefix: '/api/v4', service, capacity, auth, contextCommands })
    if (terminalMarket) await app.register(terminalMarketRoutes, { prefix: '/api/v4', service: terminalMarket, auth })
    await app.register(positionListRoutes, { prefix: '/api/v4', service: new PositionListService(service), auth })
  }
}

export function createObserverManagementHttp(service: ObserverManagementService, auth: ObserverManagementRequestAuthenticator): FastifyPluginAsync {
  return async app => { await app.register(observerManagementRoutes, { prefix: '/api/v4/admin/observer', service, auth }) }
}

export function createTradingContextWriter(pool: Pool, leases: GatewayLeases, principalAccess: (connection: PoolConnection) => ActivePrincipalAccess, principals: (connection: PoolConnection) => AccountPrincipalReader): ContextWritePort {
  return createMysqlContextWritePort(pool, leases, principalAccess, principals)
}

export function createTradingReader(pool: Pool, leases: GatewayLeases | undefined, principals: (connection: PoolConnection) => AccountPrincipalReader): TradingReadRepository & PublicCachedMarketReader {
  return new MysqlTradingRepository(pool, leases, new MysqlObserverSnapshotReader(pool, principals))
}

export function createTradingApiModule(pool: Pool, cache: Redis, auth: { trade: TradeSessionAuthenticator; admin: ObserverManagementRequestAuthenticator }, leases: GatewayLeases, principalAccess: (connection: PoolConnection) => ActivePrincipalAccess, principals: (connection: PoolConnection) => AccountPrincipalReader, administrators: (executor: Pick<PoolConnection, 'execute'>) => AdminPrincipalAccess, strategyAccess: (connection: PoolConnection) => AnalysisStrategyAccess, chanChart?: TerminalChanChartCalculator): {
  trading: TradingService
  connectionCapacity: ConnectionCapacityService
  observerManagement: ObserverManagementService
  tradeHttp: FastifyPluginAsync
  observerHttp: FastifyPluginAsync
  tradeAuth: TradeSessionAuthenticator
  observerAdminAuth: ObserverManagementRequestAuthenticator
} {
  const access = new MysqlObserverSnapshotReader(pool, principals)
  const repository = new MysqlTradingRepository(pool, leases, access)
  const trading = new TradingService(repository, new ObserverPublicationService(access, repository))
  const connectionCapacity = new ConnectionCapacityService(repository, new RedisConnectionLeaseStore(cache), {
    count: userId => {
      if (!leases.count) throw new Error('bridge_capacity_reader_unavailable')
      return leases.count(userId)
    },
  })
  const observerManagement = new ObserverManagementService(new MysqlObserverManagementRepository(pool, administrators, principalAccess, strategyAccess))
  const tradeAuth = auth.trade
  const observerAdminAuth = auth.admin
  return { trading, connectionCapacity, observerManagement, tradeAuth, observerAdminAuth,
    tradeHttp: createTradingHttp(trading, connectionCapacity, tradeAuth, createTradingContextWriter(pool, leases, principalAccess, principals), new TerminalMarketService(trading, new RedisTerminalMarketReader(cache), chanChart)),
    observerHttp: createObserverManagementHttp(observerManagement, observerAdminAuth),
  }
}

export function createBridgeTradingModule(pool: Pool, cache: Redis, leases: GatewayLeases, onPublishError: (error: unknown) => void,
  reservationAbsorber: (connection: PoolConnection) => ProjectionReservationAbsorber): {
  capacity: ConnectionCapacityRepository
  projector: BridgeProjectionPort
} {
  const repository = new MysqlTradingRepository(pool, leases, undefined, reservationAbsorber)
  return { capacity: repository, projector: new BridgeStreamProjector(repository, new RedisBrowserRealtimePublisher(cache, undefined, onPublishError)) }
}

export function createBrowserTradingModule(pool: Pool, leases: GatewayLeases, eventCache: Redis, onEvent: () => void, onInvalidEvent: (code: string) => void, principals: (connection: PoolConnection) => AccountPrincipalReader, marketCache?: Redis): {
  hub: BrowserRealtimePublication
  sessions: BrowserRealtimeSessions
  events: Pick<RedisBrowserRealtimeSubscriber, 'start' | 'close'>
} {
  const access = new MysqlObserverSnapshotReader(pool, principals)
  const hub = new BrowserRealtimeHub(new MysqlTradingRepository(pool, leases, access), access, Date.now, marketCache ? new RedisMarketDemandPublisher(marketCache, onInvalidEvent) : undefined)
  const events = new RedisBrowserRealtimeSubscriber(eventCache, {
    publish(event) { hub.publish(event); onEvent() },
    invalidateObserverAuthorization(control) { hub.invalidateObserverAuthorization(control); onEvent() },
  }, undefined, onInvalidEvent)
  return { hub, events, sessions: createBrowserRealtimeSessions(hub) }
}

export function createAccountRegistration(connection: PoolConnection, principals: ActivePrincipalAccess): AccountRegistration {
  return new MysqlAccountRegistration(connection, principals)
}

export function createTransactionAccountClock(connection: PoolConnection): AccountClockReader {
  return { read: (userId, accountId) => readTransactionAccountClock(connection, userId, accountId) }
}

export function createBrowserRealtimeSessions(hub: BrowserRealtimeHub): BrowserRealtimeSessions {
  return { open: (userId, sink) => new BrowserRealtimeSession(userId, hub, sink) }
}


/** Caller owns an existing consistent read snapshot; never open a nested pool transaction. */
export function createTransactionTradingReader(connection: PoolConnection, principals: (connection: PoolConnection) => AccountPrincipalReader): TradingReadRepository & PublicCachedMarketReader {
  return new MysqlTradingRepository(connection as unknown as Pool, null, new MysqlObserverAccessReader(connection, principals(connection)))
}

/** The caller must hold the same consistent read snapshot for source access and inventory. */
export function createTransactionStrategyObserverAccessReader(connection: PoolConnection,
  principals: (connection: PoolConnection) => AccountPrincipalReader): import('./application/observer-ports.js').StrategyObserverAccessReader {
  const access = new MysqlObserverAccessReader(connection, principals(connection))
  return { read: scope => access.authorizeStrategySource(scope) }
}

export function createTransactionStrategyObserverInventoryReader(connection: PoolConnection,
  principals: (connection: PoolConnection) => AccountPrincipalReader,
  routes: import('./application/account-live-route-reader.js').AccountLiveRouteReader): import('./application/strategy-observer-inventory-reader.js').StrategyObserverInventoryReader {
  return new MysqlStrategyObserverInventoryReader(connection, createTransactionStrategyObserverAccessReader(connection, principals),
    createTransactionTradingReader(connection, principals), routes)
}

export function createTransactionPendingReader(connection: PoolConnection): import('./application/execution-pending-reader.js').ExecutionPendingReader {
  return { read: input => readExecutionPendingSnapshot(connection, input) }
}
export { createMysqlInstrumentSnapshotReader } from './infrastructure/mysql-instrument-snapshot-reader.js'
import type { InstrumentProjectionWriter } from './application/instrument-projection-writer.js'
import { writeInstrumentProjection } from './infrastructure/mysql-trading-repository.js'
export function createInstrumentProjectionWriter(pool: Pool): InstrumentProjectionWriter {
  return { write: input => writeInstrumentProjection(pool, input) }
}
export { createMysqlInstrumentCollectionRequester } from './infrastructure/mysql-instrument-collection-requester.js'
export { createMysqlInstrumentCollectionTasks } from './infrastructure/mysql-instrument-collection-tasks.js'
export { createMysqlInstrumentCollectionRecovery } from './infrastructure/mysql-instrument-collection-recovery.js'
export { assertMysqlInstrumentCollectionSchemaReady } from './infrastructure/mysql-schema-readiness.js'
import { assertTerminalFactRoute } from './infrastructure/mysql-trading-repository.js'
export function createTransactionTerminalFactRouteGuard(connection: import('mysql2/promise').PoolConnection): import('./application/terminal-fact-route-guard.js').TerminalFactRouteGuard {
  return { assert: route => assertTerminalFactRoute(connection, route) }
}

export { createMysqlExecutionPositionReader } from './infrastructure/mysql-execution-position-reader.js'

export { createMysqlExecutionPositionCollectionReader } from './infrastructure/mysql-execution-position-collection-reader.js'

export { createMysqlExecutionAccountReader } from './infrastructure/mysql-execution-account-reader.js'

export { createMysqlQuoteProvenanceWriter, assertMysqlQuoteProvenanceCapability } from './infrastructure/mysql-quote-provenance-writer.js'

export { assertMysqlQuoteProvenanceSchemaReady } from './infrastructure/mysql-schema-readiness.js'

export { createMysqlExecutionQuoteReader } from './infrastructure/mysql-execution-quote-reader.js'

export { createMysqlExecutionInstrumentReader } from './infrastructure/mysql-execution-instrument-reader.js'
export { createMysqlHistoricalClockReader } from './infrastructure/mysql-historical-clock-reader.js'
export { createMysqlRiskAccountReader } from './infrastructure/mysql-risk-account-reader.js'
export { createMysqlOwnedPeriodAccount } from './infrastructure/mysql-owned-period-account.js'
export { createMysqlPeriodDiscoveryAccounts } from './infrastructure/mysql-period-discovery-accounts.js'
import { BridgeMarketSourceCandidates } from './infrastructure/bridge-market-source-candidates.js'
export function createBridgeMarketSourceCandidates(accounts: TradingReadRepository, providers: { list(): Promise<number[]> },
  routes: ConstructorParameters<typeof BridgeMarketSourceCandidates>[2], cache: Redis) {
  return new BridgeMarketSourceCandidates(accounts, providers, routes, new RedisTerminalMarketReader(cache))
}
