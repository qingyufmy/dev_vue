import type {
  ApprovedRiskExecutionSource,
  Operation,
  PreparedExecutionBundle,
  PreparedExecutionResult,
} from '../domain/execution.js'

/**
 * Repository boundary for execution preparation.
 *
 * `persistPreparedExecution` is one short database transaction. Its
 * implementation must lock the owned account first, re-read the approved
 * source and its revisions, then calculate/lock account capacity before
 * inserting the operation, intents and active reservations. It must not call
 * a terminal or any external service while the transaction is open.
 */
export interface ExecutionRepository {
  loadApprovedRiskSource(userId: number, riskDecisionId: string): Promise<ApprovedRiskExecutionSource | null>
  /** Return an existing operation under ownership/hash checks, even after its preparation TTL. */
  replayPreparedExecution(input: { userId: number; accountId: string; riskDecisionId: string; sourceHash: string }): Promise<PreparedExecutionBundle | null>
  persistPreparedExecution(input: PersistPreparedExecutionInput): Promise<PreparedExecutionResult>
  getOperation(userId: number, operationId: string): Promise<Operation | null>
  expirePrepared(input: ExpirePreparedExecutionInput): Promise<Operation[]>
}

export interface PersistPreparedExecutionInput {
  userId: number
  accountId: string
  riskDecisionId: string
  sourceHash: string
  sourceRevision: number
  accountRiskRevision: number
  bundle: PreparedExecutionBundle
}

export interface ExpirePreparedExecutionInput {
  now: string
  limit: number
}

export type ExecutionPreparationRepositoryResult = PreparedExecutionResult
