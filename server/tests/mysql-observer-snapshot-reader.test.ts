import { createAccountPrincipalReader } from '../src/modules/auth/composition.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { MysqlObserverSnapshotReader, withMysqlObserverSnapshot } from '../src/modules/trading/infrastructure/mysql-observer-snapshot-reader.js'

function fixture() {
  const calls: string[] = []
  const connection = {
    query: vi.fn(async (sql: string) => { calls.push(sql); return [[]] }),
    execute: vi.fn(async (_sql: string, _params: unknown[]) => { calls.push('read'); return [[]] }),
    rollback: vi.fn(async () => { calls.push('rollback') }),
    release: vi.fn(() => { calls.push('release') }),
    destroy: vi.fn(() => { calls.push('destroy') }),
  }
  const pool = { getConnection: vi.fn(async () => connection as unknown as PoolConnection) }
  return { calls, connection, pool: pool as unknown as Pool, getConnection: pool.getConnection }
}

it('ordinary authorization reads one snapshot and releases it without committing', async () => {
  const f = fixture()
  expect(await new MysqlObserverSnapshotReader(f.pool, createAccountPrincipalReader).authorize(9, '12')).toBe(null)
  expect(f.calls).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
    'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', 'read', 'rollback', 'release'])
  expect(f.getConnection).toHaveBeenCalledOnce()
})

it('keeps every read in a supplied operation on the same snapshot connection', async () => {
  const f = fixture()
  const result = await withMysqlObserverSnapshot(f.pool, async connection => {
    expect(connection).toBe(f.connection)
    await connection.execute('SELECT 1'); await connection.execute('SELECT 2')
    return 'complete'
  })
  expect(result).toBe('complete')
  expect(f.calls.slice(-4)).toEqual(['read', 'read', 'rollback', 'release'])
  expect(f.getConnection).toHaveBeenCalledOnce()
})

it('rejects invalid targets before acquiring a connection', async () => {
  const f = fixture(), reader = new MysqlObserverSnapshotReader(f.pool, createAccountPrincipalReader)
  expect(await reader.list(0)).toEqual([])
  expect(await reader.authorize(9, 'bad')).toBe(null)
  expect(await reader.authorize(9, '12', 'bad')).toBe(null)
  expect(f.getConnection).not.toHaveBeenCalled()
})

it.each(['isolation', 'begin', 'read', 'rollback'])('fails closed and cleans up after %s failure', async stage => {
  const f = fixture()
  if (stage === 'isolation') f.connection.query.mockRejectedValueOnce(Error('private isolation error'))
  if (stage === 'begin') f.connection.query.mockResolvedValueOnce([[]]).mockRejectedValueOnce(Error('private begin error'))
  if (stage === 'read') f.connection.execute.mockRejectedValueOnce(Error('private query error'))
  if (stage === 'rollback') f.connection.rollback.mockRejectedValueOnce(Error('private cleanup error'))
  await expect(new MysqlObserverSnapshotReader(f.pool, createAccountPrincipalReader).list(9)).rejects.toMatchObject({ code: 'trading_context_invalid', status: 503 })
  if (stage === 'read') {
    expect(f.connection.rollback).toHaveBeenCalledOnce()
    expect(f.connection.release).toHaveBeenCalledOnce()
  } else {
    expect(f.connection.destroy).toHaveBeenCalledOnce()
    expect(f.connection.release).not.toHaveBeenCalled()
  }
})
