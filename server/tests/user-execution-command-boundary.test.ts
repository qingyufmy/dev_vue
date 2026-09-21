import { createTransactionAccountClock } from '../src/modules/trading/composition.js'
import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import {
  buildPreparedUserExecutionBundle,
  buildRejectedUserExecutionResult,
  normalizeUserExecutionCommand,
  userCommandAction,
  type NormalizedUserExecutionCommand,
  type UserExecutionCommandResult,
  type UserExecutionOperation,
} from '../src/modules/execution/domain/user-execution-command.js'
import { MysqlUserExecutionCommandRepository } from '../src/modules/execution/infrastructure/mysql-user-execution-command-repository.js'
import { resolveRiskPolicy, riskPolicyHash, DEFAULT_RISK_POLICY, type EffectiveRiskPolicy, type RiskEvaluationResult } from '../src/modules/risk/domain/risk.js'

const now = new Date('2026-09-04T08:00:00.000Z')
const revisions = { account: 2, positions: 3, pendingOrders: 4, quote: 5, contract: 6, risk: 7 }

function policy(): EffectiveRiskPolicy {
  return resolveRiskPolicy({
    accountId: '42', userId: 7, platformPolicyVersionId: '1', accountPolicyVersionId: null, policySetRevision: 0,
    platform: { values: { ...DEFAULT_RISK_POLICY, maxOrderVolume: 0.1 }, globalKillSwitch: false, revision: 1 }, account: null, updatedAt: now.toISOString(),
  })
}

function closeCommand(userId = 7, accountId = '42', idempotencyKey = `close-${userId}-0001`) {
  return normalizeUserExecutionCommand({
    userId, accountId, commandType: 'close_position', idempotencyKey,
    expected: { accountRevision: revisions.account, positionsRevision: revisions.positions, pendingOrdersRevision: revisions.pendingOrders, quoteRevision: revisions.quote, contractRevision: revisions.contract, riskRevision: revisions.risk, resourceRevision: 11 },
    parameters: { ticket: '9001', volume: null },
  }, `cmd-${userId}-9001`)
}

function marketCommand(symbol = 'XAUUSD') {
  return normalizeUserExecutionCommand({
    userId: 7, accountId: '42', commandType: 'market_order', idempotencyKey: 'market-7-0001',
    expected: { accountRevision: revisions.account, positionsRevision: revisions.positions, pendingOrdersRevision: revisions.pendingOrders, quoteRevision: revisions.quote, contractRevision: revisions.contract, riskRevision: revisions.risk, resourceRevision: null },
    parameters: { symbol, side: 'buy', volume: '0.1', stopLoss: '2490', takeProfit: null, referencePrice: '2500', comment: null },
  }, 'cmd-7-market')
}

it('preserves broker symbol case through command normalization and action conversion', () => {
  const command = marketCommand('XAUUSD.a')
  expect(userCommandAction(command).parameters.symbol).toBe('XAUUSD.a')
  expect(command.requestHash).not.toBe(marketCommand('XAUUSD.A').requestHash)
})

function evaluation(command: NormalizedUserExecutionCommand, status: RiskEvaluationResult['status'], action = userCommandAction(command)): RiskEvaluationResult {
  return {
    status, rejectCode: status === 'rejected' ? 'RISK_ACCOUNT_KILL_SWITCH' : null,
    rules: status === 'rejected'
      ? [{ code: 'RISK_ACCOUNT_KILL_SWITCH', outcome: 'rejected', actionId: action.actionId, details: {} }]
      : command.commandType === 'market_order'
        ? [{ code: 'RISK_ACTION_APPROVED', outcome: 'passed', actionId: action.actionId, details: { risk_amount: 10, risk_percent: 0.1, volume: 0.1 } }]
        : [],
    approvedActions: status === 'approved' ? [action] : [], evaluatedAt: now.toISOString(), policyHash: riskPolicyHash(policy()), manualReleaseId: null, manualReleaseRevision: null,
  }
}

interface FakeOptions {
  targetPayloadRevision?: number
  revisionRow?: Partial<typeof revisions>
  existing?: unknown[]
}

