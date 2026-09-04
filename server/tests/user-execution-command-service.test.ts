import { describe, expect, it } from 'vitest'
import { UserExecutionCommandService } from '../src/modules/execution/application/user-execution-command-service.js'
import type {
  PersistUserExecutionCommandInput,
  UserExecutionCommandContext,
  UserExecutionCommandRepository,
  UserExecutionIdempotencyLookupInput,
  LoadUserExecutionCommandContextInput,
} from '../src/modules/execution/application/user-execution-command-ports.js'
import type {
  UserExecutionCommandInput,
  UserExecutionCommandResult,
} from '../src/modules/execution/domain/user-execution-command.js'
import {
  DEFAULT_RISK_POLICY,
  resolveRiskPolicy,
  type EffectiveRiskPolicy,
} from '../src/modules/risk/domain/risk.js'

const now = new Date('2026-09-04T08:00:00.000Z')

const currentRevisions = {
  analysis: 0,
  subscription: 0,
  account: 2,
  positions: 3,
  pendingOrders: 4,
  quote: 5,
  contract: 6,
  risk: 7,
}

function makePolicy(accountKillSwitch = false, globalKillSwitch = false): EffectiveRiskPolicy {
  return resolveRiskPolicy({
    accountId: '42',
    userId: 7,
    platformPolicyVersionId: 'platform-1',
    accountPolicyVersionId: 'account-1',
    policySetRevision: 1,
    platform: {
      values: { ...DEFAULT_RISK_POLICY },
      globalKillSwitch,
      revision: 1,
    },
    account: { tradeSendEnabled: true, accountKillSwitch },
    updatedAt: now.toISOString(),
  })
}

function makeContext(overrides: Partial<UserExecutionCommandContext> = {}): UserExecutionCommandContext {
  return {
    userId: 7,
    accountId: '42',
    accountCurrency: 'USD',
    owned: true,
    observer: false,
    tradePermission: true,
    policy: makePolicy(),
    summary: {
      accountId: '42',
      userId: 7,
      businessDate: '2026-09-04',
      equity: '10000',
      freeMargin: '9000',
      marginLevelPercent: 1000,
      dailyLossPercent: 0,
      drawdownPercent: 0,
      openPositions: 1,
      pendingOrders: 1,
      totalVolume: '0.1',
      dailyOpenCount: 0,
      consecutiveLosses: 0,
      terminalTimezoneOffsetMinutes: 0,
      clockStatus: 'calibrated',
      lastSuccessfulOpenAt: null,
      cooldownUntil: null,
      dataComplete: true,
      incompleteReasons: [],
      observedAt: now.toISOString(),
      revision: currentRevisions.risk,
    },
    manualRelease: null,
    quote: {
      symbol: 'XAUUSD',
      bid: '2500',
      ask: '2500.2',
      observedAt: now.toISOString(),
      revision: currentRevisions.quote,
    },
    instrument: {
      symbol: 'XAUUSD',
      point: '0.01',
      tickSize: '0.01',
      tickValue: '1',
      volumeMin: '0.01',
      volumeMax: '100',
      volumeStep: '0.01',
      tradeEnabled: true,
      revision: currentRevisions.contract,
    },
    positions: [
      {
        ticket: '9001',
        symbol: 'XAUUSD',
        side: 'buy',
        volume: '0.1',
        currentPrice: '2500',
        stopLoss: '2490',
        takeProfit: '2520',
        revision: 11,
      },
    ],
    pendingOrders: [
      {
        ticket: '9101',
        symbol: 'XAUUSD',
        type: 'buy_limit',
        price: '2490',
        volume: '0.1',
        stopLoss: '2470',
        takeProfit: '2530',
        revision: 12,
      },
    ],
    currentRevisions: { ...currentRevisions },
    ...overrides,
  }
}

function expected(resourceRevision: number | null = null) {
  return {
    accountRevision: currentRevisions.account,
    positionsRevision: currentRevisions.positions,
    pendingOrdersRevision: currentRevisions.pendingOrders,
    quoteRevision: currentRevisions.quote,
    contractRevision: currentRevisions.contract,
    riskRevision: currentRevisions.risk,
    resourceRevision,
  }
}

function marketInput(idempotencyKey: string): UserExecutionCommandInput {
  return {
    userId: 7,
    accountId: '42',
    commandType: 'market_order',
    idempotencyKey,
    expected: expected(),
    parameters: {
      symbol: 'XAUUSD',
      side: 'buy',
      volume: '0.01',
      stopLoss: '2490',
      takeProfit: null,
      referencePrice: '2500',
      comment: null,
    },
  }
}

