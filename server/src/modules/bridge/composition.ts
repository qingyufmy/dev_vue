import type { Pool } from 'mysql2/promise'
import { MysqlBridgeDeviceRevoker } from './infrastructure/mysql-bridge-device-revoker.js'

// Runtime assembly only; business consumers receive their required port by injection.
export function createBridgeDeviceRevoker(pool: Pool) {
  return new MysqlBridgeDeviceRevoker(pool)
}
