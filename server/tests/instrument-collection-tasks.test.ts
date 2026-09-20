import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createMysqlInstrumentCollectionTasks } from '../src/modules/trading/infrastructure/mysql-instrument-collection-tasks.js'

const requestId = '11111111-1111-4111-8111-111111111111'
const claim = { requestId, userId: 7, accountId: '11', symbol: 'US 500.a', leaseToken: 'old-token' }
function fixture(options: { status?: string; busy?: boolean; missing?: boolean; commitUnknown?: boolean; affectedRows?: number } = {}) {
  let token = ''
  const execute = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('UPDATE')) { token = String(values[0]); return [{ affectedRows: 1 }] }
    return [options.missing ? [] : [{ user_id: 7, account_id: '11', symbol: 'US 500.a',
      status: options.status ?? 'running', lease_token: options.busy ? 'another-worker' : token,
      lease_expires_at_utc: new Date('2026-09-09T10:00:00Z') }]]
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(async () => {
    if (options.commitUnknown) throw new Error('connection lost')
  }), rollback: vi.fn(), release: vi.fn() }
  const update = vi.fn(async () => [{ affectedRows: options.affectedRows ?? 1 }])
  const pool = { getConnection: vi.fn(async () => connection), execute: update }
  return { tasks: createMysqlInstrumentCollectionTasks(pool as unknown as Pool), connection, pool, update }
}
it('returns the database-owned scope and a new token only after commit', async () => {
  const f = fixture()
  const result = await f.tasks.claim(requestId)
  expect(result).toMatchObject({ state: 'claimed', claim: { requestId, userId: 7, accountId: '11', symbol: 'US 500.a' } })
  if (result.state !== 'claimed') throw new Error('not claimed')
  expect(result.claim.leaseToken).not.toBe(claim.leaseToken)
  expect(f.connection.commit).toHaveBeenCalledOnce()
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it('returns the active lease deadline instead of granting another lease', async () => {
  expect(await fixture({ busy: true }).tasks.claim(requestId)).toEqual({ state: 'busy', retryAt: '2026-09-09T10:00:00.000Z' })
})
it.each(['succeeded', 'failed'])('does not reprocess a %s request', async status => {
  expect(await fixture({ status }).tasks.claim(requestId)).toEqual({ state: 'terminal' })
})
it('rolls back missing requests and releases the connection', async () => {
  const f = fixture({ missing: true })
  await expect(f.tasks.claim(requestId)).rejects.toThrow('instrument_request_not_found')
  expect(f.connection.commit).not.toHaveBeenCalled()
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it('does not expose a lease when its commit acknowledgement is lost', async () => {
  const f = fixture({ commitUnknown: true })
  await expect(f.tasks.claim(requestId)).rejects.toThrow('instrument_request_claim_unknown')
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it('rejects malformed IDs without opening a transaction', async () => {
  const f = fixture()
  await expect(f.tasks.claim('bad')).rejects.toThrow('instrument_request_id_invalid')
  expect(f.pool.getConnection).not.toHaveBeenCalled()
})
it.each([0, 1])('reports affected-row result %i for completion and release', async affectedRows => {
  const f = fixture({ affectedRows })
  expect(await f.tasks.complete(claim, 12)).toBe(affectedRows === 1)
  expect(await f.tasks.release(claim, 'bridge_route_unavailable')).toBe(affectedRows === 1)
  expect(f.update).toHaveBeenNthCalledWith(1, expect.stringContaining('lease_expires_at_utc>UTC_TIMESTAMP(3)'),
    [12, requestId, 7, '11', 'US 500.a', 'old-token'])
  expect(f.update).toHaveBeenNthCalledWith(2, expect.stringContaining("AND status='running' AND lease_token=?"),
    ['bridge_route_unavailable', requestId, 7, '11', 'US 500.a', 'old-token'])
})
it('rejects invalid completion values before SQL', async () => {
  const f = fixture()
  await expect(f.tasks.complete(claim, 0)).rejects.toThrow('instrument_result_revision_invalid')
  await expect(f.tasks.release(claim, 'raw SQL / secret')).rejects.toThrow('instrument_request_error_invalid')
  expect(f.update).not.toHaveBeenCalled()
})
