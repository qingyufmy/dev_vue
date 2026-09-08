import { createActivePrincipalAccess } from '../src/modules/auth/composition.js'
import { expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { MysqlContextCommands } from '../src/modules/trading/infrastructure/mysql-context-commands.js'
import type { ContextWriteCommand } from '../src/modules/trading/domain/context-write.js'
import { TradingAccessError } from '../src/modules/trading/domain/trading.js'

const command: ContextWriteCommand = { userId: 42, requestId: 'd97382ac-4b49-42db-b1f1-850ec403848a', action: 'select_account', targetId: '7', expectedRevision: 0 }
type State = { revision: number; receipts: Record<string, Record<string, unknown>> }
function fixture() {
  let state: State = { revision: 0, receipts: {} }
  let beginFailure = false
  let receiptDeadlocks = 0
  let principalDeadlocks = 0
  let active = true, receiptFailure = false, lostAck = false, rollbackFailure = false
  const connections: Array<{ calls: string[] }> = []
  const pool = { async getConnection() {
    let pending = structuredClone(state)
    const calls: string[] = []; connections.push({ calls })
    return {
      async beginTransaction() { calls.push('begin'); if (beginFailure) throw Error('private-begin-error'); pending = structuredClone(state) },
      async execute(sql: string, params: unknown[]) {
        if (sql.startsWith('SELECT id FROM users') && principalDeadlocks > 0) {
          principalDeadlocks--; throw Object.assign(Error('private-user-query'), { code: 'ER_LOCK_DEADLOCK' })
        }
        if (sql.startsWith('SELECT id FROM users')) { calls.push(sql.includes('FOR UPDATE') ? 'user-lock' : sql.includes('FOR SHARE') ? 'user-share' : 'user-read'); return [active ? [{ id: 42 }] : []] }
        if (sql.includes('FROM trading_context_changes_v4')) { calls.push('receipt-read'); return [active && pending.receipts[String(params[1])] ? [pending.receipts[String(params[1])]] : []] }
        if (sql.includes('FROM trading_contexts')) { calls.push('context-lock'); return [pending.revision ? [{ revision: String(pending.revision) }] : []] }
        if (sql.includes('INSERT INTO trading_contexts')) { calls.push('context-write'); pending.revision = Number(params[5]); return [{ affectedRows: 1 }] }
        if (sql.includes('INSERT INTO trading_context_changes_v4')) {
          calls.push('receipt-write')
          if (receiptDeadlocks > 0) { receiptDeadlocks--; throw Object.assign(Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }) }
          if (receiptFailure) throw Error('receipt-insert-failed')
          const names = ['user_id','request_id','request_sha256','action','target_id','prior_revision','revision','result_mode','result_account_id','result_observer_channel_id','result_read_only']
          pending.receipts[String(params[1])] = { ...Object.fromEntries(names.map((name, index) => [name, params[index]])), recorded_at: '2026-09-08T12:00:00.000Z' }
          return [{ affectedRows: 1 }]
        }
        throw Error('unexpected-sql')
      },
      async commit() { calls.push('commit'); state = structuredClone(pending); if (lostAck) { lostAck = false; throw Error('lost-ack') } },
      async rollback() { calls.push('rollback'); if (rollbackFailure) throw Error('rollback-failed'); pending = structuredClone(state) },
      destroy() { calls.push('destroy') }, release() { calls.push('release') },
    }
  } }
  const resolve = vi.fn(async (_connection: PoolConnection, c: ContextWriteCommand) => ({ userId: c.userId,
    mode: 'full' as const, accountId: c.targetId, observerChannelId: null, readOnly: false }))
  return { writer: new MysqlContextCommands(pool as unknown as Pool, resolve, createActivePrincipalAccess), resolve, connections,
    failBegin: () => { beginFailure = true },
    deadlockReceipt: () => { receiptDeadlocks = 1 },
    deadlockPrincipal: () => { principalDeadlocks = 1 },
    failRollback: () => { rollbackFailure = true }, state: () => state, failReceipt: () => { receiptFailure = true }, loseAck: () => { lostAck = true }, deactivate: () => { active = false } }
}

it('commits context and receipt together, then replays without target resolution or another write', async () => {
  const f = fixture()
  const first = await f.writer.execute(command)
  expect(first).toMatchObject({ replayed: false, result: { accountId: '7', revision: 1 } })
  expect(f.connections[0]!.calls.slice(0, 4)).toEqual(['begin', 'user-lock', 'receipt-read', 'context-lock'])
  expect(await f.writer.execute(command)).toEqual({ ...first, replayed: true })
  expect(f.resolve).toHaveBeenCalledTimes(1)
  expect(f.connections[1]!.calls).not.toContain('context-write')
  expect(f.state().revision).toBe(1)
})

it('rejects same key with changed body and stale new-key commands', async () => {
  const f = fixture()
  await f.writer.execute(command)
  await expect(f.writer.execute({ ...command, targetId: '8' })).rejects.toMatchObject({ code: 'trading_context_idempotency_conflict', status: 409 })
  await expect(f.writer.execute({ ...command, requestId: 'd97382ac-4b49-42db-b1f1-850ec403848b' })).rejects.toMatchObject({ code: 'revision_conflict' })
  expect(f.resolve).toHaveBeenCalledTimes(1)
  expect(f.state().revision).toBe(1)
})

