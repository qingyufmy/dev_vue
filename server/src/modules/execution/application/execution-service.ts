import { executionSourceHash, ExecutionError, prepareExecutionBundle, type PreparedExecutionResult } from '../domain/execution.js'
import type { ExecutionRepository } from './execution-ports.js'

export class ExecutionService {
  constructor(private readonly repository: ExecutionRepository) {}

  /** Prepare the approved risk decision, or return a side-effect-free noop. */
  async prepare(userId: number, riskDecisionId: string, now = new Date()): Promise<PreparedExecutionResult> {
    assertUserId(userId)
    const decisionId = assertOpaqueId(riskDecisionId, 'risk_decision_id')
    assertDate(now)
    const source = await this.repository.loadApprovedRiskSource(userId, decisionId)
    if (!source) throw new ExecutionError('execution_source_not_found', 404)
    if (source.userId !== userId || source.riskDecisionId !== decisionId) throw new ExecutionError('execution_source_revision_conflict', 409)
    const prepared = prepareExecutionBundle(source, now)
    if (prepared.kind === 'noop') return prepared
    // Repository revalidates the source/hash and account capacity inside one
    // transaction. The loaded object is never treated as authoritative after
    // this point; it is only the candidate used to build the immutable bundle.
    return this.repository.persistPreparedExecution({
      userId, accountId: source.accountId, riskDecisionId: source.riskDecisionId,
      sourceHash: prepared.sourceHash, sourceRevision: prepared.sourceRevision,
      accountRiskRevision: prepared.accountRiskRevision, bundle: prepared,
    })
  }

  async operation(userId: number, operationId: string) {
    assertUserId(userId)
    const id = assertOpaqueId(operationId, 'operation_id')
    const operation = await this.repository.getOperation(userId, id)
    if (!operation) throw new ExecutionError('execution_operation_not_found', 404)
    return operation
  }

  async expire(now = new Date(), limit = 100) {
    assertDate(now)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ExecutionError('execution_expire_limit_invalid', 422)
    return this.repository.expirePrepared({ now: now.toISOString(), limit })
  }
}

function assertUserId(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ExecutionError('execution_source_invalid', 422)
}

function assertDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ExecutionError('execution_source_time_invalid', 422)
}

function assertOpaqueId(value: string, field: string) {
  const normalized = String(value ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(normalized)) throw new ExecutionError(`execution_${field}_invalid`, 400)
  return normalized
}

// Keep this import referenced in the public service module for consumers that
// used the service as the single hash boundary during the preparation stage.
export { executionSourceHash }
