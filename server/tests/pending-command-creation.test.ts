import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createBridgeCommand } from '../src/modules/execution/index.js'
import { ExecutionError, sha256Canonical } from '../src/modules/execution/domain/execution.js'
import { MysqlBridgeCommandRepository } from '../src/modules/execution/infrastructure/mysql-bridge-command-repository.js'
import { DEFAULT_RISK_POLICY, resolveRiskPolicy } from '../src/modules/risk/index.js'

const now = new Date('2026-09-11T00:00:00.000Z')
const command = createBridgeCommand({ executionIntentId: '11111111-1111-4111-8111-111111111111', commandSequence: 1,
  userId: 7, accountId: '11', terminalProfileId: 'profile_12345678',
  route: { terminalInstanceId: 'terminal_12345678', brokerServer: 'Broker', login: '123', connectionEpoch: 3 }, action: 'order.place',
  params: { symbol: 'XAUUSD', direction: 'buy', order_type: 'buy_limit', price: '2500', volume: '0.01', magic: 7, deviation: 20 },
  expectedState: null, deadlineAt: '2026-09-11T00:00:30.000Z' }, now)
const action = { actionId: 'a1', kind: 'pending_order', parameters: { symbol: 'XAUUSD', type: 'buy_limit', price: '2500', volume: '0.01' }, expectedState: {} }
const policy = resolveRiskPolicy({ userId: 7, accountId: '11', platformPolicyVersionId: '1', accountPolicyVersionId: null, policySetRevision: 1,
  platform: { values: DEFAULT_RISK_POLICY, globalKillSwitch: false, revision: 1 }, account: { tradeSendEnabled: true }, updatedAt: now.toISOString() })

function fixture(reject: boolean, wired = true) {
  const trace: string[] = []
  const execute = vi.fn(async (sql: string) => {
    trace.push(sql.startsWith('INSERT') ? 'insert' : 'read')
    if (sql.startsWith('SELECT id FROM trading_accounts') || sql.startsWith('SELECT a.id FROM trading_accounts')) return [[{ id: '11' }]]
    if (sql.includes('FROM bridge_commands_v4 c') || sql.startsWith('SELECT id FROM bridge_commands_v4')) return [[]]
    if (sql.startsWith('SELECT id,operation_id')) return [[{ id: command.executionIntentId, operation_id: 'op', user_id: 7,
      trading_account_id: '11', action_kind: 'pending_order', source_type: 'risk_decision', source_id: 'risk', status: 'prepared', revision: 1,
      expires_at_utc: new Date('2026-09-11T00:01:00.000Z') }]]
    if (sql.startsWith('SELECT action_json')) return [[{ action_json: action, action_sha256: sha256Canonical(action) }]]
    if (sql.startsWith('INSERT')) return [{ affectedRows: 1 }]
    throw Error('unexpected_sql')
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  const review = vi.fn(async () => { trace.push('review'); if (reject) throw new ExecutionError('execution_duplicate_live_pending', 409) })
  const repository = new MysqlBridgeCommandRepository({ getConnection: async () => connection } as unknown as Pool,
    () => { throw Error('unexpected_clock') }, () => ({ getEffectivePolicy: async () => policy }),
    undefined, undefined, undefined, undefined, undefined, wired ? () => ({ review }) : undefined)
  return { repository, connection, review, trace }
}

it('rolls back a duplicate before inserting command, payload, event or outbox', async () => {
  const f = fixture(true)
  await expect(f.repository.create(command)).rejects.toMatchObject({ code: 'execution_duplicate_live_pending' })
  expect(f.review).toHaveBeenCalledWith(command, policy, now)
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.commit).not.toHaveBeenCalled()
  expect(f.trace).not.toContain('insert')
})

it('performs the same review before committing an eligible pending command', async () => {
  const f = fixture(false)
  await expect(f.repository.create(command)).resolves.toEqual(command)
  expect(f.trace.indexOf('review')).toBeLessThan(f.trace.indexOf('insert'))
  expect(f.connection.commit).toHaveBeenCalledOnce()
})

it('refuses unwired pending creation without writing a partial command', async () => {
  const f = fixture(false, false)
  await expect(f.repository.create(command)).rejects.toMatchObject({ code: 'execution_pending_review_unavailable' })
  expect(f.trace).not.toContain('insert')
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})
