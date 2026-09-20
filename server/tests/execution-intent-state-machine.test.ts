import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { JsonObject, TraderAction } from '../src/modules/inference/domain/inference.js'
import {
  ExecutionError,
  PREPARED_EXECUTION_TTL_MS,
  type ApprovedRiskExecutionSource,
  type Operation,
  type PreparedExecutionBundle,
  type RiskReservation,
  prepareExecutionBundle,
  executionSourceHash,
  sha256Canonical,
} from '../src/modules/execution/domain/execution.js'
import type { ExecutionRepository, PersistPreparedExecutionInput } from '../src/modules/execution/application/execution-ports.js'
import { ExecutionService } from '../src/modules/execution/application/execution-service.js'

const NOW = new Date('2026-09-03T08:00:00.000Z')

describe('execution intent preparation state machine', () => {
  it('keeps the reservation symbol identical to the approved action broker symbol', () => {
    const source = sourceWith([action('open-case', 'market_order', { symbol: 'XAUUSD.a', side: 'buy', volume: '0.10' })],
      [approvedRule('open-case', { risk_amount: 10, risk_percent: 0.1, volume: 0.1 })])
    const result = prepareExecutionBundle(source, NOW)
    expect(result.kind).toBe('prepared')
    if (result.kind !== 'prepared') throw new Error('expected prepared')
    expect(result.reservations[0]?.symbol).toBe('XAUUSD.a')
    expect(result.intents[0]?.action.parameters.symbol).toBe(result.reservations[0]?.symbol)
  })

  it('rejects surrounding whitespace rather than reserving a different symbol from the action', () => {
    const source = sourceWith([action('open-space', 'market_order', { symbol: ' XAUUSD ', side: 'buy', volume: '0.10' })],
      [approvedRule('open-space', { risk_amount: 10, risk_percent: 0.1, volume: 0.1 })])
    expect(() => prepareExecutionBundle(source, NOW)).toThrow('execution_action_invalid')
  })
  it('creates one independent prepared intent per approved action and one reservation per new-risk action', () => {
    const source = sourceWith([
      action('open-1', 'market_order', { symbol: 'XAUUSD', side: 'buy', volume: '0.10' }),
      action('protect-1', 'modify_position', { ticket: '1001', stop_loss: '2310.00' }),
      action('cancel-1', 'cancel_order', { ticket: '2001' }),
    ], [
      approvedRule('open-1', { risk_amount: 105.5, risk_percent: 0.42, volume: 0.1 }),
    ])

    const result = prepareExecutionBundle(source, NOW)
    expect(result.kind).toBe('prepared')
    if (result.kind !== 'prepared') return

    expect(result.operation.status).toBe('queued')
    expect(result.operation.intentIds).toHaveLength(3)
    expect(result.intents).toHaveLength(3)
    expect(new Set(result.intents.map(intent => intent.id)).size).toBe(3)
    expect(new Set(result.intents.map(intent => intent.idempotencyKey)).size).toBe(3)
    expect(result.intents.every(intent => intent.status === 'prepared')).toBe(true)
    expect(result.reservations).toHaveLength(1)
    expect(result.reservations[0]).toMatchObject({
      reservedVolume: 0.1,
      reservedRiskAmount: 105.5,
      reservedRiskPercent: 0.42,
      reservedOpenPositions: 1,
      reservedPendingOrders: 0,
      reservedDailyOpens: 1,
      status: 'active',
    })
    expect(result.intents.find(intent => intent.actionId === 'open-1')?.riskReservationId).toBe(result.reservations[0]?.id)
    expect(result.intents.filter(intent => intent.actionId !== 'open-1').every(intent => intent.riskReservationId === null)).toBe(true)
  })

  it('reserves a pending order but never reserves close, cancel, or protection changes', () => {
    const source = sourceWith([
      action('pending-1', 'pending_order', { symbol: 'EURUSD', type: 'buy_limit', volume: 0.2, price: 1.08 }),
      action('close-1', 'close_position', { ticket: '1001' }),
      action('cancel-1', 'cancel_order', { ticket: '2001' }),
      action('modify-position-1', 'modify_position', { ticket: '1001', stop_loss: 1.07 }),
      action('modify-order-1', 'modify_order', { ticket: '2001', price: 1.08 }),
    ], [approvedRule('pending-1', { risk_amount: '12.5', risk_percent: '0.08', volume: '0.2' })])

    const result = prepareExecutionBundle(source, NOW)
    expect(result.kind).toBe('prepared')
    if (result.kind !== 'prepared') return
    expect(result.reservations).toHaveLength(1)
    expect(result.reservations[0]).toMatchObject({
      symbol: 'EURUSD', reservedOpenPositions: 0, reservedPendingOrders: 1, reservedDailyOpens: 1,
    })
    expect(result.intents.filter(intent => intent.actionKind !== 'pending_order').every(intent => intent.riskReservationId === null)).toBe(true)
  })

  it('returns a noop for an approved decision with zero actions and persists nothing', async () => {
    const repository = new MemoryExecutionRepository(sourceWith([], [], 'risk-noop'))
    const result = await new ExecutionService(repository).prepare(42, 'risk-noop', NOW)
    expect(result).toMatchObject({ kind: 'noop', reason: 'no_approved_actions', riskDecisionId: 'risk-noop' })
    expect(repository.persistCalls).toBe(0)
    expect(repository.bundles).toHaveLength(0)
  })

  it('fails closed at the fixed 30 second evaluation deadline', () => {
    const source = sourceWith([
      action('open-1', 'market_order', { symbol: 'XAUUSD', side: 'buy', volume: 0.1 }),
    ], [approvedRule('open-1', { risk_amount: 5, risk_percent: 0.1, volume: 0.1 })])
    expect(() => prepareExecutionBundle(source, new Date(NOW.getTime() + PREPARED_EXECUTION_TTL_MS))).toThrowError(
      expect.objectContaining({ code: 'execution_source_expired', status: 409 }),
    )
  })

  it('rejects a new-risk action when the risk approval does not contain precise risk data', () => {
    const source = sourceWith([
      action('open-1', 'market_order', { symbol: 'XAUUSD', side: 'buy', volume: 0.1 }),
    ], [{ code: 'RISK_ACTION_APPROVED', outcome: 'passed', actionId: 'open-1', details: { risk_percent: 0.1, volume: 0.1 } }])
    expect(() => prepareExecutionBundle(source, NOW)).toThrowError(
      expect.objectContaining({ code: 'execution_risk_data_missing', status: 422 }),
    )
  })

  it('rejects risk data that disagrees with the approved action volume', () => {
    const source = sourceWith([
      action('open-1', 'pending_order', { symbol: 'XAUUSD', type: 'buy_limit', volume: 0.2, price: 2300 }),
    ], [approvedRule('open-1', { risk_amount: 5, risk_percent: 0.1, volume: 0.1 })])
    expect(() => prepareExecutionBundle(source, NOW)).toThrowError(
      expect.objectContaining({ code: 'execution_risk_data_mismatch', status: 422 }),
    )
  })

  it('uses canonical SHA-256 hashes and recovers the same prepared bundle on an idempotent retry', async () => {
    const source = sourceWith([
      action('open-1', 'market_order', { volume: 0.1, side: 'buy', symbol: 'XAUUSD' }),
    ], [approvedRule('open-1', { volume: 0.1, risk_percent: 0.1, risk_amount: 5 })])
    const repository = new MemoryExecutionRepository(source)
    const service = new ExecutionService(repository)
    const first = await service.prepare(42, source.riskDecisionId, NOW)
    const second = await service.prepare(42, source.riskDecisionId, NOW)

    expect(second).toEqual(first)
    expect(repository.persistCalls).toBe(1)
    const afterDeadline = await service.prepare(42, source.riskDecisionId, new Date(NOW.getTime() + 60_000))
    expect(afterDeadline).toEqual(first)
    expect(repository.persistCalls).toBe(1)
    if (first.kind !== 'prepared' || second.kind !== 'prepared') return
    expect(first.operation.id).toBe(second.operation.id)
    expect(first.intents[0]?.idempotencyKey).toBe(sha256Canonical({ riskDecisionId: source.riskDecisionId, actionId: 'open-1' }))
    expect(first.intents[0]?.requestHash).toBe(second.intents[0]?.requestHash)
    expect(first.intents[0]?.expectedStateHash).toBe(sha256Canonical(source.approvedActions[0]!.expectedState))
    expect(executionSourceHash(source)).toBe(first.sourceHash)
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(sha256Canonical({ a: 1, b: 2 }))
  })

  it('rejects an idempotency replay when the approved source revision or hash changes', async () => {
    const source = sourceWith([
      action('open-1', 'market_order', { symbol: 'XAUUSD', side: 'buy', volume: 0.1 }),
    ], [approvedRule('open-1', { risk_amount: 5, risk_percent: 0.1, volume: 0.1 })])
    const repository = new MemoryExecutionRepository(source)
    const service = new ExecutionService(repository)
    await service.prepare(42, source.riskDecisionId, NOW)
    repository.source = { ...source, revision: source.revision + 1, approvedActions: [action('open-1', 'market_order', { symbol: 'XAUUSD', side: 'sell', volume: 0.1 })] }
    repository.sources.set(source.riskDecisionId, repository.source)
    await expect(service.prepare(42, source.riskDecisionId, NOW)).rejects.toMatchObject({ code: 'execution_persistence_conflict', status: 409 })
  })

  it('lets the repository enforce concurrent account reservation capacity', async () => {
    const firstSource = sourceWith([
      action('open-1', 'market_order', { symbol: 'XAUUSD', side: 'buy', volume: 0.1 }),
    ], [approvedRule('open-1', { risk_amount: 5, risk_percent: 0.1, volume: 0.1 })])
    const secondSource = sourceWith([
      action('open-2', 'market_order', { symbol: 'XAUUSD', side: 'buy', volume: 0.1 }),
    ], [approvedRule('open-2', { risk_amount: 5, risk_percent: 0.1, volume: 0.1 })], 'risk-2')
    const repository = new MemoryExecutionRepository(firstSource, 1)
    repository.sources.set(secondSource.riskDecisionId, secondSource)
    const service = new ExecutionService(repository)
    await service.prepare(42, firstSource.riskDecisionId, NOW)
    await expect(service.prepare(42, secondSource.riskDecisionId, NOW)).rejects.toMatchObject({ code: 'execution_capacity_exceeded', status: 409 })
  })

  it('expires only prepared operations and releases their active reservations through the repository boundary', async () => {
    const source = sourceWith([
      action('open-1', 'market_order', { symbol: 'XAUUSD', side: 'buy', volume: 0.1 }),
    ], [approvedRule('open-1', { risk_amount: 5, risk_percent: 0.1, volume: 0.1 })])
    const repository = new MemoryExecutionRepository(source)
    const service = new ExecutionService(repository)
    const prepared = await service.prepare(42, source.riskDecisionId, NOW)
    expect(prepared.kind).toBe('prepared')
    const expired = await service.expire(new Date(NOW.getTime() + PREPARED_EXECUTION_TTL_MS + 1))
    expect(expired).toHaveLength(1)
    expect(expired[0]).toMatchObject({ id: prepared.kind === 'prepared' ? prepared.operation.id : '', status: 'expired' })
    const operation = await service.operation(42, prepared.kind === 'prepared' ? prepared.operation.id : '')
    expect(operation.status).toBe('expired')
    expect(repository.bundles[0]?.reservations[0]?.status).toBe('expired')
  })

  it('keeps execution preparation free of terminal command concerns', () => {
    const source = readFileSync(new URL('../src/modules/execution/domain/execution.ts', import.meta.url), 'utf8').toLowerCase()
    for (const forbidden of ['bridge', 'command.request', 'ordersend']) expect(source).not.toContain(forbidden)
  })
})

