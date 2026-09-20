import type { Pool } from 'mysql2/promise'
import type { BridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import { createPartialCloseWorkflowWorker } from '../modules/execution/index.js'
import { assertMysqlExecutionWorkflowSchemaReady, createMysqlPartialCloseWorkflowProgress,
  createMysqlPartialCloseWorkflowRecovery, createMysqlPositionProtectionPreparation,
  createMysqlPositionProtectionOutcomeService } from '../modules/execution/composition.js'
import { createPartialCloseWorkflowProcessor, type PreparedProtectionReceiver,
  type ProtectionReconciliationReceiver } from '../queue/partial-close-workflow-processor.js'
import { createPartialCloseProgressCapture } from './partial-close-progress.js'
import { createPositionProtectionReviewCapture } from './position-protection-preparation.js'
import { createPositionProtectionOutcomeProjectionCapture } from './position-protection-outcome.js'
import type { PositionProtectionReadLimits } from './position-protection-review.js'

/** Execution Worker assembly. Receivers persist command requests; they must not own terminal transport. */
export async function createPartialCloseWorkflowRuntime(input: { pool: Pool;
  routes: Pick<BridgeGatewayLeaseStore, 'current'>; limits: PositionProtectionReadLimits;
  prepared: PreparedProtectionReceiver; reconcile: ProtectionReconciliationReceiver }) {
  if (typeof input.prepared !== 'function' || typeof input.reconcile !== 'function') {
    throw Error('partial_close_durable_receivers_required')
  }
  await assertMysqlExecutionWorkflowSchemaReady(input.pool)
  const { pool, routes } = input, limits = structuredClone(input.limits)
  const preparation = createMysqlPositionProtectionPreparation(pool, createPositionProtectionReviewCapture(routes, limits))
  const progress = createMysqlPartialCloseWorkflowProgress(pool, createPartialCloseProgressCapture(routes, limits.maxAgeMs), limits.maxAgeMs)
  const outcomes = createMysqlPositionProtectionOutcomeService(pool, createPositionProtectionOutcomeProjectionCapture(routes, limits.maxAgeMs), limits.maxAgeMs)
  const worker = createPartialCloseWorkflowWorker(progress, preparation, outcomes)
  return { worker, outcomes,
    processor: createPartialCloseWorkflowProcessor(worker, input.prepared, input.reconcile),
    recovery: createMysqlPartialCloseWorkflowRecovery(pool, { protecting: true }) }
}
