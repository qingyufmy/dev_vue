import { MysqlObserverAccessReader } from './infrastructure/mysql-observer-access-reader.js'
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
import type { ConnectionCapacityRepository, TradingReadRepository } from './application/trading-ports.js'
import type { TradeSessionAuthenticator, ObserverManagementRequestAuthenticator } from './application/request-authentication.js'
import { TradingService, ConnectionCapacityService } from './application/trading-service.js'
import { ObserverManagementService } from './application/observer-management-service.js'
import { ObserverPublicationService } from './application/observer-publication-service.js'
import { BridgeStreamProjector } from './application/bridge-stream-projector.js'
import type { BridgeProjectionPort } from './application/bridge-projection-port.js'
import type { ProjectionReservationAbsorber } from './application/projection-reservation-absorber.js'
import { MysqlAccountRegistration } from './infrastructure/mysql-account-registration.js'
import { MysqlTradingRepository } from './infrastructure/mysql-trading-repository.js'
import { MysqlObserverSnapshotReader } from './infrastructure/mysql-observer-snapshot-reader.js'
import { MysqlObserverManagementRepository } from './infrastructure/mysql-observer-management-repository.js'
import { RedisConnectionLeaseStore } from './infrastructure/redis-connection-lease-store.js'
import { RedisBrowserRealtimePublisher } from './infrastructure/redis-browser-realtime-publisher.js'
import { RedisBrowserRealtimeSubscriber } from './infrastructure/redis-browser-realtime-subscriber.js'
import { BrowserRealtimeHub } from './transport/realtime/browser-realtime-hub.js'

type GatewayLeases = AccountLiveRouteReader

export const assertTradingSchemaReady = assertMysqlTradingSchemaReady

export function createTradingHttp(service: TradingService, capacity: ConnectionCapacityService, auth: TradeSessionAuthenticator, contextCommands: ContextWritePort): FastifyPluginAsync {
  return async app => { await app.register(tradingRoutes, { prefix: '/api/v4', service, capacity, auth, contextCommands }) }
}

export function createObserverManagementHttp(service: ObserverManagementService, auth: ObserverManagementRequestAuthenticator): FastifyPluginAsync {
  return async app => { await app.register(observerManagementRoutes, { prefix: '/api/v4/admin/observer', service, auth }) }
}

export function createTradingContextWriter(pool: Pool, leases: GatewayLeases, principalAccess: (connection: PoolConnection) => ActivePrincipalAccess, principals: (connection: PoolConnection) => AccountPrincipalReader): ContextWritePort {
  return createMysqlContextWritePort(pool, leases, principalAccess, principals)
}

export function createTradingReader(pool: Pool, leases: GatewayLeases | undefined, principals: (connection: PoolConnection) => AccountPrincipalReader): TradingReadRepository {
  return new MysqlTradingRepository(pool, leases, new MysqlObserverSnapshotReader(pool, principals))
}

export function createTradingApiModule(pool: Pool, cache: Redis, auth: { trade: TradeSessionAuthenticator; admin: ObserverManagementRequestAuthenticator }, leases: GatewayLeases, principalAccess: (connection: PoolConnection) => ActivePrincipalAccess, principals: (connection: PoolConnection) => AccountPrincipalReader, administrators: (executor: Pick<PoolConnection, 'execute'>) => AdminPrincipalAccess): {
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
  const connectionCapacity = new ConnectionCapacityService(repository, new RedisConnectionLeaseStore(cache))
  const observerManagement = new ObserverManagementService(new MysqlObserverManagementRepository(pool, administrators, principalAccess))
  const tradeAuth = auth.trade
  const observerAdminAuth = auth.admin
  return { trading, connectionCapacity, observerManagement, tradeAuth, observerAdminAuth,
    tradeHttp: createTradingHttp(trading, connectionCapacity, tradeAuth, createTradingContextWriter(pool, leases, principalAccess, principals)),
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

export function createBrowserTradingModule(pool: Pool, leases: GatewayLeases, eventCache: Redis, onEvent: () => void, onInvalidEvent: (code: string) => void, principals: (connection: PoolConnection) => AccountPrincipalReader): {
  hub: BrowserRealtimePublication
  sessions: BrowserRealtimeSessions
  events: Pick<RedisBrowserRealtimeSubscriber, 'start' | 'close'>
} {
  const access = new MysqlObserverSnapshotReader(pool, principals)
  const hub = new BrowserRealtimeHub(new MysqlTradingRepository(pool, leases, access), access)
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
export function createTransactionTradingReader(connection: PoolConnection, principals: (connection: PoolConnection) => AccountPrincipalReader): TradingReadRepository {
  return new MysqlTradingRepository(connection as unknown as Pool, null, new MysqlObserverAccessReader(connection, principals(connection)))
}
