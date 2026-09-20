import { DelayedError, type Job } from 'bullmq'
import type { PartialCloseWorkflowWorker, PartialCloseWorkflowScope } from '../modules/execution/index.js'
import { parsePartialCloseWorkflowJob, type PartialCloseWorkflowJob } from './partial-close-workflow-queue.js'

/** The receiver must persist/revalidate child dispatch idempotently; completing this queue job is not terminal execution. */
export type PreparedProtectionReceiver = (scope: PartialCloseWorkflowScope, childIntentId: string) => Promise<void>
export type ProtectionReconciliationReceiver = (scope: PartialCloseWorkflowScope, childIntentId: string, commandId: string) => Promise<void>
export function createPartialCloseWorkflowProcessor(worker: PartialCloseWorkflowWorker, prepared: PreparedProtectionReceiver,
  reconcile?: ProtectionReconciliationReceiver) {
  if (typeof prepared !== 'function') throw Error('partial_close_prepared_receiver_required')
  return async (job: Job<PartialCloseWorkflowJob>, token?: string) => {
    if (job.name !== 'execution.partial-close.run') throw Error('partial_close_job_name_invalid')
    const scope = parsePartialCloseWorkflowJob(job.data), result = await worker.run(structuredClone(scope))
    if (result.workflowId !== scope.workflowId) throw Error('partial_close_job_result_mismatch')
    if (result.state === 'protection_reconcile') {
      if (!reconcile) throw Error('partial_close_reconciliation_receiver_required')
      if (!token) throw Error('partial_close_job_token_required')
      await reconcile(scope, result.childIntentId, result.commandId)
    }
    if (result.state === 'waiting' || result.state === 'protection_reconcile') {
      if (!token) throw Error('partial_close_job_token_required')
      await job.moveToDelayed(Date.now()+1000,token)
      throw new DelayedError()
    }
    if (result.state === 'protection_prepared') await prepared(scope,result.childIntentId)
    else if (result.state !== 'stopped' && result.state !== 'expired' && result.state !== 'succeeded') throw Error('partial_close_job_result_invalid')
    return result
  }
}