class MemoryExecutionRepository implements ExecutionRepository {
  source: ApprovedRiskExecutionSource
  readonly sources = new Map<string, ApprovedRiskExecutionSource>()
  readonly bundles: PreparedExecutionBundle[] = []
  readonly operations = new Map<string, PreparedExecutionBundle>()
  readonly capacity: number
  persistCalls = 0

  constructor(source: ApprovedRiskExecutionSource, capacity = 16) {
    this.source = source
    this.sources.set(source.riskDecisionId, source)
    this.capacity = capacity
  }

  async loadApprovedRiskSource(userId: number, riskDecisionId: string) {
    const source = this.sources.get(riskDecisionId)
    return source?.userId === userId ? source : null
  }

  async replayPreparedExecution(input: { userId: number; accountId: string; riskDecisionId: string; sourceHash: string }) {
    const saved = [...this.operations.values()].find(bundle => bundle.riskDecisionId === input.riskDecisionId)
    if (!saved) return null
    if (saved.operation.userId !== input.userId || saved.operation.accountId !== input.accountId || saved.sourceHash !== input.sourceHash) {
      throw new ExecutionError('execution_persistence_conflict', 409)
    }
    return saved
  }

  async persistPreparedExecution(input: PersistPreparedExecutionInput) {
    this.persistCalls += 1
    const source = this.sources.get(input.riskDecisionId)
    if (!source || source.userId !== input.userId || source.accountId !== input.accountId
      || source.revision !== input.sourceRevision || executionSourceHash(source) !== input.sourceHash) {
      throw new ExecutionError('execution_persistence_conflict', 409)
    }
    const existing = this.operations.get(input.bundle.operation.id)
    if (existing) {
      if (existing.sourceHash !== input.sourceHash) throw new ExecutionError('execution_persistence_conflict', 409)
      return existing
    }
    const activeReservations = this.bundles
      .flatMap(bundle => bundle.reservations)
      .filter(reservation => reservation.status === 'active')
    if (activeReservations.length + input.bundle.reservations.length > this.capacity) throw new ExecutionError('execution_capacity_exceeded', 409)
    this.bundles.push(input.bundle)
    this.operations.set(input.bundle.operation.id, input.bundle)
    return input.bundle
  }

