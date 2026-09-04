import { describe, expect, it } from 'vitest'
import { ExecutionDistributionTargetWorker } from '../src/modules/execution/application/execution-distribution-worker.js'
import type {
  DistributionTargetCompletion,
  ExecutionDistributionTargetRepository,
  RunnableDistributionTarget,
} from '../src/modules/execution/application/execution-distribution-ports.js'
import { freezeDistributionTarget, type ExecutionDistribution } from '../src/modules/execution/domain/execution-distribution.js'
import type { Operation } from '../src/modules/execution/domain/execution.js'
import type { UserExecutionCommandInput, UserExecutionCommandResult } from '../src/modules/execution/domain/user-execution-command.js'

const now = new Date('2026-09-04T04:00:00.000Z')

function runnable(kind: 'manual_order' | 'close' = 'manual_order'): RunnableDistributionTarget {
  const target = freezeDistributionTarget({
    subscriptionId: 'subscription-1', userId: 9, accountId: '42', symbol: 'XAUUSD', subscriptionRevision: 3,
    traderStrategyId: 'strategy-1', traderStrategyVersionId: 'version-1', accountCurrency: 'USD', tradePermission: true,
    accountRevision: 11, positionsRevision: 12, pendingOrdersRevision: 13, quoteRevision: 14, contractRevision: 15, riskRevision: 16,
    accountSnapshotId: 'account-11', quoteSnapshotId: 'quote-14', contractSnapshotId: 'contract-15', riskSnapshotId: 'risk-16',
  }, 'distribution-1', 'target-0001', now.toISOString(), {}, kind === 'close'
    ? { outcomeId: 'outcome-1', ticket: '9001', sourceTargetId: 'source-target-1' }
    : undefined)
  if (kind === 'close') target.frozenContext.expected.resourceRevision = 21
  const parentOperation: Operation = {
    id: 'operation-parent-1', userId: 1, accountId: null, kind: kind === 'close' ? 'distribution_close' : 'execution_distribution',
    status: 'running', sourceType: kind === 'close' ? 'distribution_close' : 'strategy_distribution', sourceId: 'distribution-1',
    idempotencyScope: kind === 'close' ? 'distribution_close' : 'strategy_distribution', idempotencyKey: 'parent-idempotency', requestHash: 'a'.repeat(64),
    resourceType: 'execution_distribution', resourceId: 'distribution-1', errorCode: null, acceptedAt: now.toISOString(), updatedAt: now.toISOString(),
    completedAt: null, revision: 1, intentIds: [], parentOperationId: null, distributionId: 'distribution-1', resultSummary: {},
  }
  const distribution: ExecutionDistribution = {
    id: 'distribution-1', operationId: parentOperation.id, actorUserId: 1, strategyId: 'strategy-1', strategyVersionId: 'version-1', kind,
    sourceDistributionId: kind === 'close' ? 'distribution-source-1' : null, idempotencyKey: 'distribution-key-1', requestHash: 'b'.repeat(64),
    command: kind === 'manual_order'
      ? { command_type: 'market_order', symbol: 'XAUUSD', side: 'buy', volume: '0.01', stop_loss: '2490', take_profit: null, reference_price: '2500' }
      : { command_type: 'close_position', source_distribution_id: 'distribution-source-1', target_ids: ['source-target-1'] },
    status: 'running', targetCount: 1, resultSummary: {}, createdAt: now.toISOString(), updatedAt: now.toISOString(), completedAt: null, revision: 1,
  }
  return { target, distribution, parentOperation }
}

class MemoryTargetRepository implements ExecutionDistributionTargetRepository {
  completions: DistributionTargetCompletion[] = []
  constructor(private readonly value: RunnableDistributionTarget | null) {}
  async claimTarget() { return this.value }
  async completeTarget(input: DistributionTargetCompletion) { this.completions.push(input) }
}

function result(input: UserExecutionCommandInput, status: 'queued' | 'rejected'): UserExecutionCommandResult {
  return {
    kind: status === 'rejected' ? 'rejected' : 'prepared',
    command: { ...input, commandId: 'command-0001', requestHash: 'c'.repeat(64) },
    sourceHash: 'd'.repeat(64),
    operation: {
      id: 'operation-child-1', userId: input.userId, accountId: input.accountId, kind: 'user_execution_command', status,
      sourceType: input.sourceType ?? 'user_command', sourceId: input.sourceId ?? 'command-0001', parentOperationId: input.parentOperationId ?? null,
      distributionId: input.distributionId ?? null, idempotencyScope: 'user_command', clientIdempotencyKey: input.idempotencyKey,
      idempotencyKey: 'e'.repeat(64), requestHash: 'c'.repeat(64), resourceType: 'execution_intent', resourceId: status === 'queued' ? 'intent-0001' : null,
      errorCode: status === 'rejected' ? 'risk_rejected' : null, acceptedAt: now.toISOString(), updatedAt: now.toISOString(),
      completedAt: status === 'rejected' ? now.toISOString() : null, revision: 1, intentIds: status === 'queued' ? ['intent-0001'] : [],
    },
    intent: status === 'rejected' ? null : {} as never,
    reservations: [],
    riskEvaluation: {} as never,
  } as UserExecutionCommandResult
}

describe('ExecutionDistributionTargetWorker', () => {
  it('converts a frozen order target into the shared user-command path and links the child operation', async () => {
    const repository = new MemoryTargetRepository(runnable())
    let captured: UserExecutionCommandInput | null = null
    const worker = new ExecutionDistributionTargetWorker(repository, {
      execute: async input => { captured = input; return result(input, 'queued') },
    })
    const output = await worker.run('target-0001', now)
    expect(captured).toMatchObject({
      userId: 9, accountId: '42', commandType: 'market_order', sourceType: 'strategy_distribution',
      sourceId: 'target-0001', parentOperationId: 'operation-parent-1', distributionId: 'distribution-1',
      idempotencyKey: 'dist-target:target-0001',
    })
    expect(output).toMatchObject({ targetId: 'target-0001', childOperationId: 'operation-child-1', status: 'running' })
    expect(repository.completions).toEqual([expect.objectContaining({ childOperationId: 'operation-child-1', status: 'running' })])
  })

  it('uses the exact source ticket and frozen resource revision for a distribution close', async () => {
    const repository = new MemoryTargetRepository(runnable('close'))
    let captured: UserExecutionCommandInput | null = null
    const worker = new ExecutionDistributionTargetWorker(repository, {
      execute: async input => { captured = input; return result(input, 'queued') },
    })
    await worker.run('target-0001', now)
    expect(captured).toMatchObject({
      commandType: 'close_position', sourceType: 'distribution_close',
      expected: { resourceRevision: 21 }, parameters: { ticket: '9001', volume: null },
    })
  })
})
