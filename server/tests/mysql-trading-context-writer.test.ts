import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlTradingContextWriter } from '../src/modules/trading/infrastructure/mysql-trading-context-writer.js'

const input = { userId: 42, mode: 'blocked' as const, accountId: null, observerChannelId: null, readOnly: true }
function fixture() {
  let committed = false
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    execute: vi.fn(async (sql: string) => sql.startsWith('SELECT revision') ? [[{ revision: 3 }], []] : [{ affectedRows: 1 }, []]),
    commit: vi.fn(async () => { committed = true }), rollback: vi.fn(async () => {}), destroy: vi.fn(), release: vi.fn(),
  }
  const getConnection = vi.fn(async () => connection)
  const writer = new MysqlTradingContextWriter({ getConnection } as unknown as Pool, { authorizeOn: vi.fn(async () => null) })
  return { writer, connection, getConnection, isCommitted: () => committed }
}

it('returns the incremented context only after commit and releases its connection', async () => {
  const f = fixture()
  await expect(f.writer.saveContext(input, 3)).resolves.toEqual({ ...input, revision: 4 })
  expect(f.isCommitted()).toBe(true)
  expect(f.connection.release).toHaveBeenCalledOnce()
  expect(f.connection.destroy).not.toHaveBeenCalled()
})

it('reports commit uncertainty without rollback, release or automatic retry after lost acknowledgement', async () => {
  const f = fixture()
  const commit = f.connection.commit.getMockImplementation()!
  f.connection.commit.mockImplementation(async () => { await commit(); throw Error('private-driver-message') })
  await expect(f.writer.saveContext(input, 3)).rejects.toMatchObject({ code: 'trading_context_commit_unknown', status: 503 })
  expect(f.isCommitted()).toBe(true)
  expect(f.connection.commit).toHaveBeenCalledOnce()
  expect(f.connection.rollback).not.toHaveBeenCalled()
  expect(f.connection.release).not.toHaveBeenCalled()
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.getConnection).toHaveBeenCalledOnce()
})

it('rolls back a known revision conflict without committing', async () => {
  const f = fixture()
  await expect(f.writer.saveContext(input, 2)).rejects.toMatchObject({ code: 'revision_conflict', status: 409 })
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.commit).not.toHaveBeenCalled()
  expect(f.connection.release).toHaveBeenCalledOnce()
})

it('destroys a connection whose rollback fails and does not release it back into the pool', async () => {
  const f = fixture()
  f.connection.rollback.mockRejectedValue(Error('private-rollback-error'))
  await expect(f.writer.saveContext(input, 2)).rejects.toMatchObject({ code: 'trading_context_rollback_unknown', status: 503 })
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.release).not.toHaveBeenCalled()
  expect(f.connection.commit).not.toHaveBeenCalled()
})

it('rejects missing, fractional and exhausted revisions before acquiring a connection', async () => {
  const f = fixture()
  for (const revision of [null, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER]) {
    await expect(f.writer.saveContext(input, revision)).rejects.toMatchObject({ code: 'trading_context_invalid', status: 400 })
  }
  expect(f.getConnection).not.toHaveBeenCalled()
})