function fakePool(options: FakeOptions = {}) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  const revisionRow = { ...revisions, ...(options.revisionRow ?? {}) }
  const execute = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params })
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.includes('from trading_accounts') && normalized.includes('for update')) return [[{ account_id: '42', currency: 'USD' }], []]
    if (normalized.includes('from trading_account_ownerships') && normalized.includes('select 1')) return [[{ 1: 1 }], []]
    if (normalized.includes('from trading_contexts')) return [[{ mode: 'full', read_only: 0 }], []]
    if (normalized.includes('from account_runtime_snapshots') && normalized.includes('trade_permission') && normalized.includes('for share')) return [[{ trade_permission: 1, revision: revisionRow.account }], []]
    if (normalized.includes('from user_execution_commands c')) return [options.existing ?? [], []]
    if (normalized.includes('from open_position_snapshots') && normalized.includes('for update')) {
      return [[{ ticket: '9001', revision: 11, payload_json: JSON.stringify({ ticket: '9001', symbol: 'XAUUSD', revision: options.targetPayloadRevision ?? 11, side: 'buy', volume: '0.1', currentPrice: '2500' }) }], []]
    }
    if (normalized.includes('select revision from trading_projection_revisions') || normalized.includes('account_projection_revision')) {
      return [[{
        account_projection_revision: revisionRow.account, account_snapshot_revision: revisionRow.account, positions_revision: revisionRow.positions,
        pending_orders_revision: revisionRow.pendingOrders, quote_revision: revisionRow.quote, quote_projection_revision: revisionRow.quote,
        contract_revision: revisionRow.contract, risk_summary_revision: revisionRow.risk, risk_state_revision: revisionRow.risk,
      }], []]
    }
    if (normalized.includes('from risk_policy_sets_v4')) {
      if (normalized.includes("p.scope='platform'")) return [[{ scope: 'platform', set_revision: 0, version_id: '1', policy_json: '{"maxOrderVolume":0.1}', updated_at_utc: now }], []]
      return [[], []]
    }
    if (normalized.includes('from global_risk_controls')) return [[{ kill_switch: 0, revision: 1 }], []]
    if (normalized.startsWith('select') && normalized.includes('from risk_manual_releases')) return [[], []]
    if (normalized.includes('from account_risk_states') && normalized.includes('open_positions')) return [[{ open_positions: 0, pending_orders: 0, total_volume: '0', daily_open_count: 0 }], []]
    if (normalized.includes('sum(reserved_volume)')) return [[{ reserved_volume: '0', reserved_open_positions: '0', reserved_pending_orders: '0', reserved_daily_opens: '0' }], []]
    return [{ affectedRows: 1, insertId: 1 }, []]
  })
  const connection = {
    execute,
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
  } as unknown as PoolConnection
  const pool = { getConnection: vi.fn(async () => connection), execute } as unknown as Pool
  return { pool, connection, execute, calls }
}

function prepared(command: NormalizedUserExecutionCommand): UserExecutionCommandResult {
  const action = userCommandAction(command)
  const riskEvaluation = evaluation(command, 'approved', action)
  return buildPreparedUserExecutionBundle({ command, action, riskEvaluation, accountCurrency: 'USD', operationId: `op-${command.userId}-9001`, intentId: `intent-${command.userId}-9001`, now })
}

