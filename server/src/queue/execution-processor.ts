import { DelayedError } from 'bullmq'
import type { ExecutionDistributionTargetWorker, ExecutionPreparationWorker, ExecutionService } from '../modules/execution/index.js'

export function createExecutionProcessor(ports: {
  planning: Pick<ExecutionService, 'prepare'>
  preparation: Pick<ExecutionPreparationWorker, 'run'>
  distributionTargets: Pick<ExecutionDistributionTargetWorker, 'run'>
}) {
  return async (job: { name: string; data: unknown; moveToDelayed?: (timestamp: number, token?: string) => Promise<void> }, token?: string) => {
    const data = job.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('execution_job_invalid')
    const value = data as Record<string, unknown>
    if (job.name === 'execution.risk-decision.prepare') {
      if (typeof value.riskDecisionId !== 'string' || !value.riskDecisionId.trim()
        || typeof value.userId !== 'number' || !Number.isSafeInteger(value.userId) || value.userId < 1) throw Error('risk_decision_job_invalid')
      const result = await ports.planning.prepare(value.userId, value.riskDecisionId)
      return { riskDecisionId: value.riskDecisionId, kind: result.kind }
    }
    if (job.name === 'execution.distribution.target') {
      if (typeof value.distributionTargetId !== 'string' || !value.distributionTargetId.trim()) throw Error('distribution_target_job_invalid')
      return ports.distributionTargets.run(value.distributionTargetId)
    }
    if (job.name !== 'execution.intent.prepare') throw Error('execution_job_invalid')
    if (typeof value.intentId !== 'string' || !value.intentId.trim()) throw Error('execution_intent_job_invalid')
    const result = await ports.preparation.run(value.intentId)
    if (result.kind === 'busy') {
      if (!job.moveToDelayed) throw Error('execution_prepare_busy')
      await job.moveToDelayed(Date.now() + 1000, token)
      throw new DelayedError()
    }
    if (result.kind === 'no_work') return { intentId: value.intentId, kind: result.kind }
    return { intentId: value.intentId, kind: result.kind, commandId: result.command.id }
  }
}
