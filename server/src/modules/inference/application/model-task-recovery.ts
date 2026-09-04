export interface ModelTaskRecoveryRepository {
  expireOverdue(now: Date, limit: number): Promise<number>
}

export class ModelTaskRecovery {
  constructor(private readonly repository: ModelTaskRecoveryRepository) {}

  expireOverdue(now = new Date(), limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('model_recovery_limit_invalid')
    return this.repository.expireOverdue(now, limit)
  }
}