function closeInput(idempotencyKey: string): UserExecutionCommandInput {
  return {
    userId: 7,
    accountId: '42',
    commandType: 'close_position',
    idempotencyKey,
    expected: expected(11),
    parameters: { ticket: '9001', volume: null },
  }
}

function cancelInput(idempotencyKey: string): UserExecutionCommandInput {
  return {
    userId: 7,
    accountId: '42',
    commandType: 'cancel_order',
    idempotencyKey,
    expected: expected(12),
    parameters: { ticket: '9101' },
  }
}

function tightenStopInput(idempotencyKey: string): UserExecutionCommandInput {
  return {
    userId: 7,
    accountId: '42',
    commandType: 'modify_position',
    idempotencyKey,
    expected: expected(11),
    parameters: {
      ticket: '9001',
      stopLoss: '2495',
      takeProfit: null,
      removeStopLoss: false,
      removeTakeProfit: false,
    },
  }
}

function takeProfitOnlyInput(idempotencyKey: string): UserExecutionCommandInput {
  return {
    userId: 7,
    accountId: '42',
    commandType: 'modify_position',
    idempotencyKey,
    expected: expected(11),
    parameters: {
      ticket: '9001',
      stopLoss: null,
      takeProfit: '2510',
      removeStopLoss: false,
      removeTakeProfit: false,
    },
  }
}

function widenStopInput(idempotencyKey: string): UserExecutionCommandInput {
  return {
    userId: 7,
    accountId: '42',
    commandType: 'modify_position',
    idempotencyKey,
    expected: expected(11),
    parameters: {
      ticket: '9001',
      stopLoss: '2480',
      takeProfit: null,
      removeStopLoss: false,
      removeTakeProfit: false,
    },
  }
}

function widenPendingStopInput(idempotencyKey: string): UserExecutionCommandInput {
  return {
    userId: 7,
    accountId: '42',
    commandType: 'modify_order',
    idempotencyKey,
    expected: expected(12),
    parameters: {
      ticket: '9101',
      price: null,
      volume: null,
      stopLimitPrice: null,
      stopLoss: '2460',
      takeProfit: null,
      removeStopLoss: false,
      removeTakeProfit: false,
      removeExpiration: false,
      expirationUtcMsc: null,
    },
  }
}

class MemoryUserExecutionCommandRepository implements UserExecutionCommandRepository {
  readonly records: PersistUserExecutionCommandInput[] = []
  private readonly idempotency = new Map<string, { requestHash: string; result: UserExecutionCommandResult }>()

  constructor(public readonly context: UserExecutionCommandContext) {}

  async loadContext(_input: LoadUserExecutionCommandContextInput) {
    return this.context
  }

  async findByIdempotency(input: UserExecutionIdempotencyLookupInput) {
    const row = this.idempotency.get(this.key(input))
    if (!row) return null
    return {
      operation: row.result.operation,
      requestHash: row.requestHash,
      result: row.result,
    }
  }

  async persistCommand(input: PersistUserExecutionCommandInput) {
    this.records.push(input)
    this.idempotency.set(this.key({
      userId: input.command.userId,
      accountId: input.command.accountId,
      idempotencyKey: input.command.idempotencyKey,
    }), { requestHash: input.command.requestHash, result: input.result })
    return input.result
  }

  private key(input: UserExecutionIdempotencyLookupInput) {
    return `${input.userId}:${input.accountId}:${input.idempotencyKey}`
  }
}

