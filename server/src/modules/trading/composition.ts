import type { PoolConnection } from 'mysql2/promise'
import type { AccountRegistration } from './application/account-registration.js'
import { MysqlAccountRegistration } from './infrastructure/mysql-account-registration.js'

export function createAccountRegistration(connection: PoolConnection): AccountRegistration {
  return new MysqlAccountRegistration(connection)
}
