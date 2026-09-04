import { describe, expect, it, vi } from 'vitest'
import {
  ExecutionDistributionError,
  distributionCloseAsUserCommand,
  distributionCommandAsUserCommand,
  freezeDistributionTarget,
  freezeEligibleDistributionTargets,
  normalizeCreateDistributionCloseInput,
  normalizeCreateDistributionInput,
  selectExactDistributionCloseTargets,
  type DistributionTargetCandidate,
  type ExactDistributionOutcome,
} from '../src/modules/execution/domain/execution-distribution.js'
import { ExecutionDistributionService } from '../src/modules/execution/application/execution-distribution-service.js'
import type { ExecutionDistributionRepository } from '../src/modules/execution/application/execution-distribution-ports.js'

const candidate = (overrides: Partial<DistributionTargetCandidate> = {}): DistributionTargetCandidate => ({
  subscriptionId: 'sub-1', userId: 7, accountId: '101', symbol: 'XAUUSD', subscriptionRevision: 4,
  traderStrategyId: 'strategy-1', traderStrategyVersionId: 'version-2', accountCurrency: 'USD', tradePermission: true,
  accountRevision: 8, positionsRevision: 9, pendingOrdersRevision: 10, quoteRevision: 11, contractRevision: 12, riskRevision: 13,
  accountSnapshotId: 'account_runtime:101:8', quoteSnapshotId: 'market_quote:101:XAUUSD:11', contractSnapshotId: 'market_contract:101:XAUUSD:12', riskSnapshotId: 'risk_summary:101:13',
  ...overrides,
})

const marketCommand = {
  commandType: 'market_order' as const,
  symbol: 'xauusd', side: 'buy' as const, volume: '0.10', stopLoss: '2300.00', takeProfit: null, referencePrice: '2350.00',
}

