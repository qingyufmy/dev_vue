import type { Pool, PoolConnection } from 'mysql2/promise'
import { MysqlBridgeDeviceRevoker } from './infrastructure/mysql-bridge-device-revoker.js'
import { MysqlBridgeGatewayRouteRepository } from './infrastructure/mysql-bridge-gateway-route-repository.js'
import type { BridgeAccountRegistration } from './application/bridge-account-registration.js'

// Runtime assembly only; business consumers receive their required port by injection.
export function createBridgeDeviceRevoker(pool: Pool) {
  return new MysqlBridgeDeviceRevoker(pool)
}

export function createBridgeGatewayRoutes(pool: Pool, accountRegistrationForTransaction: (connection: PoolConnection) => BridgeAccountRegistration) {
  return new MysqlBridgeGatewayRouteRepository(pool, accountRegistrationForTransaction)
}
