import type { Pool } from 'mysql2/promise'
import type { PositionProtectionOutcomeService } from '../application/position-protection-outcome-service.js'
import type { PartialCloseWorkflowScope } from '../application/partial-close-workflow-progress.js'
import { BridgeCommandError } from '../domain/bridge-command.js'
import { mergePositionProtectionOutcome, type PositionProtectionOutcomeProjectionReader } from './mysql-position-protection-outcome-merge.js'
import { bridgeCommandTransaction } from './bridge-command-transaction.js'

export type CapturePositionProtectionOutcomeProjection = (scope: PartialCloseWorkflowScope) => Promise<PositionProtectionOutcomeProjectionReader>
export function createMysqlPositionProtectionOutcomeService(pool: Pool, capture: CapturePositionProtectionOutcomeProjection,
  maxProjectionAgeMs: number): PositionProtectionOutcomeService {
  if (!Number.isSafeInteger(maxProjectionAgeMs) || maxProjectionAgeMs < 1 || maxProjectionAgeMs > 60_000) throw new Error('position_protection_projection_age_invalid')
  return { async merge(input) {
    const scope = structuredClone(input)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope.workflowId)
      || !Number.isSafeInteger(scope.userId) || scope.userId < 1 || scope.userId > 2147483647
      || !/^[1-9][0-9]{0,19}$/.test(scope.accountId) || BigInt(scope.accountId) > 18446744073709551615n) {
      throw new BridgeCommandError('position_protection_outcome_scope_invalid', 422)
    }
    const reader = await capture(structuredClone(scope))
    return bridgeCommandTransaction(pool, db => mergePositionProtectionOutcome(db, scope, reader, maxProjectionAgeMs))
  } }
}
