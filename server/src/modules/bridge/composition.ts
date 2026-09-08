import type { Pool, PoolConnection } from 'mysql2/promise'
import { MysqlBridgeDeviceRevoker } from './infrastructure/mysql-bridge-device-revoker.js'
import { MysqlBridgeGatewayRouteRepository } from './infrastructure/mysql-bridge-gateway-route-repository.js'
import type { BridgeAccountRegistration } from './application/bridge-account-registration.js'
import type { Redis } from 'ioredis'
import type { FastifyPluginAsync } from 'fastify'
import { bridgeCredentialRoutes } from './transport/http/bridge-credential-routes.js'
import { bridgePairingRoutes, type BridgePairingRoutesOptions } from './transport/http/bridge-pairing-routes.js'
import type { BridgeCredentialService } from './application/bridge-credential-service.js'
import type { BridgePairingService } from './application/bridge-pairing-service.js'
import type { BridgeCredentialRepository, BridgeSessionTicketStore } from './application/bridge-credential-ports.js'
import type { BridgePairingRepository } from './application/bridge-pairing-service.js'
import type { BridgeGatewayLeaseStore } from './application/bridge-gateway-ports.js'
import { MysqlBridgeCredentialRepository } from './infrastructure/mysql-bridge-credential-repository.js'
import { MysqlBridgePairingRepository } from './infrastructure/mysql-bridge-pairing-repository.js'
import { RedisBridgeSessionTicketStore } from './infrastructure/redis-bridge-session-ticket-store.js'
import { RedisBridgeGatewayLeaseStore } from './infrastructure/redis-bridge-gateway-lease-store.js'

export function createBridgeCredentialRepository(pool: Pool): BridgeCredentialRepository {
  return new MysqlBridgeCredentialRepository(pool)
}

export function createBridgePairingRepository(pool: Pool): BridgePairingRepository {
  return new MysqlBridgePairingRepository(pool)
}

export function createBridgeSessionTickets(cache: Redis): BridgeSessionTicketStore {
  return new RedisBridgeSessionTicketStore(cache)
}

export function createBridgeGatewayLeases(cache: Redis): BridgeGatewayLeaseStore {
  return new RedisBridgeGatewayLeaseStore(cache)
}

export function createBridgeHttp(credentials: BridgeCredentialService, pairing: BridgePairingService,
  auth: BridgePairingRoutesOptions['auth']): FastifyPluginAsync {
  return async app => {
    await app.register(bridgeCredentialRoutes, { prefix: '/api/v4', service: credentials })
    await app.register(bridgePairingRoutes, { prefix: '/api/v4', service: pairing, auth })
  }
}

// Runtime assembly only; business consumers receive their required port by injection.
export function createBridgeDeviceRevoker(pool: Pool) {
  return new MysqlBridgeDeviceRevoker(pool)
}

export function createBridgeGatewayRoutes(pool: Pool, accountRegistrationForTransaction: (connection: PoolConnection) => BridgeAccountRegistration) {
  return new MysqlBridgeGatewayRouteRepository(pool, accountRegistrationForTransaction)
}
