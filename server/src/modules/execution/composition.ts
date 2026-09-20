import type { Pool } from 'mysql2/promise'
import { MysqlArchivedExecutionReader } from './infrastructure/mysql-archived-execution-reader.js'
import { archivedExecutionRoutes } from './transport/http/archived-execution-routes.js'
import type { ArchivedExecutionReader } from './application/archived-execution-reader.js'
export { createMysqlPendingPreparationReviewer } from './infrastructure/mysql-pending-preparation-reviewer.js'
// Only runtime assembly may bind this execution capability to another domain's transaction.
export { createProjectionReservationAbsorber } from './infrastructure/mysql-projection-reservation-absorber.js'
export { MysqlExecutionRepository } from './infrastructure/mysql-execution-repository.js'
export { createMysqlPendingCommandReviewer } from './infrastructure/mysql-pending-command-reviewer.js'
export { MysqlBridgeCommandRepository, type CapturePartialCloseRegistration } from './infrastructure/mysql-bridge-command-repository.js'
export { createMysqlPartialCloseWorkflowProgress, type CapturePartialCloseProgressFacts } from './infrastructure/mysql-partial-close-workflow-progress.js'
export { createMysqlPartialCloseWorkflowRecovery } from './infrastructure/mysql-partial-close-workflow-recovery.js'
export { createMysqlPositionProtectionPreparation, type CapturePositionProtectionReviewer } from './infrastructure/mysql-position-protection-preparation.js'
export { createMysqlPositionProtectionCommandReviewer } from './infrastructure/mysql-position-protection-command-reviewer.js'
export { writePositionProtectionCommandBinding, replayPositionProtectionCommandBinding } from './infrastructure/mysql-position-protection-command-binding.js'
export { readPositionProtectionDispatchReview } from './infrastructure/mysql-position-protection-dispatch-review.js'
export { writePositionProtectionDispatchReview, type CapturePositionProtectionDispatch } from './infrastructure/mysql-position-protection-dispatch-writer.js'
export { readPositionProtectionSuccessReceipt } from './infrastructure/mysql-position-protection-success-receipt.js'
export { mergePositionProtectionOutcome, type PositionProtectionOutcomeProjectionReader } from './infrastructure/mysql-position-protection-outcome-merge.js'
export { createMysqlPositionProtectionOutcomeService, type CapturePositionProtectionOutcomeProjection } from './infrastructure/mysql-position-protection-outcome-service.js'
export { createMysqlPositionProtectionReceiverScope } from './infrastructure/mysql-position-protection-receiver-scope.js'
export type { CapturePositionProtectionCommandProvider, PositionProtectionCommandProvider } from './infrastructure/position-protection-command-provider.js'
export { MysqlExecutionCommandSource } from './infrastructure/mysql-execution-command-source.js'
export { MysqlUserExecutionCommandRepository } from './infrastructure/mysql-user-execution-command-repository.js'
export { MysqlExecutionDistributionRepository } from './infrastructure/mysql-execution-distribution-repository.js'
export { RedisAccountExecutionLeaseStore } from './infrastructure/redis-account-execution-lease-store.js'
import type { FastifyPluginAsync } from 'fastify'
export { createMysqlPendingDedupSnapshotReader } from './infrastructure/mysql-pending-dedup-snapshot-reader.js'
export { createMysqlPendingOrderOriginReader } from './infrastructure/mysql-pending-order-origin-reader.js'
export { createMysqlSnapshotPendingOrderOriginReader } from './infrastructure/mysql-pending-order-origin-reader.js'
import { executionRoutes, type ExecutionRoutesOptions } from './transport/http/execution-routes.js'
import { userExecutionCommandRoutes, type UserExecutionCommandRoutesOptions } from './transport/http/user-execution-command-routes.js'
import { executionDistributionRoutes, type ExecutionDistributionRoutesOptions } from './transport/http/execution-distribution-routes.js'

export function createExecutionHttp(execution: ExecutionRoutesOptions['service'],
  commands: UserExecutionCommandRoutesOptions['service'], distributions: ExecutionDistributionRoutesOptions['service'],
  auth: ExecutionDistributionRoutesOptions['auth'], archive?: ArchivedExecutionReader): FastifyPluginAsync {
  return async app => {
    await app.register(executionRoutes, { prefix: '/api/v4', service: execution, auth })
    if (archive) await app.register(archivedExecutionRoutes, { prefix: '/api/v4', reader: archive, auth })
    await app.register(userExecutionCommandRoutes, { prefix: '/api/v4', service: commands, auth })
    await app.register(executionDistributionRoutes, { prefix: '/api/v4', service: distributions, auth })
  }
}

export { createMysqlSnapshotOpeningOrderOriginReader } from './infrastructure/mysql-pending-order-origin-reader.js'

export { createMysqlPartialCloseWorkflowWriter } from './infrastructure/mysql-partial-close-workflow-writer.js'

export { createMysqlPartialCloseReceiptReader } from './infrastructure/mysql-partial-close-receipt-reader.js'

export { assertMysqlExecutionWorkflowSchemaReady } from './infrastructure/mysql-execution-workflow-schema-readiness.js'
export { createMysqlPositionProtectionReconciliationRequest } from './infrastructure/mysql-position-protection-reconciliation-request.js'
export { writePartialCloseParentDispatchReview, type CapturePartialCloseParentDispatch } from './infrastructure/mysql-partial-close-parent-dispatch-review.js'

export { createMysqlExecutedDealOriginReader } from './infrastructure/mysql-executed-deal-origin-reader.js'

export function createMysqlArchivedExecutionReader(pool: Pool): ArchivedExecutionReader { return new MysqlArchivedExecutionReader(pool) }