  async getOperation(userId: number, operationId: string): Promise<Operation | null> {
    const bundle = this.operations.get(operationId)
    return bundle?.operation.userId === userId ? bundle.operation : null
  }

  async expirePrepared(input: { now: string; limit: number }) {
    const expired: Operation[] = []
    const now = Date.parse(input.now)
    for (const bundle of this.bundles) {
      if (expired.length >= input.limit || bundle.operation.status !== 'queued' || !bundle.intents.every(intent => intent.status === 'prepared')) continue
      if (Date.parse(bundle.intents[0]!.expiresAt) > now) continue
      bundle.operation = { ...bundle.operation, status: 'expired', errorCode: 'execution_source_expired', updatedAt: input.now, completedAt: input.now, revision: bundle.operation.revision + 1 }
      bundle.intents = bundle.intents.map(intent => ({ ...intent, status: 'expired', errorCode: 'execution_source_expired', updatedAt: input.now, completedAt: input.now, revision: intent.revision + 1 }))
      bundle.reservations = bundle.reservations.map(reservation => ({ ...reservation, status: 'expired', releaseReason: 'execution_source_expired', releasedAt: input.now, updatedAt: input.now, revision: reservation.revision + 1 }))
      this.operations.set(bundle.operation.id, bundle)
      expired.push(bundle.operation)
    }
    return expired
  }
}

function sourceWith(actions: TraderAction[], rules: ApprovedRiskExecutionSource['riskRules'], riskDecisionId = 'risk-1'): ApprovedRiskExecutionSource {
  return {
    riskDecisionId, tradeDecisionId: 'trade-1', userId: 42, accountId: 'account-7', accountCurrency: 'USD',
    status: 'approved', rejectCode: null, platformPolicyVersionId: 'platform-policy-1', accountPolicyVersionId: null,
    policySetRevision: 1, accountRiskRevision: 7, manualReleaseId: null, manualReleaseRevision: null,
    policyHash: 'a'.repeat(64), evaluatedAt: NOW.toISOString(),
    revision: 1, approvedActions: actions, riskRules: rules,
  }
}

function action(actionId: string, kind: TraderAction['kind'], parameters: JsonObject): TraderAction {
  return { actionId, kind, parameters, expectedState: { accountRevision: 7, quoteRevision: 9 } }
}

function approvedRule(actionId: string, details: JsonObject) {
  return { code: 'RISK_ACTION_APPROVED', outcome: 'passed' as const, actionId, details }
}