describe('execution distribution domain', () => {
  it('normalizes an entry command without accepting close or modification actions', () => {
    const normalized = normalizeCreateDistributionInput({ actorUserId: 9, actorRole: 'admin', strategyId: 'strategy-1', idempotencyKey: 'dist-20260904-01', command: marketCommand })
    expect(normalized.command).toEqual({ ...marketCommand, symbol: 'XAUUSD' })
    expect(normalized.requestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(() => normalizeCreateDistributionInput({ actorUserId: 9, actorRole: 'admin', strategyId: 'strategy-1', idempotencyKey: 'dist-20260904-02', command: { commandType: 'close_position' } as never })).toThrowError(ExecutionDistributionError)
  })

  it('normalizes close target selection as an exact CAS request', () => {
    const normalized = normalizeCreateDistributionCloseInput({ actorUserId: 9, actorRole: 'admin', sourceDistributionId: 'distribution-1', idempotencyKey: 'close-20260904-01', expectedRevision: 3, targetIds: [] })
    expect(normalized).toMatchObject({ actorUserId: 9, sourceDistributionId: 'distribution-1', expectedRevision: 3, targetIds: [] })
    expect(normalized.requestHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('freezes only subscriptions matching the active trader version and symbol, in deterministic account order', () => {
    const targets = freezeEligibleDistributionTargets([
      candidate({ subscriptionId: 'sub-z', accountId: '200' }),
      candidate({ subscriptionId: 'sub-a', accountId: '100' }),
      candidate({ subscriptionId: 'sub-b', accountId: '100' }),
      candidate({ subscriptionId: 'wrong-version', accountId: '300', traderStrategyVersionId: 'version-old' }),
      candidate({ subscriptionId: 'wrong-symbol', accountId: '400', symbol: 'EURUSD' }),
    ], 'strategy-1', 'version-2', 'XAUUSD', 'distribution-1', { command_type: 'market_order', symbol: 'XAUUSD' }, '2026-09-04T00:00:00.000Z', (() => { let i = 0; return () => `target-${++i}` })())
    expect(targets.map(target => target.id)).toEqual(['target-1', 'target-2'])
    expect(targets.map(target => target.accountId)).toEqual(['100', '200'])
    expect(targets[0]?.frozenContext).toMatchObject({ strategy: { id: 'strategy-1', versionId: 'version-2' }, subscription: { id: 'sub-a', revision: 4, symbol: 'XAUUSD' }, expected: { accountRevision: 8, quoteRevision: 11, contractRevision: 12, riskRevision: 13 }, snapshots: { quote: 'market_quote:101:XAUUSD:11' } })
  })

  it('turns a frozen distribution entry into the same account command vocabulary used by execution', () => {
    const target = freezeDistributionTarget(candidate(), 'distribution-1', 'target-1', '2026-09-04T00:00:00.000Z', { command_type: 'market_order' })
    const command = distributionCommandAsUserCommand({ ...marketCommand, symbol: 'XAUUSD' }, target, 'operation-1', 'distribution-1', 'target-key-20260904')
    expect(command).toMatchObject({ userId: 7, accountId: '101', commandType: 'market_order', sourceType: 'strategy_distribution', sourceId: 'target-1', parentOperationId: 'operation-1', distributionId: 'distribution-1', parameters: { symbol: 'XAUUSD', side: 'buy', volume: '0.10' } })
  })

  it('selects all and only attributable succeeded position outcomes for an exact close', () => {
    const outcomes: ExactDistributionOutcome[] = [
      { targetId: 'target-2', outcomeId: 'outcome-2', ticket: '2002', resourceKind: 'position', status: 'succeeded' },
      { targetId: 'target-1', outcomeId: 'outcome-order', ticket: '1001', resourceKind: 'position', status: 'succeeded' },
      { targetId: 'target-3', outcomeId: 'outcome-pending', ticket: '3003', resourceKind: 'pending_order' as never, status: 'succeeded' as never },
      { targetId: 'target-4', outcomeId: 'outcome-failed', ticket: '4004', resourceKind: 'position', status: 'failed' as never },
    ]
    expect(selectExactDistributionCloseTargets(outcomes, []).map(item => item.targetId)).toEqual(['target-1', 'target-2'])
    expect(selectExactDistributionCloseTargets(outcomes, ['target-2'])).toEqual([outcomes[0]])
  })

  it('rejects a target list if even one requested target is outside the source outcomes', () => {
    const outcomes: ExactDistributionOutcome[] = [{ targetId: 'target-1', outcomeId: 'outcome-1', ticket: '1001', resourceKind: 'position', status: 'succeeded' }]
    expect(() => selectExactDistributionCloseTargets(outcomes, ['target-1', 'target-missing'])).toThrowError(ExecutionDistributionError)
    try { selectExactDistributionCloseTargets(outcomes, ['target-missing']) } catch (error) { expect(error).toMatchObject({ code: 'distribution_close_target_not_attributable', status: 409 }) }
  })

  it('keeps the original outcome and ticket frozen in the close child command', () => {
    const target = freezeDistributionTarget(candidate(), 'close-distribution', 'close-target-1', '2026-09-04T00:00:00.000Z', { command_type: 'close_position' }, { outcomeId: 'outcome-1', ticket: '1001', sourceTargetId: 'source-target-1' })
    const command = distributionCloseAsUserCommand(target, 'close-operation', 'close-distribution', 'close-key-20260904')
    expect(command).toMatchObject({ commandType: 'close_position', sourceType: 'distribution_close', sourceId: 'close-target-1', parameters: { ticket: '1001', volume: null } })
  })

  it('blocks non-admin actors before touching the repository', async () => {
    const repository = {
      findByIdempotency: vi.fn(),
      createManualOrderDistribution: vi.fn(),
      createDistributionClose: vi.fn(),
      getDistribution: vi.fn(),
    } as unknown as ExecutionDistributionRepository
    const service = new ExecutionDistributionService(repository)
    await expect(service.createManualOrderDistribution({ actorUserId: 7, actorRole: 'user', strategyId: 'strategy-1', idempotencyKey: 'dist-20260904-03', command: marketCommand })).rejects.toMatchObject({ code: 'distribution_admin_required', status: 403 })
    expect(repository.findByIdempotency).not.toHaveBeenCalled()
  })
})