describe('user execution command MySQL boundary', () => {
  it('does not reapply the per-order strategy limit to a manual command', async () => {
    const command = marketCommand()
    if (!('volume' in command.parameters)) throw new Error('fixture requires volume')
    command.parameters.volume = '0.2'
    const result = prepared(command)
    const fake = fakePool()
    const repository = new MysqlUserExecutionCommandRepository(fake.pool, createTransactionAccountClock)
    await expect(repository.persistCommand({ command, action: userCommandAction(command), riskEvaluation: result.riskEvaluation, result, expected: command.expected }))
      .resolves.toBe(result)
    expect(fake.calls.some(call => /^\s*INSERT INTO operations/i.test(call.sql))).toBe(true)
  })

  it('locks the account first and persists an approved command, intent, payload, events and outbox atomically', async () => {
    const command = closeCommand()
    const result = prepared(command)
    const fake = fakePool()
    const repository = new MysqlUserExecutionCommandRepository(fake.pool, createTransactionAccountClock)

    await expect(repository.persistCommand({ command, action: userCommandAction(command), riskEvaluation: result.riskEvaluation, result, expected: command.expected })).resolves.toBe(result)

    const first = fake.calls.findIndex(call => call.sql.toLowerCase().includes('from trading_accounts') && call.sql.toLowerCase().includes('for update'))
    const owner = fake.calls.findIndex(call => call.sql.toLowerCase().includes('from trading_account_ownerships') && call.sql.toLowerCase().includes('select 1'))
    expect(first).toBe(0)
    expect(owner).toBe(1)
    expect(fake.connection.beginTransaction).toHaveBeenCalledOnce()
    expect(fake.connection.commit).toHaveBeenCalledOnce()
    expect(fake.connection.rollback).not.toHaveBeenCalled()
    expect(fake.calls.some(call => /^\s*INSERT INTO operations/i.test(call.sql))).toBe(true)
    expect(fake.calls.some(call => /^\s*INSERT INTO user_execution_commands/i.test(call.sql))).toBe(true)
    expect(fake.calls.some(call => /^\s*INSERT INTO execution_intents/i.test(call.sql))).toBe(true)
    expect(fake.calls.filter(call => /INSERT INTO outbox_events/i.test(call.sql))).toHaveLength(2)
    const intentInsert = fake.calls.find(call => /INSERT INTO execution_intents/i.test(call.sql))
    expect(intentInsert?.sql).toContain('user_command_id')
    expect(intentInsert?.params.slice(2, 5)).toEqual([null, null, command.commandId])
  })

  it('persists deterministic risk rejection as terminal audit state without intent or reservation', async () => {
    const command = closeCommand()
    const action = userCommandAction(command)
    const riskEvaluation = evaluation(command, 'rejected', action)
    const result = buildRejectedUserExecutionResult({ command, riskEvaluation, operationId: 'op-rejected-9001', now })
    const fake = fakePool()
    const repository = new MysqlUserExecutionCommandRepository(fake.pool, createTransactionAccountClock)

    await expect(repository.persistCommand({ command, action, riskEvaluation, result, expected: command.expected })).resolves.toBe(result)
    expect(result.operation.kind).toBe('user_execution_command')
    expect(result.operation.status).toBe('rejected')
    expect(result.intent).toBeNull()
    expect(fake.calls.some(call => /INSERT INTO operations/i.test(call.sql))).toBe(true)
    expect(fake.calls.some(call => /INSERT INTO user_execution_commands/i.test(call.sql))).toBe(true)
    expect(fake.calls.some(call => /INSERT INTO execution_intents/i.test(call.sql))).toBe(false)
    expect(fake.calls.some(call => /risk_reservations_v4/i.test(call.sql) && /INSERT/i.test(call.sql))).toBe(false)
    expect(fake.calls.filter(call => /INSERT INTO outbox_events/i.test(call.sql))).toHaveLength(1)
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('fails closed when exact ticket payload revision disagrees with row revision', async () => {
    const command = closeCommand()
    const result = prepared(command)
    const fake = fakePool({ targetPayloadRevision: 10 })
    const repository = new MysqlUserExecutionCommandRepository(fake.pool, createTransactionAccountClock)

    await expect(repository.persistCommand({ command, action: userCommandAction(command), riskEvaluation: result.riskEvaluation, result, expected: command.expected })).rejects.toMatchObject({ code: 'user_command_target_stale', status: 409 })
    expect(fake.connection.rollback).toHaveBeenCalledOnce()
    expect(fake.calls.some(call => /INSERT INTO operations/i.test(call.sql))).toBe(false)
  })

  it('rechecks collection revisions inside the transaction', async () => {
    const command = closeCommand()
    const result = prepared(command)
    const fake = fakePool({ revisionRow: { positions: 4 } })
    const repository = new MysqlUserExecutionCommandRepository(fake.pool, createTransactionAccountClock)

    await expect(repository.persistCommand({ command, action: userCommandAction(command), riskEvaluation: result.riskEvaluation, result, expected: command.expected })).rejects.toMatchObject({ code: 'user_command_expected_state_stale', status: 409 })
    expect(fake.connection.rollback).toHaveBeenCalledOnce()
  })

  it('scopes the operations idempotency key by user and account instead of the raw client key', () => {
    const first = prepared(closeCommand(7, '42', 'same-client-key'))
    const second = prepared(closeCommand(8, '42', 'same-client-key'))
    expect(first.operation.clientIdempotencyKey).toBe(second.operation.clientIdempotencyKey)
    expect(first.operation.idempotencyKey).not.toBe(second.operation.idempotencyKey)
    expect(first.operation.idempotencyScope).toBe('user_command')
  })

  it('locks risk capacity and active reservations before persisting a new exposure', async () => {
    const command = marketCommand()
    const result = prepared(command)
    const fake = fakePool()
    const repository = new MysqlUserExecutionCommandRepository(fake.pool, createTransactionAccountClock)

    await repository.persistCommand({ command, action: userCommandAction(command), riskEvaluation: result.riskEvaluation, result, expected: command.expected })
    const capacity = fake.calls.findIndex(call => /FROM account_risk_states/i.test(call.sql) && /FOR UPDATE/i.test(call.sql))
    const active = fake.calls.findIndex(call => /SUM\(reserved_volume\)/i.test(call.sql) && /FOR UPDATE/i.test(call.sql))
    const operation = fake.calls.findIndex(call => /INSERT INTO operations/i.test(call.sql))
    expect(capacity).toBeGreaterThan(0)
    expect(active).toBeGreaterThan(capacity)
    expect(operation).toBeGreaterThan(active)
  })
})
