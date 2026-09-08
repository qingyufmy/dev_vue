import type { BrowserRealtimePublication, BrowserRealtimeSessions } from './application/browser-realtime-ports.js'
import { BrowserRealtimeSession } from './transport/realtime/browser-realtime-session.js'
import type { AccountClockReader } from './application/account-clock-reader.js'
import { readTransactionAccountClock } from './infrastructure/mysql-transaction-account-clock.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { Redis } from 'ioredis'
import type { FastifyPluginAsync } from 'fastify'
import { tradingRoutes } from './transport/http/trading-routes.js'
import { observerManagementRoutes } from './transport/http/observer-management-routes.js'
import type { AuthService } from '../auth/index.js'
import type { AccountRegistration } from './application/account-registration.js'
import type { ConnectionCapacityRepository, TradingReadRepository } from './application/trading-ports.js'
import type { TradeSessionAuthenticator, ObserverManagementRequestAuthenticator } from './application/request-authentication.js'
import { TradingService, ConnectionCapacityService } from './application/trading-service.js'
import { ObserverManagementService } from './application/observer-management-service.js'
import { ObserverPublicationService } from './application/observer-publication-service.js'
import { BridgeStreamProjector } from './application/bridge-stream-projector.js'
import { MysqlAccountRegistration } from './infrastructure/mysql-account-registration.js'
import { MysqlTradingRepository } from './infrastructure/mysql-trading-repository.js'
import { MysqlObserverAccessReader } from './infrastructure/mysql-observer-access-reader.js'
import { MysqlObserverManagementRepository } from './infrastructure/mysql-observer-management-repository.js'
import { AuthTradeRequestAdapter } from './infrastructure/auth-trade-request-adapter.js'
import { AuthObserverAdminAdapter } from './infrastructure/auth-observer-admin-adapter.js'
import { RedisConnectionLeaseStore } from './infrastructure/redis-connection-lease-store.js'
import { RedisBrowserRealtimePublisher } from './infrastructure/redis-browser-realtime-publisher.js'
import { RedisBrowserRealtimeSubscriber } from './infrastructure/redis-browser-realtime-subscriber.js'
import { BrowserRealtimeHub } from './transport/realtime/browser-realtime-hub.js'

type GatewayLeases = NonNullable<ConstructorParameters<typeof MysqlTradingRepository>[1]>

export function createTradingHttp(service: TradingService, capacity: ConnectionCapacityService, auth: TradeSessionAuthenticator): FastifyPluginAsync {
  return async app => { await app.register(tradingRoutes, { prefix: '/api/v4', service, capacity, auth }) }
}

export function createObserverManagementHttp(service: ObserverManagementService, auth: ObserverManagementRequestAuthenticator): FastifyPluginAsync {
  return async app => { await app.register(observerManagementRoutes, { prefix: '/api/v4/admin/observer', service, auth }) }
}

export function createTradingReader(pool: Pool, leases?: GatewayLeases): TradingReadRepository {
  return new MysqlTradingRepository(pool, leases)
}

export function createTradingApiModule(pool: Pool, cache: Redis, auth: AuthService, leases: GatewayLeases): {
  trading: TradingService
  connectionCapacity: ConnectionCapacityService
  observerManagement: ObserverManagementService
  tradeHttp: FastifyPluginAsync
  observerHttp: FastifyPluginAsync
  tradeAuth: TradeSessionAuthenticator
  observerAdminAuth: ObserverManagementRequestAuthenticator
} {
  const access = new MysqlObserverAccessReader(pool)
  const repository = new MysqlTradingRepository(pool, leases, access)
  const trading = new TradingService(repository, new ObserverPublicationService(access, repository))
  const connectionCapacity = new ConnectionCapacityService(repository, new RedisConnectionLeaseStore(cache))
  const observerManagement = new ObserverManagementService(new MysqlObserverManagementRepository(pool))
  const tradeAuth = new AuthTradeRequestAdapter(auth)
  const observerAdminAuth = new AuthObserverAdminAdapter(auth)
  return { trading, connectionCapacity, observerManagement, tradeAuth, observerAdminAuth,
    tradeHttp: createTradingHttp(trading, connectionCapacity, tradeAuth),
    observerHttp: createObserverManagementHttp(observerManagement, observerAdminAuth),
  }
}

export function createBridgeTradingModule(pool: Pool, cache: Redis, leases: GatewayLeases, onPublishError: (error: unknown) => void): {
  capacity: ConnectionCapacityRepository
  projector: BridgeStreamProjector
} {
  const repository = new MysqlTradingRepository(pool, leases)
  return { capacity: repository, projector: new BridgeStreamProjector(repository, new RedisBrowserRealtimePublisher(cache, undefined, onPublishError)) }
}

export function createBrowserTradingModule(pool: Pool, leases: GatewayLeases, eventCache: Redis, onEvent: () => void, onInvalidEvent: (code: string) => void): {
  hub: BrowserRealtimePublication
  sessions: BrowserRealtimeSessions
  events: Pick<RedisBrowserRealtimeSubscriber, 'start' | 'close'>
} {
  const access = new MysqlObserverAccessReader(pool)
  const hub = new BrowserRealtimeHub(new MysqlTradingRepository(pool, leases, access), access)
  const events = new RedisBrowserRealtimeSubscriber(eventCache, {
    publish(event) { hub.publish(event); onEvent() },
    invalidateObserverAuthorization(control) { hub.invalidateObserverAuthorization(control); onEvent() },
  }, undefined, onInvalidEvent)
  return { hub, events, sessions: createBrowserRealtimeSessions(hub) }
}

export function createAccountRegistration(connection: PoolConnection): AccountRegistration {
  return new MysqlAccountRegistration(connection)
}

export function createTransactionAccountClock(connection: PoolConnection): AccountClockReader {
  return { read: (userId, accountId) => readTransactionAccountClock(connection, userId, accountId) }
}

export function createBrowserRealtimeSessions(hub: BrowserRealtimeHub): BrowserRealtimeSessions {
  return { open: (userId, sink) => new BrowserRealtimeSession(userId, hub, sink) }
}