describe('UserExecutionCommandService', () => {
  it('replays the same idempotent command and rejects a same-key different request', async () => {
    const repository = new MemoryUserExecutionCommandRepository(makeContext())
    const service = new UserExecutionCommandService(repository)
    const first = await service.execute(marketInput('market-replay-01'), now)
    const replay = await service.execute(marketInput('market-replay-01'), now)

    expect(replay).toBe(first)
    expect(repository.records).toHaveLength(1)

    const conflicting: UserExecutionCommandInput = {
      ...marketInput('market-replay-01'),
      parameters: {
        ...marketInput('market-replay-01').parameters,
        referencePrice: '2499',
      },
    }
    await expect(service.execute(conflicting, now)).rejects.toMatchObject({
      code: 'idempotency_conflict',
      status: 409,
    })
    expect(repository.records).toHaveLength(1)
  })

  it('rejects observer and trade-permission contexts before risk or persistence', async () => {
    const observerRepository = new MemoryUserExecutionCommandRepository(makeContext({ observer: true }))
    await expect(new UserExecutionCommandService(observerRepository).execute(marketInput('observer-0001'), now))
      .rejects.toMatchObject({ code: 'user_command_observer_forbidden', status: 403 })
    expect(observerRepository.records).toHaveLength(0)

    const permissionRepository = new MemoryUserExecutionCommandRepository(makeContext({ tradePermission: false }))
    await expect(new UserExecutionCommandService(permissionRepository).execute(marketInput('permission-01'), now))
      .rejects.toMatchObject({ code: 'user_command_trade_permission_required', status: 409 })
    expect(permissionRepository.records).toHaveLength(0)
  })

  it('rejects stale collection and exact resource revisions before persistence', async () => {
    const collectionRepository = new MemoryUserExecutionCommandRepository(makeContext({
      currentRevisions: { ...currentRevisions, positions: currentRevisions.positions + 1 },
    }))
    await expect(new UserExecutionCommandService(collectionRepository).execute(marketInput('stale-list-01'), now))
      .rejects.toMatchObject({ code: 'user_command_expected_state_stale', status: 409 })
    expect(collectionRepository.records).toHaveLength(0)

    const resourceContext = makeContext()
    resourceContext.positions[0] = { ...resourceContext.positions[0], revision: 10 }
    const resourceRepository = new MemoryUserExecutionCommandRepository(resourceContext)
    await expect(new UserExecutionCommandService(resourceRepository).execute(closeInput('stale-row-01'), now))
      .rejects.toMatchObject({ code: 'user_command_target_stale', status: 409 })
    expect(resourceRepository.records).toHaveLength(0)
  })

  it('approves a market order with the actual account currency and creates one risk reservation', async () => {
    const repository = new MemoryUserExecutionCommandRepository(makeContext())
    const result = await new UserExecutionCommandService(repository).execute(marketInput('market-approved-01'), now)

    expect(result.kind).toBe('prepared')
    if (result.kind !== 'prepared') return
    expect(result.reservations).toHaveLength(1)
    expect(result.reservations[0]?.accountCurrency).toBe('USD')
    expect(result.reservations[0]?.reservedVolume).toBeCloseTo(0.01)
    expect(result.intent.riskReservationId).toBe(result.reservations[0]?.id)
    expect(repository.records).toHaveLength(1)
  })

  it('allows close, cancel, and a stop-loss tightening while the account kill switch is on', async () => {
    const repository = new MemoryUserExecutionCommandRepository(makeContext({ policy: makePolicy(true) }))
    const service = new UserExecutionCommandService(repository)

    const close = await service.execute(closeInput('kill-close-01'), now)
    const cancel = await service.execute(cancelInput('kill-cancel-01'), now)
    const tighten = await service.execute(tightenStopInput('kill-tighten-01'), now)

    expect(close.kind).toBe('prepared')
    expect(cancel.kind).toBe('prepared')
    expect(tighten.kind).toBe('prepared')
    expect(repository.records).toHaveLength(3)
  })

  it('persists stop-loss widening as a rejected terminal operation without an intent or reservation', async () => {
    const repository = new MemoryUserExecutionCommandRepository(makeContext())
    const result = await new UserExecutionCommandService(repository).execute(widenStopInput('widen-stop-01'), now)

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.operation.status).toBe('rejected')
    expect(result.operation.errorCode).toBeTruthy()
    expect(result.intent).toBeNull()
    expect(result.reservations).toHaveLength(0)
    expect(repository.records).toHaveLength(1)
    expect(repository.records[0]?.result).toBe(result)
  })

  it('persists widening a pending-order stop as a rejected terminal operation', async () => {
    const repository = new MemoryUserExecutionCommandRepository(makeContext())
    const result = await new UserExecutionCommandService(repository).execute(widenPendingStopInput('widen-pending-01'), now)

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.operation.status).toBe('rejected')
    expect(result.intent).toBeNull()
    expect(result.reservations).toHaveLength(0)
    expect(repository.records).toHaveLength(1)
  })

  it('allows a take-profit-only position modification', async () => {
    const repository = new MemoryUserExecutionCommandRepository(makeContext())
    const result = await new UserExecutionCommandService(repository).execute(takeProfitOnlyInput('tp-only-01'), now)

    expect(result.kind).toBe('prepared')
    if (result.kind !== 'prepared') return
    expect(result.intent.action.kind).toBe('modify_position')
    expect(result.intent.action.parameters.take_profit).toBe('2510')
    expect(repository.records).toHaveLength(1)
  })
})