it('rolls back context when its receipt cannot be written', async () => {
  const f = fixture(); f.failReceipt()
  await expect(f.writer.execute(command)).rejects.toMatchObject({ code: 'trading_context_write_failed' })
  expect(f.state()).toEqual({ revision: 0, receipts: {} })
  expect(f.connections[0]!.calls).toContain('rollback')
  expect(f.connections[0]!.calls).not.toContain('commit')
})

it('recovers a committed receipt on a new connection after acknowledgement loss', async () => {
  const f = fixture(); f.loseAck()
  await expect(f.writer.execute(command)).rejects.toMatchObject({ code: 'trading_context_commit_unknown' })
  expect(f.connections[0]!.calls.slice(-2)).toEqual(['commit', 'destroy'])
  expect(await f.writer.receipt(42, command.requestId)).toMatchObject({ replayed: true, result: { revision: 1 } })
  expect(await f.writer.execute(command)).toMatchObject({ replayed: true, result: { revision: 1 } })
  expect(f.resolve).toHaveBeenCalledTimes(1)
})

it('returns the historical receipt after a later context change without restoring it', async () => {
  const f = fixture()
  await f.writer.execute(command)
  await f.writer.execute({ ...command, requestId: 'd97382ac-4b49-42db-b1f1-850ec403848b', targetId: '8', expectedRevision: 1 })
  expect(await f.writer.execute(command)).toMatchObject({ result: { accountId: '7', revision: 1 }, replayed: true })
  expect(f.state().revision).toBe(2)
  expect(f.resolve).toHaveBeenCalledTimes(2)
})

it('checks active user on receipt replay and rejects invalid or revoked targets before mutation', async () => {
  const f = fixture()
  f.resolve.mockRejectedValueOnce(new TradingAccessError('trading_account_forbidden', 403))
  await expect(f.writer.execute(command)).rejects.toMatchObject({ status: 403 })
  expect(f.state().revision).toBe(0)
  f.resolve.mockResolvedValueOnce({ userId: 42, mode: 'full', accountId: 'wrong', observerChannelId: null, readOnly: false })
  await expect(f.writer.execute(command)).rejects.toMatchObject({ code: 'trading_context_write_failed' })
  expect(f.state().revision).toBe(0)
  await f.writer.execute(command)
  f.deactivate()
  await expect(f.writer.execute(command)).rejects.toMatchObject({ status: 403 })
  await expect(f.writer.receipt(42, command.requestId)).rejects.toMatchObject({ status: 403 })
})

it('rejects corrupted stored receipts without replaying or leaking their contents', async () => {
  const f = fixture()
  await f.writer.execute(command)
  f.state().receipts[command.requestId]!.request_sha256 = 'corrupted-private-hash'
  await expect(f.writer.execute(command)).rejects.toMatchObject({ code: 'trading_context_write_failed', status: 503 })
  await expect(f.writer.receipt(42, command.requestId)).rejects.toMatchObject({ code: 'trading_context_write_failed', status: 503 })
  expect(f.state().revision).toBe(1)
  expect(f.resolve).toHaveBeenCalledOnce()
})

it('does not let a target adapter rewrite the approved command', async () => {
  const f = fixture()
  f.resolve.mockImplementation(async (_connection, c) => {
    c.targetId = '8'
    return { userId: 42, mode: 'full', accountId: '8', observerChannelId: null, readOnly: false }
  })
  await expect(f.writer.execute(command)).rejects.toMatchObject({ code: 'trading_context_write_failed' })
  expect(command.targetId).toBe('7')
  expect(f.state().revision).toBe(0)
})

it('destroys a connection after failed rollback and rejects invalid revisions before acquiring it', async () => {
  const invalid = fixture()
  for (const expectedRevision of [null, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER]) {
    await expect(invalid.writer.execute({ ...command, expectedRevision } as ContextWriteCommand)).rejects.toMatchObject({ code: 'trading_context_invalid' })
  }
  expect(invalid.connections).toHaveLength(0)
  const failed = fixture(); failed.failReceipt(); failed.failRollback()
  await expect(failed.writer.execute(command)).rejects.toMatchObject({ code: 'trading_context_rollback_unknown' })
  expect(failed.connections[0]!.calls.slice(-2)).toEqual(['rollback', 'destroy'])
  expect(failed.connections[0]!.calls).not.toContain('release')
  expect(failed.connections[0]!.calls).not.toContain('commit')
})


it('keeps receipt authorization locked until read-only rollback and destroys uncertain cleanup', async () => {
  const f = fixture()
  await f.writer.execute(command)
  expect(await f.writer.receipt(42, command.requestId)).toMatchObject({ result: { revision: 1 } })
  expect(f.connections[1]!.calls).toEqual(['begin', 'user-share', 'receipt-read', 'rollback', 'release'])
  f.failRollback()
  await expect(f.writer.receipt(42, command.requestId)).rejects.toMatchObject({ code: 'trading_context_receipt_unavailable', status: 503 })
  expect(f.connections[2]!.calls.slice(-2)).toEqual(['rollback', 'destroy'])
  expect(f.connections[2]!.calls).not.toContain('release')
})


