import {
  ExecutionDistributionError,
  normalizeCreateDistributionCloseInput,
  normalizeCreateDistributionInput,
  type CreateDistributionCloseInput,
  type CreateDistributionInput,
  type ExecutionDistributionResult,
} from '../domain/execution-distribution.js'
import type { ExecutionDistributionRepository } from './execution-distribution-ports.js'

/**
 * Application boundary for administrator-triggered strategy distributions.
 *
 * A distribution is only a frozen batch request.  It never calls Bridge and
 * never executes an account command synchronously.  The later worker can
 * derive one user command per frozen target and use the regular execution
 * lifecycle for risk review, outbox delivery and terminal reconciliation.
 */
export class ExecutionDistributionService {
  constructor(private readonly repository: ExecutionDistributionRepository) {}

  async createManualOrderDistribution(input: CreateDistributionInput): Promise<ExecutionDistributionResult> {
    assertAdministrator(input.actorRole)
    const normalized = normalizeCreateDistributionInput(input)
    const existing = await this.repository.findByIdempotency({ actorUserId: normalized.actorUserId, idempotencyKey: normalized.idempotencyKey })
    if (existing) {
      if (existing.requestHash !== normalized.requestHash) throw new ExecutionDistributionError('distribution_idempotency_conflict', 409)
      return existing.result
    }
    return this.repository.createManualOrderDistribution(normalized)
  }

  async createDistributionClose(input: CreateDistributionCloseInput): Promise<ExecutionDistributionResult> {
    assertAdministrator(input.actorRole)
    const normalized = normalizeCreateDistributionCloseInput(input)
    const existing = await this.repository.findByIdempotency({ actorUserId: normalized.actorUserId, idempotencyKey: normalized.idempotencyKey })
    if (existing) {
      if (existing.requestHash !== normalized.requestHash) throw new ExecutionDistributionError('distribution_idempotency_conflict', 409)
      return existing.result
    }
    return this.repository.createDistributionClose(normalized)
  }

  async getDistribution(actorUserId: number, actorRole: string, distributionId: string) {
    assertAdministrator(actorRole)
    if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) throw new ExecutionDistributionError('distribution_actor_invalid', 422)
    const normalized = String(distributionId ?? '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(normalized)) throw new ExecutionDistributionError('distribution_id_invalid', 400)
    const result = await this.repository.getDistribution({ actorUserId, distributionId: normalized })
    if (!result) throw new ExecutionDistributionError('distribution_not_found', 404)
    return result
  }
}

function assertAdministrator(role: string) {
  if (String(role ?? '').trim() !== 'admin') throw new ExecutionDistributionError('distribution_admin_required', 403)
}
