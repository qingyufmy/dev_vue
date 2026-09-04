import type { PoolConnection } from 'mysql2/promise'
import type {
  CreateDistributionCloseInput,
  ExecutionDistributionResult,
  ExactDistributionOutcome,
  FrozenDistributionTarget,
  NormalizedCreateDistributionCloseInput,
  NormalizedCreateDistributionInput,
  DistributionIdempotencyMatch,
  DistributionTargetCandidate,
  DistributionKind,
  ExecutionDistribution,
  ExecutionDistributionPreview,
} from '../domain/execution-distribution.js'
import type { Operation } from '../domain/execution.js'
import type { JsonObject } from '../../inference/domain/inference.js'

export interface ActiveTraderStrategyVersion {
  strategyId: string
  versionId: string
  revision: number
  kind: 'trader'
  status: 'active'
}

/**
 * The repository owns the short freeze transaction.  It must lock the active
 * strategy first, then eligible subscriptions/accounts in account-id order,
 * and only then write the parent operation, distribution, target snapshots
 * and outbox event.  No Bridge, model or network call is permitted here.
 */
export interface ExecutionDistributionRepository {
  findByIdempotency(input: { actorUserId: number; idempotencyKey: string }): Promise<DistributionIdempotencyMatch | null>
  createManualOrderDistribution(input: NormalizedCreateDistributionInput): Promise<ExecutionDistributionResult>
  createDistributionClose(input: NormalizedCreateDistributionCloseInput): Promise<ExecutionDistributionResult>
  getDistribution(input: { actorUserId: number; distributionId: string }): Promise<ExecutionDistributionResult | null>
  previewManualOrderDistribution(input: { actorUserId: number; strategyId: string; symbol: string }): Promise<ExecutionDistributionPreview>
}

/**
 * Optional lower-level port for tests or another storage adapter.  It exposes
 * the immutable rows the MySQL adapter freezes; production application code
 * should use ExecutionDistributionRepository instead.
 */
export interface DistributionFreezeReader {
  loadActiveTraderStrategyVersion(connection: PoolConnection, strategyId: string): Promise<ActiveTraderStrategyVersion | null>
  listEligibleTargets(connection: PoolConnection, strategyId: string, strategyVersionId: string, symbol: string): Promise<DistributionTargetCandidate[]>
  listAttributableCloseOutcomes(connection: PoolConnection, sourceDistributionId: string): Promise<ExactDistributionOutcome[]>
}

export interface DistributionPersistenceInput {
  distribution: {
    id: string
    operationId: string
    actorUserId: number
    strategyId: string
    strategyVersionId: string
    kind: 'manual_order' | 'close'
    sourceDistributionId: string | null
    idempotencyKey: string
    requestHash: string
    command: JsonObject
    status: 'queued' | 'rejected'
    resultSummary: JsonObject
    createdAt: string
    revision: number
  }
  targets: FrozenDistributionTarget[]
}

export type DistributionCloseRequest = CreateDistributionCloseInput

export interface RunnableDistributionTarget {
  distribution: ExecutionDistribution
  parentOperation: Operation
  target: FrozenDistributionTarget
}

export interface DistributionTargetCompletion {
  targetId: string
  childOperationId: string | null
  status: 'running' | 'succeeded' | 'rejected' | 'failed' | 'uncertain'
  errorCode: string | null
  completedAt: string | null
}

/**
 * Target jobs are claimed independently. A retry may claim an already-running
 * row only while no child operation is linked; the child command itself is
 * protected by a stable per-target idempotency key.
 */
export interface ExecutionDistributionTargetRepository {
  claimTarget(targetId: string, now: Date): Promise<RunnableDistributionTarget | null>
  completeTarget(input: DistributionTargetCompletion, now: Date): Promise<void>
}

export interface DistributionTargetRunResult {
  targetId: string
  distributionId: string
  kind: DistributionKind
  childOperationId: string | null
  status: DistributionTargetCompletion['status'] | 'no_work'
}
