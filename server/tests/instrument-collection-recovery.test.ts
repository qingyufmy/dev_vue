import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createMysqlInstrumentCollectionRecovery } from '../src/modules/trading/infrastructure/mysql-instrument-collection-recovery.js'

function fixture(failure?: 'insert' | 'commit') {
  const execute = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.startsWith('SELECT')) return [[{ id: 'request-1' }]]
    if (failure === 'insert' && sql.startsWith('INSERT')) throw new Error('outbox unavailable')
    return [{ affectedRows: 1 }]
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(async () => {
    if (failure === 'commit') throw new Error('connection lost')
  }), rollback: vi.fn(), release: vi.fn() }
  const getConnection = vi.fn(async () => connection)
  return { execute, connection, getConnection, recovery: createMysqlInstrumentCollectionRecovery({ getConnection } as unknown as Pool) }
}
it('registers an ID-only recovery event and cooldown in one transaction', async () => {
  const f = fixture()
  expect(await f.recovery.schedule(10)).toBe(1)
  const insert = f.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT'))!
  expect(JSON.parse(insert[1]![2] as string)).toEqual({ request_id: 'request-1' })
  expect(f.connection.commit).toHaveBeenCalledOnce()
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it('does not consume cooldown when event persistence fails', async () => {
  const f = fixture('insert')
  await expect(f.recovery.schedule(10)).rejects.toThrow('outbox unavailable')
  expect(f.execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false)
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})
it('reports commit uncertainty without claiming no event exists', async () => {
  await expect(fixture('commit').recovery.schedule(10)).rejects.toThrow('instrument_recovery_commit_unknown')
})
it('rejects unbounded batch requests before connecting', async () => {
  const f = fixture()
  await expect(f.recovery.schedule(501)).rejects.toThrow('instrument_recovery_limit_invalid')
  expect(f.getConnection).not.toHaveBeenCalled()
})
