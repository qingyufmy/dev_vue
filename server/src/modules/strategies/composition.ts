export { createSubscriptionExecutionWindowReader } from './infrastructure/mysql-subscription-execution-window-reader.js'
export { createRuntimeStrategyAccess } from './infrastructure/mysql-runtime-strategy-access.js'
export { createStrategyExecutionConfigReader } from './infrastructure/mysql-strategy-execution-config-reader.js'
export { createAnalysisWindowReader } from './infrastructure/mysql-analysis-window-reader.js'
export { createAnalysisSubscriberReader } from './infrastructure/mysql-analysis-subscriber-reader.js'
import type { AnalysisScheduleStore } from './application/analysis-schedule-store.js'
import { MysqlAnalysisScheduleStore } from './infrastructure/mysql-analysis-schedule-store.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
export { createMysqlAnalysisStrategyAccess as createAnalysisStrategyAccess } from './infrastructure/mysql-analysis-strategy-access.js'
import type { SubscriptionPreferencesReader } from './application/subscription-preferences-reader.js'
import { readSubscriptionExecutionPreferences } from './infrastructure/mysql-subscription-execution-preferences.js'
import type { FastifyPluginAsync } from 'fastify'
import { StrategyService } from './application/strategy-service.js'
import { MysqlStrategyCatalog } from './infrastructure/mysql-strategy-catalog.js'
import { strategyRoutes, type StrategyRequestAuthenticator } from './transport/http/strategy-routes.js'
import { platformStrategyRoutes } from './transport/http/platform-strategy-routes.js'
import { createPlatformStrategyPublisher } from './infrastructure/mysql-platform-strategy-publisher.js'
import { createStrategyCombinationWriter } from './infrastructure/mysql-strategy-combination-writer.js'
import type { AdminPrincipalAccess } from '../auth/index.js'

export function createMysqlStrategyService(pool: Pool): StrategyService {
  return new StrategyService(new MysqlStrategyCatalog(pool))
}

export function createSubscriptionPreferencesReader(connection: PoolConnection): SubscriptionPreferencesReader {
  return { read: scope => readSubscriptionExecutionPreferences(connection, scope) }
}

export function createStrategyHttp(service: StrategyService, auth: StrategyRequestAuthenticator, platform?: { pool: Pool; administrators: (connection: PoolConnection) => AdminPrincipalAccess }): FastifyPluginAsync {
  return async app => { await app.register(strategyRoutes, { prefix: '/api/v4', service, auth, ...(platform ? {
    platformPublisher: createPlatformStrategyPublisher(platform.pool, platform.administrators),
    combinationWriter: createStrategyCombinationWriter(platform.pool, platform.administrators),
  } : {}) }) }
}

export function createPlatformStrategyHttp(pool: Pool, service: StrategyService,
  auth: Parameters<typeof platformStrategyRoutes>[1]['auth'], administrators: (connection: PoolConnection) => AdminPrincipalAccess): FastifyPluginAsync {
  return async app => { await app.register(platformStrategyRoutes, { prefix: '/api/v4', service, auth, publisher: createPlatformStrategyPublisher(pool, administrators) }) }
}

export function createMysqlAnalysisScheduleStore(pool: Pool): AnalysisScheduleStore {
  return new MysqlAnalysisScheduleStore(pool)
}
export { MysqlMarketStrategyAccess } from './infrastructure/mysql-market-strategy-access.js'
