import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { historyTransaction } from '../src/modules/trade-history/infrastructure/history-transaction.js'
import { HistoryCommitUnknown } from '../src/modules/trade-history/application/history-commit-unknown.js'

function fixture() {
  const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), destroy: vi.fn(), release: vi.fn() }
  return { connection, pool: { getConnection: async () => connection } as unknown as Pool }
}
it('returns acknowledged work and releases its connection', async () => {
  const f = fixture()
  await expect(historyTransaction(f.pool, async () => 7)).resolves.toBe(7)
  expect(f.connection.commit).toHaveBeenCalledOnce()
  expect(f.connection.release).toHaveBeenCalledOnce()
  expect(f.connection.rollback).not.toHaveBeenCalled()
})
it('never rolls back or reuses a connection after COMMIT acknowledgement is lost', async () => {
  const f = fixture()
  f.connection.commit.mockRejectedValueOnce(Error('socket_closed'))
  await expect(historyTransaction(f.pool, async () => 7)).rejects.toBeInstanceOf(HistoryCommitUnknown)
  expect(f.connection.rollback).not.toHaveBeenCalled()
  expect(f.connection.release).not.toHaveBeenCalled()
  expect(f.connection.destroy).toHaveBeenCalledOnce()
})
it.each([false, true])('preserves the original work failure when rollback fails=%s', async rollbackFails => {
  const f = fixture(), error = Error('fact_conflict')
  if (rollbackFails) f.connection.rollback.mockRejectedValueOnce(Error('socket_closed'))
  await expect(historyTransaction(f.pool, async () => { throw error })).rejects.toBe(error)
  expect(f.connection.commit).not.toHaveBeenCalled()
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.destroy).toHaveBeenCalledTimes(rollbackFails ? 1 : 0)
  expect(f.connection.release).toHaveBeenCalledTimes(rollbackFails ? 0 : 1)
})