it('destroys a receipt connection if beginning its authorization transaction fails', async () => {
  const f = fixture(); f.failBegin()
  await expect(f.writer.receipt(42, command.requestId)).rejects.toMatchObject({ code: 'trading_context_receipt_unavailable', status: 503 })
  expect(f.connections[0]!.calls).toEqual(['begin', 'destroy'])
})

it('restarts the full transaction on a confirmed deadlock with the original command', async () => {
  const f = fixture()
  f.resolve.mockRejectedValueOnce(Object.assign(Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }))
  await expect(f.writer.execute(command)).resolves.toMatchObject({ result: { revision: 1 }, replayed: false })
  expect(f.connections).toHaveLength(2)
  expect(f.connections[0]!.calls.slice(-2)).toEqual(['rollback', 'release'])
  expect(f.connections[1]!.calls.slice(0, 4)).toEqual(['begin', 'user-lock', 'receipt-read', 'context-lock'])
  expect(f.resolve.mock.calls.map(call => call[1])).toEqual([command, command])
  expect(Object.keys(f.state().receipts)).toEqual([command.requestId])
})

it('recovers a definitive abort from the actual auth capability before target resolution', async () => {
  const f = fixture(); f.deadlockPrincipal()
  await expect(f.writer.execute(command)).resolves.toMatchObject({ result: { revision: 1 } })
  expect(f.connections).toHaveLength(2)
  expect(f.connections[0]!.calls).toEqual(['begin', 'rollback', 'release'])
  expect(f.resolve).toHaveBeenCalledOnce()
  expect(Object.keys(f.state().receipts)).toEqual([command.requestId])
})

it('bounds repeated deadlocks to three attempts without a write or receipt', async () => {
  const f = fixture()
  f.resolve.mockRejectedValue(Object.assign(Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }))
  await expect(f.writer.execute(command)).rejects.toMatchObject({ code: 'trading_context_write_failed' })
  expect(f.connections).toHaveLength(3)
  expect(f.state()).toEqual({ revision: 0, receipts: {} })
  for (const connection of f.connections) expect(connection.calls.slice(-2)).toEqual(['rollback', 'release'])
})

it('rolls back an already-written context before retrying its receipt and commits only once', async () => {
  const f = fixture(); f.deadlockReceipt()
  await expect(f.writer.execute(command)).resolves.toMatchObject({ result: { revision: 1 } })
  expect(f.connections).toHaveLength(2)
  expect(f.connections[0]!.calls).toContain('context-write')
  expect(f.connections[0]!.calls).not.toContain('commit')
  expect(f.connections.flatMap(connection => connection.calls).filter(call => call === 'commit')).toHaveLength(1)
  expect(f.state().revision).toBe(1)
  expect(Object.keys(f.state().receipts)).toEqual([command.requestId])
})

it('rejects a revision changed by another transaction between attempts', async () => {
  const f = fixture()
  f.resolve.mockImplementationOnce(async () => {
    f.state().revision = 1
    throw Object.assign(Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' })
  })
  await expect(f.writer.execute(command)).rejects.toMatchObject({ code: 'revision_conflict' })
  expect(f.connections).toHaveLength(2)
  expect(f.resolve).toHaveBeenCalledOnce()
  expect(f.state()).toEqual({ revision: 1, receipts: {} })
})

it('rechecks authorization after a deadlock instead of trusting the first attempt', async () => {
  const f = fixture()
  f.resolve.mockImplementationOnce(async () => {
    f.deactivate()
    throw Object.assign(Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' })
  })
  await expect(f.writer.execute(command)).rejects.toMatchObject({ status: 403 })
  expect(f.connections).toHaveLength(2)
  expect(f.resolve).toHaveBeenCalledOnce()
  expect(f.state().revision).toBe(0)
})

it('does not retry lock timeouts, unknown commits or failed rollback', async () => {
  const timeout = fixture()
  timeout.resolve.mockRejectedValue(Object.assign(Error('timeout'), { code: 'ER_LOCK_WAIT_TIMEOUT' }))
  await expect(timeout.writer.execute(command)).rejects.toMatchObject({ code: 'trading_context_write_failed' })
  expect(timeout.connections).toHaveLength(1)
  const unknown = fixture(); unknown.loseAck()
  await expect(unknown.writer.execute(command)).rejects.toMatchObject({ code: 'trading_context_commit_unknown' })
  expect(unknown.connections).toHaveLength(1)
  const rollback = fixture(); rollback.failRollback()
  rollback.resolve.mockRejectedValue(Object.assign(Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }))
  await expect(rollback.writer.execute(command)).rejects.toMatchObject({ code: 'trading_context_rollback_unknown' })
  expect(rollback.connections).toHaveLength(1)
})
