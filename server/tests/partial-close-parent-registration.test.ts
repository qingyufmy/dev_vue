import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { createBridgeCommand } from '../src/modules/execution/domain/bridge-command.js'
import { buildPartialClosePlan } from '../src/modules/execution/domain/partial-close-plan.js'
import { sha256Canonical } from '../src/modules/execution/domain/execution.js'
import type { ExecutionAction } from '../src/modules/execution/domain/execution-input.js'
import { MysqlBridgeCommandRepository } from '../src/modules/execution/infrastructure/mysql-bridge-command-repository.js'
import { readPartialCloseParentDispatch } from '../src/modules/execution/infrastructure/mysql-partial-close-parent-dispatch.js'
import { bindPartialCloseDispatchReview, partialCloseDispatchRiskRequest } from '../src/modules/execution/domain/partial-close-dispatch-review.js'

const now = new Date('2026-09-10T00:00:00.000Z'), expires = now.getTime() + 60_000
describe('parent dispatch risk receipt binding', () => {
  function binding() {
    const { command, action } = fixture(), plan = buildPartialClosePlan(command,action,expires)!
    const request = partialCloseDispatchRiskRequest(plan,command)
    const review = { status: 'approved' as 'approved' | 'rejected', rejectCode: null as string | null,
      requestHash: sha256Canonical(request), contextHash: 'a'.repeat(64), policyHash: 'b'.repeat(64),
      evaluatedAt: now.toISOString(), volume: '0.08', remainingVolume: '0.02' }
    return { command, plan, review, bind: (at = now) => bindPartialCloseDispatchReview(plan,command,review,at) }
  }
  it('binds exact command, plan and risk hashes without approving a future protection action', () => {
    const f = binding(), result = f.bind()
    expect(result).toMatchObject({ commandId: f.command.id, commandHash: f.command.requestHash, planHash: sha256Canonical(f.plan), review: f.review })
    expect(result.request).not.toHaveProperty('protection')
    f.review.contextHash = 'c'.repeat(64)
    expect(result.review.contextHash).toBe('a'.repeat(64))
  })
  it.each(['request', 'rejected', 'volume', 'remaining', 'context', 'policy', 'revision', 'status'])('rejects invalid %s binding', field => {
    const f = binding()
    if (field === 'request') f.review.requestHash = '0'.repeat(64)
    if (field === 'rejected') { f.review.status = 'rejected'; f.review.rejectCode = 'RISK_ACCOUNT_KILL_SWITCH' }
    if (field === 'volume') f.review.volume = '0.07'
    if (field === 'remaining') f.review.remainingVolume = '0.03'
    if (field === 'context') f.review.contextHash = 'invalid'
    if (field === 'policy') f.review.policyHash = 'invalid'
    if (field === 'revision') f.command.revision++
    if (field === 'status') f.command.status = 'dispatched'
    expect(() => f.bind()).toThrow('partial_close_dispatch_review_invalid')
  })
  it.each([-1, 5001, 60000])('rejects future, stale or expired review at delta %s', delta => {
    const f = binding()
    expect(() => f.bind(new Date(now.getTime() + delta))).toThrow('partial_close_dispatch_review_invalid')
  })
})
describe('parent dispatch registration and current target', () => {
  function dispatchFixture() {
    const { command, action } = fixture(), plan = buildPartialClosePlan(command, action, expires)!, planHash = sha256Canonical(plan)
    const row = { id: plan.workflowId, parent_intent_id: command.executionIntentId, parent_command_id: command.id,
      user_id: command.userId, account_id: command.accountId, plan_json: plan, plan_sha256: planHash, status: 'awaiting_close', revision: 1 }
    const payload = { planHash, parentIntentId: plan.parentIntentId, parentCommandId: plan.parentCommandId }
    const event = { revision: 1, event_type: 'registered', payload_json: payload, payload_sha256: sha256Canonical(payload) }
    const query = vi.fn().mockResolvedValue([[{ zone: '+00:00', now_msc: now.getTime() + 1 }]])
    const execute = vi.fn().mockResolvedValueOnce([[row]]).mockResolvedValueOnce([[event]])
    const read = vi.fn().mockResolvedValue({ target: plan.target, revision: plan.initialRevision, volume: plan.initialVolume })
    return { row, event, read, query, command, plan,
      run: () => readPartialCloseParentDispatch({ query, execute } as unknown as PoolConnection, command, action, expires, { read }) }
  }
  it('checks frozen audit and requires a fresh reader at the original exact target revision', async () => {
    const f = dispatchFixture()
    expect(await f.run()).toEqual({ plan: f.plan, planHash: sha256Canonical(f.plan), evaluatedAt: now.getTime() + 1 })
    expect(f.read).toHaveBeenCalledWith({ target: f.plan.target, revision: f.plan.initialRevision, connectionEpoch: f.command.route.connectionEpoch })
  })
  it.each(['plan', 'status', 'owner', 'revision', 'audit'])('rejects changed %s before requesting current facts', async field => {
    const f = dispatchFixture()
    if (field === 'plan') f.row.plan_sha256 = '0'.repeat(64)
    if (field === 'status') f.row.status = 'protecting'
    if (field === 'owner') f.row.user_id++
    if (field === 'revision') f.row.revision++
    if (field === 'audit') f.event.payload_sha256 = '0'.repeat(64)
    await expect(f.run()).rejects.toThrow()
    expect(f.read).not.toHaveBeenCalled()
  })
  it.each(['missing', 'volume', 'revision', 'identity'])('rejects changed current %s', async field => {
    const f = dispatchFixture(), current = { target: { ...f.plan.target }, volume: f.plan.initialVolume, revision: f.plan.initialRevision }
    if (field === 'volume') current.volume = '0.09'
    if (field === 'revision') current.revision++
    if (field === 'identity') current.target.positionIdentifier = '999'
    f.read.mockResolvedValue(field === 'missing' ? null : current)
    await expect(f.run()).rejects.toMatchObject({ code: 'partial_close_dispatch_target_changed' })
  })
  it.each(['zone', 'future-issued', 'expired'])('rejects invalid %s clock before reading facts', async field => {
    const f = dispatchFixture()
    f.query.mockResolvedValue([[{ zone: field === 'zone' ? '+08:00' : '+00:00', now_msc: field === 'expired' ? expires : now.getTime() - 1 }]])
    await expect(f.run()).rejects.toMatchObject({ code: 'partial_close_dispatch_clock_or_deadline_invalid' })
    expect(f.read).not.toHaveBeenCalled()
  })
})
function fixture() {
  const action: ExecutionAction = { actionId: 'close', kind: 'close_position', parameters: { ticket: '101', volume: '0.08',
    after_close_protection: { stop_loss: '2400' }, after_close_target: { position_identifier: '100', initial_volume: '0.10', positions_revision: 3 } },
  expectedState: { positionsRevision: 3 } }
  const command = createBridgeCommand({ executionIntentId: '11111111-1111-4111-8111-111111111111', commandSequence: 1,
    userId: 7, accountId: '5', terminalProfileId: 'profile_12345678',
    route: { terminalInstanceId: 'terminal_12345678', brokerServer: 'Broker', login: '42', connectionEpoch: 1 },
    action: 'position.close', params: { ticket: '101', volume: '0.08', deviation: 20 },
    expectedState: { ticket: '101', symbol: 'XAUUSD', direction: 'buy', volume: '0.10', order_type: 'market', magic: 0,
      open_price: '2450', stop_limit_price: null, stop_loss: null, take_profit: null, expiration_utc_msc: null }, deadlineAt: new Date(expires).toISOString() }, now)
  return { action, command }
}
describe('frozen parent close plan', () => {
  it('derives a stable workflow identity while preserving original prices and the intent deadline', () => {
    const f = fixture(), plan = buildPartialClosePlan(f.command, f.action, expires)!
    expect(plan.target).toMatchObject({ userId: '7', accountId: '5', positionIdentifier: '100', ticket: '101', side: 'buy' })
    expect(plan).toMatchObject({ initialVolume: '0.10', closeVolume: '0.08', initialRevision: 3, expiresAt: expires, protection: { stopLoss: '2400' } })
    expect(buildPartialClosePlan(f.command, structuredClone(f.action), expires)).toEqual(plan)
    f.action.parameters.after_close_protection = { stop_loss: '2401' }
    const changed = buildPartialClosePlan(f.command, f.action, expires)!
    expect(changed.workflowId).toBe(plan.workflowId)
    expect(sha256Canonical(changed)).not.toBe(sha256Canonical(plan))
    expect(f.command.request.payload.params).toEqual({ ticket: '101', volume: '0.08', deviation: 20 })
  })
  it.each(['target', 'revision', 'quantity', 'ticket', 'full-close', 'wire-fields', 'deadline', 'price'])('rejects corrupted compiled %s', failure => {
    const f = fixture()
    let deadline = expires
    if (failure === 'target') delete f.action.parameters.after_close_target
    if (failure === 'revision') f.action.expectedState.positionsRevision = 4
    if (failure === 'quantity') f.action.parameters.volume = '0.07'
    if (failure === 'ticket') f.action.parameters.ticket = '102'
    if (failure === 'full-close') { f.action.parameters.volume = '0.10'; f.command.request.payload.params.volume = '0.10' }
    if (failure === 'wire-fields') f.command.request.payload.params.after_close_protection = { stop_loss: '2400' }
    if (failure === 'deadline') deadline--
    if (failure === 'price') f.action.parameters.after_close_protection = { stop_loss: null }
    expect(() => buildPartialClosePlan(f.command, f.action, deadline)).toThrow('partial_close_compiled_intent_invalid')
  })
  it('leaves ordinary closes alone but rejects orphaned server metadata', () => {
    const f = fixture()
    delete f.action.parameters.after_close_protection
    expect(() => buildPartialClosePlan(f.command, f.action, expires)).toThrow()
    delete f.action.parameters.after_close_target
    expect(buildPartialClosePlan(f.command, f.action, expires)).toBeNull()
  })
})

