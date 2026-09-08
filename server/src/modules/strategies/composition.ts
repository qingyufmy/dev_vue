import type { Pool } from 'mysql2/promise'
import type { FastifyPluginAsync } from 'fastify'
import { StrategyService } from './application/strategy-service.js'
import { MysqlStrategyCatalog } from './infrastructure/mysql-strategy-catalog.js'
import { strategyRoutes, type StrategyRequestAuthenticator } from './transport/http/strategy-routes.js'

export function createMysqlStrategyService(pool: Pool): StrategyService {
  return new StrategyService(new MysqlStrategyCatalog(pool))
}

export function createStrategyHttp(service: StrategyService, auth: StrategyRequestAuthenticator): FastifyPluginAsync {
  return async app => { await app.register(strategyRoutes, { prefix: '/api/v4', service, auth }) }
}
