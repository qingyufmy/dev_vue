import type {
  AccountRiskSummary,
  EffectiveRiskPolicy,
  RiskEvaluationInput,
  RiskEvaluationResult,
  RiskInstrumentSnapshot,
  RiskQuoteSnapshot,
} from '../../risk/index.js'
import type { JsonObject, TraderAction } from '../../inference/index.js'
import type {
  NormalizedUserExecutionCommand,
  UserExecutionCommandResult,
  UserExecutionOperation,
  UserExecutionExpectedRevisions,
} from '../domain/user-execution-command.js'
import type { ManualRiskRelease } from '../../risk/index.js'

/**
 * The six revisions captured for a non-AI user command.  Analysis and
 * subscription revisions intentionally do not appear here: a manual command
 * is not an AI trader decision and must never manufacture that lineage.
 */
export interface UserExecutionCurrentRevisions {
  analysis: number
  subscription: number
  account: number
  positions: number
  pendingOrders: number
  quote: number
  contract: number
  risk: number
}

export interface UserExecutionCommandContext {
  userId: number
  accountId: string
  accountCurrency: string
  /** Repository returns only the owner row; this is retained as a defence-in-depth check. */
  owned: boolean
  /** An observer context can read but is never permitted to enter this port. */
  observer: boolean
  tradePermission: boolean
  policy: EffectiveRiskPolicy
  summary: AccountRiskSummary
  manualRelease: ManualRiskRelease | null
  quote: RiskQuoteSnapshot
  instrument: RiskInstrumentSnapshot
  positions: JsonObject[]
  pendingOrders: JsonObject[]
  currentRevisions: UserExecutionCurrentRevisions
}

export interface LoadUserExecutionCommandContextInput {
  userId: number
  accountId: string
  symbol: string | null
  ticket: string | null
}

export interface UserExecutionIdempotencyLookupInput {
  userId: number
  accountId: string
  idempotencyKey: string
}

export interface UserExecutionIdempotencyMatch {
  operation: UserExecutionOperation
  requestHash: string
  /** Required for an idempotent replay; no new operation may be generated. */
  result: UserExecutionCommandResult | null
}

/**
 * The repository owns the short transaction.  It must lock the account first,
 * re-read the six revisions and the exact target ticket, then persist the
 * operation/intent/reservation/outbox rows.  No terminal, network or model I/O
 * is allowed while that transaction is open.
 */
export interface UserExecutionCommandRepository {
  withAccountTransaction?: ((scope: { userId: number; accountId: string }, work: (repository: UserExecutionCommandRepository) => Promise<UserExecutionCommandResult>) => Promise<UserExecutionCommandResult>) | undefined
  loadContext(input: LoadUserExecutionCommandContextInput): Promise<UserExecutionCommandContext | null>
  findByIdempotency(input: UserExecutionIdempotencyLookupInput): Promise<UserExecutionIdempotencyMatch | null>
  persistCommand(input: PersistUserExecutionCommandInput): Promise<UserExecutionCommandResult>
}

export interface PersistUserExecutionCommandInput {
  command: NormalizedUserExecutionCommand
  action: TraderAction
  riskEvaluation: RiskEvaluationResult
  result: UserExecutionCommandResult
  expected: UserExecutionExpectedRevisions
}

/** Allows deterministic unit tests while production uses the shared evaluator. */
export interface UserExecutionRiskEvaluator {
  evaluate(input: RiskEvaluationInput, now?: Date): RiskEvaluationResult
}
