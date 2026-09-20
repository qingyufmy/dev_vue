import type { Queue } from 'bullmq'
import { ReviewRecovery } from './application/review-recovery.js'
import { MysqlReviewRecoverySource } from './infrastructure/mysql-review-recovery-source.js'
import { BullmqReviewRecoveryPublisher } from './infrastructure/bullmq-review-recovery-publisher.js'
import { reviewArchivedActivityRoutes } from './transport/http/review-archived-activity-routes.js'
import { MysqlReviewArchivedActivityReader } from './infrastructure/mysql-review-archived-activity-reader.js'
import { reviewHistoryRoutes } from './transport/http/review-history-routes.js'
import { MysqlReviewHistoryReader } from './infrastructure/mysql-review-history-reader.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { ManualCandidateSourceVerifier } from './application/manual-candidate-source-verifier.js'
import type { FastifyPluginAsync } from 'fastify'
import { ReviewService } from './application/review-service.js'
import { ReviewWorker, type ReviewModelGatewayResolver } from './application/review-worker.js'
import { MysqlReviewRepository } from './infrastructure/mysql-review-repository.js'
import { reviewRoutes, type ReviewRequestAuthenticator } from './transport/http/review-routes.js'
export { createMysqlRuntimeStrategyMemoryReader } from './infrastructure/mysql-runtime-strategy-memory-reader.js'
export { createMysqlRuntimeMemoryPreparationWriter } from './infrastructure/mysql-runtime-memory-preparation-writer.js'
export { createMysqlManualCandidateWriter } from './infrastructure/mysql-manual-candidate-writer.js'

export function createReviewHttp(service: ReviewService, auth: ReviewRequestAuthenticator): FastifyPluginAsync {
  return async app => { await app.register(reviewRoutes, { prefix: '/api/v4', service, auth }) }
}

export function createMysqlReviewHttp(pool: Pool, auth: ReviewRequestAuthenticator,
  manualSources?: (connection: PoolConnection) => ManualCandidateSourceVerifier): FastifyPluginAsync {
  return async app => {
    await app.register(createReviewHttp(new ReviewService(new MysqlReviewRepository(pool, manualSources)), auth))
    await app.register(reviewArchivedActivityRoutes, { prefix: '/api/v4', reader: new MysqlReviewArchivedActivityReader(pool), auth })
    await app.register(reviewHistoryRoutes, { prefix: '/api/v4', reader: new MysqlReviewHistoryReader(pool), auth })
  }
}

export function createMysqlReviewWorker(pool: Pool, models: ReviewModelGatewayResolver, workerId: string): Pick<ReviewWorker, 'process'> {
  return new ReviewWorker(new MysqlReviewRepository(pool), models, workerId)
}

export function createMysqlReviewHistoryReader(pool: Pick<Pool, 'execute'>) { return new MysqlReviewHistoryReader(pool) }

export function createMysqlReviewArchivedActivityReader(pool: Pick<Pool, 'execute'>) { return new MysqlReviewArchivedActivityReader(pool) }

export function createMysqlReviewRecovery(pool: Pick<Pool, 'execute'>, queue: Pick<Queue, 'add'>) {
  return new ReviewRecovery(new MysqlReviewRecoverySource(pool), new BullmqReviewRecoveryPublisher(queue))
}
export { createMysqlManualCandidateTask } from './infrastructure/mysql-manual-candidate-task.js'

export { createMysqlManualCandidateDue } from './infrastructure/mysql-manual-candidate-due.js'
export { createMysqlSystemTradeCaseWriter } from './infrastructure/mysql-system-trade-case.js'
export { createMysqlSystemTradeCaseCompletion } from './infrastructure/mysql-system-trade-case-completion.js'
export { createMysqlSystemReviewTask } from './infrastructure/mysql-system-review-task.js'
export { createMysqlSystemReviewDue } from './infrastructure/mysql-system-review-due.js'
export { assertMysqlSystemReviewTaskSchemaReady } from './infrastructure/mysql-system-review-task-schema.js'
export { createMysqlPeriodReviewWriter } from './infrastructure/mysql-period-review-writer.js'
export { createMysqlPeriodReviewWorkflow } from './infrastructure/mysql-period-review-workflow.js'
export { reviewTransaction as runReviewTransaction } from './infrastructure/review-transaction.js'
export { createMysqlPeriodReviewDue } from './infrastructure/mysql-period-review-due.js'
