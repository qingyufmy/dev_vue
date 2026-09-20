import { beforeEach, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { bridgeCommandId } from '../src/modules/execution/index.js'
import { createMysqlPositionProtectionReconciliationRequest } from '../src/modules/execution/infrastructure/mysql-position-protection-reconciliation-request.js'
import { BullMqOutboxTaskPublisher } from '../src/outbox/infrastructure/bullmq-outbox-task-publisher.js'
import type { RuntimeTaskQueues } from '../src/queue/task-queues.js'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../src/modules/execution/infrastructure/mysql-position-protection-preparation.js', () => ({ readPositionProtectionPreparation: read }))
const scope = { workflowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: 1, accountId: '11' }
const childId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', commandId = bridgeCommandId(childId, 1)
beforeEach(() => read.mockReset().mockResolvedValue({ revision: 3, status: 'protecting', childIntentId: childId }))
function fixture(status = 'uncertain', previous: { status: string; recent: number } | null = null) {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('FROM bridge_commands_v4')) return [[{ id: commandId, execution_intent_id: childId, user_id: 1,
      trading_account_id: '11', action: 'position.protection.set', status }]]
    if (sql.includes('FROM outbox_events')) return [previous ? [previous] : []]
    if (sql.includes('INSERT INTO outbox_events')) return [{ affectedRows: 1 }]
    throw Error('unexpected_sql')
  })
  const db = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  const pool = { getConnection: vi.fn().mockResolvedValue(db) } as unknown as Pool
  return { db, request: createMysqlPositionProtectionReconciliationRequest(pool),
    writes: () => execute.mock.calls.filter(([sql]) => sql.includes('INSERT INTO')) }
}
it('persists an ID-only reconciliation event and publishes the dedicated queue operation', async () => {
  const f = fixture()
  await f.request(scope, childId, commandId)
  expect(f.writes()).toHaveLength(1)
  const params = (f.db.execute.mock.calls as unknown as [string, unknown[]][]).find(([sql]) => sql.includes('INSERT INTO'))![1]
  expect(params[1]).toBe(commandId)
  expect(JSON.parse(String(params[2]))).toEqual({ command_id: commandId })
  expect(f.db.commit).toHaveBeenCalledOnce()
  const add = vi.fn()
  const publisher = new BullMqOutboxTaskPublisher({ bridgeDispatch: { add } } as unknown as RuntimeTaskQueues)
  const event = { id: '1', eventId: String(params[0]), eventType: 'bridge.command.reconcile.requested' as const,
    occurredAt: new Date().toISOString(), attempts: 1, payload: { command_id: commandId } }
  await publisher.publish(event)
  await publisher.publish({ ...event, attempts: 2 })
  expect(add.mock.calls).toEqual(Array.from({ length: 2 }, () => ['bridge.command.reconcile', { commandId }, { jobId: event.eventId }]))
  await expect(publisher.publish({ ...event, payload: { ...event.payload, ticket: '123' } })).rejects.toThrow('outbox_reconcile_payload_invalid')
})
it.each(['pending', 'dispatching'])('does not accumulate requests while delivery is %s', async status => {
  const f = fixture('reconciling', { status, recent: 0 })
  await f.request(scope, childId, commandId)
  expect(f.writes()).toHaveLength(0)
})
it.each(['dispatched', 'dead', 'failed'])('permits a fresh query after %s delivery but respects cooldown', async status => {
  const old = fixture('reconciling', { status, recent: 0 }), recent = fixture('reconciling', { status, recent: 1 })
  await old.request(scope, childId, commandId)
  await recent.request(scope, childId, commandId)
  expect(old.writes()).toHaveLength(1)
  expect(recent.writes()).toHaveLength(0)
})
it.each(['succeeded', 'failed', 'rejected'])('does not request reconciliation for terminal command %s', async status => {
  const f = fixture(status)
  await f.request(scope, childId, commandId)
  expect(f.writes()).toHaveLength(0)
})
it('rejects a queued command without creating a dispatch event', async () => {
  const f = fixture('queued')
  await expect(f.request(scope, childId, commandId)).rejects.toMatchObject({ code: 'position_protection_reconcile_command_status_invalid' })
  expect(f.writes()).toHaveLength(0)
  expect(f.db.rollback).toHaveBeenCalledOnce()
})
it('rejects mismatched workflow receipt before reading the command', async () => {
  read.mockResolvedValue({ revision: 3, status: 'protecting', childIntentId: 'wrong' })
  const f = fixture()
  await expect(f.request(scope, childId, commandId)).rejects.toMatchObject({ code: 'position_protection_reconcile_scope_mismatch' })
  expect(f.db.execute).not.toHaveBeenCalled()
})
it('reports lost commit acknowledgement as unknown and discards the connection', async () => {
  const f = fixture()
  f.db.commit.mockRejectedValue(Error('lost_ack'))
  await expect(f.request(scope, childId, commandId)).rejects.toMatchObject({ code: 'bridge_command_commit_unknown' })
  expect(f.db.destroy).toHaveBeenCalledOnce()
  expect(f.db.rollback).not.toHaveBeenCalled()
})
