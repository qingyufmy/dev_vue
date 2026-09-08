import type { FastifyPluginAsync } from 'fastify'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { AuthService } from '../auth/index.js'
import type { LearningMembershipReader } from './domain/learning.js'
import { LearningService } from './application/learning-service.js'
import { LearningCompletionService } from './application/learning-completion-service.js'
import { MysqlLearningReader } from './infrastructure/mysql-learning-reader.js'
import { MysqlLearningCompletion } from './infrastructure/mysql-learning-completion.js'
import { learningRoutes } from './transport/http/learning-routes.js'
import { learningCompletionRoutes } from './transport/http/learning-completion-routes.js'

export function createMysqlLearningService(executor: Pick<Pool, 'execute' | 'query'>, memberships: LearningMembershipReader) {
  return new LearningService(new MysqlLearningReader(executor), memberships)
}

export function createMysqlLearningCompletionService(
  pool: Pick<Pool, 'getConnection'>,
  membershipForTransaction: (connection: PoolConnection) => LearningMembershipReader,
) {
  return new LearningCompletionService(new MysqlLearningCompletion(pool, membershipForTransaction))
}

export function createLearningHttp(
  services: { read?: LearningService; completion?: LearningCompletionService },
  auth: AuthService,
  config: { wwwOrigin?: string; secureCookies?: boolean },
): FastifyPluginAsync {
  return async app => {
    if ((services.read || services.completion) && !config.wwwOrigin) throw new Error('learning_www_origin_required')
    if (services.completion) await app.register(learningCompletionRoutes, {
      prefix: '/api/v4', service: services.completion, auth, wwwOrigin: config.wwwOrigin!, secureCookies: config.secureCookies ?? true,
    })
    if (services.read) await app.register(learningRoutes, {
      prefix: '/api/v4', service: services.read, auth, wwwOrigin: config.wwwOrigin!, secureCookies: config.secureCookies ?? true,
    })
  }
}