function repositoryFixture(options: { enabled?: boolean; failRegistration?: boolean; failOutbox?: boolean; existing?: boolean; positionWorkflow?: boolean;
  dispatch?: boolean; failDispatch?: boolean; failCommandUpdate?: boolean } = {}) {
  const f = fixture(), trace: string[] = [], writes: string[] = []
  const c = f.command
  const saved = { id: c.id, execution_intent_id: c.executionIntentId, command_sequence: 1, user_id: c.userId, trading_account_id: c.accountId,
    terminal_profile_id: c.terminalProfileId, terminal_instance_id: c.route.terminalInstanceId, broker_server: c.route.brokerServer,
    account_login: c.route.login, connection_epoch: 1, action: c.action, idempotency_key: c.idempotencyKey, request_sha256: c.requestHash,
    status: c.status, issued_at_utc: now, deadline_at_utc: new Date(expires), dispatched_at_utc: null, accepted_at_utc: null, completed_at_utc: null,
    error_code: null, terminal_code: null, result_sha256: null, result_message_id: null, revision: 1, created_at_utc: now, updated_at_utc: now, request_envelope_json: c.request }
  const connection = {
    beginTransaction: vi.fn(async () => { trace.push('begin') }),
    commit: vi.fn(async () => { trace.push('commit') }),
    rollback: vi.fn(async () => { trace.push('rollback'); writes.length = 0 }), release: vi.fn(),
    execute: vi.fn(async (sql: string) => {
      if (sql.startsWith('UPDATE')) {
        if (sql.startsWith('UPDATE bridge_commands_v4')) {
          if (options.failCommandUpdate) throw new Error('command_update_failed')
          saved.status = 'dispatched'; saved.revision = 2
        }
        trace.push(sql.startsWith('UPDATE bridge_commands_v4') ? 'command_update' : 'intent_update')
        return [{ affectedRows: 1 }]
      }
      if (sql.startsWith('INSERT')) {
        const table = /INSERT INTO (\w+)/.exec(sql)![1]!
        if (table === 'outbox_events' && options.failOutbox) throw new Error('outbox_failed')
        writes.push(table); trace.push(table); return [{ affectedRows: 1 }]
      }
      if (sql.includes('action_json,action_sha256')) return [[{ action_json: f.action, action_sha256: sha256Canonical(f.action) }]]
      if (sql.includes('COUNT(*) quantity')) return [[{ status: 'dispatching', quantity: 1 }]]
      if (sql.includes('FROM operations') || sql.includes('FROM execution_distribution_targets')) return [[]]
      if (sql.includes('FROM execution_intents')) return [[{ id: f.command.executionIntentId, user_id: 7, trading_account_id: '5',
        source_type: options.positionWorkflow ? 'position_workflow' : 'user_command',
        action_kind: 'close_position', status: 'prepared', expires_at_utc: new Date(expires) }]]
      if (sql.includes('bridge_trade_state_snapshots_v4')) return [[{ terminal_instance_id: f.command.route.terminalInstanceId, connection_epoch: 1,
        projection_revision: 3, state_json: f.command.request.payload.expected_state, state_sha256: sha256Canonical(f.command.request.payload.expected_state) }]]
      if (sql.includes('FROM bridge_commands_v4')) return [options.existing && !sql.includes('execution_intent_id<>?') ? [saved] : []]
      if (sql.includes('FROM trading_accounts')) return [[{ id: '5' }]]
      throw new Error(`unexpected_sql:${sql}`)
    }),
  }
  const capture = vi.fn(async () => {
    trace.push('capture')
    return async (actual: PoolConnection, plan: ReturnType<typeof buildPartialClosePlan>) => {
      expect(actual).toBe(connection)
      expect(plan).toEqual(buildPartialClosePlan(f.command, f.action, expires))
      trace.push('register'); writes.push('workflow', 'workflow_event')
      if (options.failRegistration) throw new Error('registration_failed')
    }
  })
  const unused = () => { throw new Error('unexpected_port') }
  const captureDispatch = vi.fn(async () => {
    trace.push('capture_dispatch')
    return async (actual: PoolConnection, candidate: typeof c, action: ExecutionAction, expiry: number) => {
      expect(actual).toBe(connection)
      expect(candidate).toEqual(c)
      expect(action).toEqual(f.action)
      expect(expiry).toBe(expires)
      trace.push('dispatch_receipt'); writes.push('dispatch_receipt')
      if (options.failDispatch) throw new Error('dispatch_review_failed')
      return now.toISOString()
    }
  })
  const repository = new MysqlBridgeCommandRepository({ getConnection: async () => connection, execute: connection.execute } as unknown as Pool,
    unused, unused, options.enabled ? capture : undefined, undefined, undefined, options.dispatch ? captureDispatch : undefined)
  return { ...f, connection, repository, trace, writes, capture }
}
describe('parent command registration transaction orchestration', () => {
  it('captures parent review before begin and persists receipt before command and intent dispatch', async () => {
    const f = repositoryFixture({ existing: true, dispatch: true })
    await expect(f.repository.markDispatched(f.command.id, 1, now.toISOString())).resolves.toMatchObject({ status: 'dispatched', revision: 2 })
    expect(f.trace).toEqual(['capture_dispatch', 'begin', 'dispatch_receipt', 'command_update', 'bridge_command_events_v4',
      'intent_update', 'execution_intent_events', 'commit'])
  })
  it.each(['review', 'command'])('rolls the receipt back when parent %s fails', async stage => {
    const f = repositoryFixture({ existing: true, dispatch: true, failDispatch: stage === 'review', failCommandUpdate: stage === 'command' })
    await expect(f.repository.markDispatched(f.command.id, 1, now.toISOString())).rejects.toThrow(stage === 'review' ? 'dispatch_review_failed' : 'command_update_failed')
    expect(f.writes).toEqual([])
    expect(f.connection.rollback).toHaveBeenCalledOnce()
    expect(f.connection.commit).not.toHaveBeenCalled()
  })
  it('captures outside the transaction and registers after parent payload but before event/outbox', async () => {
    const f = repositoryFixture({ enabled: true })
    await f.repository.create(f.command)
    expect(f.trace).toEqual(['capture', 'begin', 'bridge_commands_v4', 'bridge_command_payloads_v4', 'register', 'bridge_command_events_v4', 'outbox_events', 'commit'])
    expect(f.connection.rollback).not.toHaveBeenCalled()
  })
  it.each(['registration', 'outbox'])('rolls all staged writes back on %s failure', async failure => {
    const f = repositoryFixture({ enabled: true, failRegistration: failure === 'registration', failOutbox: failure === 'outbox' })
    await expect(f.repository.create(f.command)).rejects.toThrow(`${failure}_failed`)
    expect(f.writes).toEqual([])
    expect(f.connection.rollback).toHaveBeenCalledOnce()
    expect(f.connection.commit).not.toHaveBeenCalled()
  })
  it('refuses to insert a partial-close command when continuation capability is unavailable', async () => {
    const f = repositoryFixture()
    await expect(f.repository.create(f.command)).rejects.toThrow('partial_close_workflow_unavailable')
    expect(f.writes).toEqual([])
    expect(f.connection.commit).not.toHaveBeenCalled()
  })
  it('revalidates registration on existing parent replay without inserting another command or outbox', async () => {
    const f = repositoryFixture({ enabled: true, existing: true })
    await expect(f.repository.create(f.command)).resolves.toEqual(f.command)
    expect(f.trace).toEqual(['capture', 'begin', 'register', 'commit'])
    expect(f.writes).toEqual(['workflow', 'workflow_event'])
  })
  it('does not let a queued recovery bypass the unfinished child-workflow gate', async () => {
    const f = repositoryFixture({ enabled: true, existing: true })
    await expect(f.repository.markDispatched(f.command.id, 1, now.toISOString())).rejects.toThrow('partial_close_workflow_dispatch_unavailable')
    expect(f.connection.commit).not.toHaveBeenCalled()
    expect(f.writes).toEqual([])
  })
  it('blocks the new workflow source until its dispatch preflight is available', async () => {
    const f = repositoryFixture({ enabled: true, existing: true, positionWorkflow: true })
    await expect(f.repository.markDispatched(f.command.id, 1, now.toISOString())).rejects.toThrow('position_protection_dispatch_unavailable')
    expect(f.connection.commit).not.toHaveBeenCalled()
    expect(f.writes).toEqual([])
  })
  it('does not create an unbound command for the workflow source before its binding provider is wired', async () => {
    const f = repositoryFixture({ enabled: true, positionWorkflow: true })
    await expect(f.repository.create(f.command)).rejects.toThrow('position_protection_command_binding_unavailable')
    expect(f.writes).toEqual([])
    expect(f.connection.commit).not.toHaveBeenCalled()
  })
  it('preserves ordinary close creation without a workflow provider', async () => {
    const f = repositoryFixture()
    delete f.action.parameters.after_close_protection
    delete f.action.parameters.after_close_target
    await expect(f.repository.create(f.command)).resolves.toEqual(f.command)
    expect(f.writes).toEqual(['bridge_commands_v4', 'bridge_command_payloads_v4', 'bridge_command_events_v4', 'outbox_events'])
  })
})
