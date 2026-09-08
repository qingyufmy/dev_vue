import type { Pool } from 'mysql2/promise'
import type { FastifyPluginAsync } from 'fastify'
import { RiskService } from './application/risk-service.js'
import { RiskReviewWorker } from './application/risk-review-worker.js'
import { MysqlRiskRepository } from './infrastructure/mysql-risk-repository.js'
import { riskRoutes, type RiskRoutesOptions } from './transport/http/risk-routes.js'

export function createRiskService(pool: Pool) { return new RiskService(new MysqlRiskRepository(pool)) }
export function createRiskReviewWorker(pool: Pool) { return new RiskReviewWorker(new MysqlRiskRepository(pool)) }
export function createRiskHttp(service: RiskService, auth: RiskRoutesOptions['auth']): FastifyPluginAsync {
  return async app => { await app.register(riskRoutes, { prefix: '/api/v4', service, auth }) }
}
