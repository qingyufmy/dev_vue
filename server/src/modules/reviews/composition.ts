import type { Pool } from 'mysql2/promise'
import type { FastifyPluginAsync } from 'fastify'
import { ReviewService } from './application/review-service.js'
import { ReviewWorker, type ReviewModelGatewayResolver } from './application/review-worker.js'
import { MysqlReviewRepository } from './infrastructure/mysql-review-repository.js'
import { reviewRoutes, type ReviewRequestAuthenticator } from './transport/http/review-routes.js'

export function createReviewHttp(service: ReviewService, auth: ReviewRequestAuthenticator): FastifyPluginAsync {
  return async app => { await app.register(reviewRoutes, { prefix: '/api/v4', service, auth }) }
}

export function createMysqlReviewHttp(pool: Pool, auth: ReviewRequestAuthenticator): FastifyPluginAsync {
  return createReviewHttp(new ReviewService(new MysqlReviewRepository(pool)), auth)
}

export function createMysqlReviewWorker(pool: Pool, models: ReviewModelGatewayResolver, workerId: string): Pick<ReviewWorker, 'process'> {
  return new ReviewWorker(new MysqlReviewRepository(pool), models, workerId)
}
