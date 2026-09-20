import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlTradeHistoryScheduleRepository } from '../src/modules/trade-history/infrastructure/mysql-trade-history-schedule-repository.js'
const now = new Date('2026-09-10T00:00:00Z')
function fixture(fresh: string | null = null) {
  const state = { failOutbox: false }
  const execute = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]]
    if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]]
    if (sql.startsWith('SELECT CAST(a.id')) return [[{ account_id: '5', fresh_msc: fresh }]]
    if (sql.startsWith('SELECT @@session')) return [[{ timezone: '+00:00' }]]
    if (sql.startsWith('SELECT')) return [[]]
    if (sql.includes('INSERT INTO outbox_events') && state.failOutbox) throw Error('outbox_insert_failed')
    return [{ affectedRows: 1 }]
  })
  const connection = { execute, query: vi.fn(async () => [[{ db: 'dev_vue', timezone: '+00:00' }]]), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  const accounts = { lockAccount: vi.fn(async () => {}) }
  const repository = new MysqlTradeHistoryScheduleRepository({ getConnection: async () => connection } as unknown as Pool, () => accounts)
  return { state, execute, connection, accounts, repository }
}
it.each([null, String(now.getTime()-3600000)])('registers a fixed UTC window and task-only outbox (%s)', async fresh => {
  const f = fixture(fresh)
  expect(await f.repository.scheduleDue(10, now)).toEqual(['5'])
  const task = f.execute.mock.calls.find(([sql]) => sql.includes('INSERT INTO history_collection_tasks_v4'))!
  const event = f.execute.mock.calls.find(([sql]) => sql.includes('INSERT INTO outbox_events'))!
  expect(f.accounts.lockAccount).toHaveBeenCalledWith('5')
  expect(task[1]).toContainEqual(new Date(fresh === null ? Date.UTC(2000,0,1) : Number(fresh)-86400000))
  expect(task[1]).toContainEqual(now)
  expect(JSON.parse(String(event[1][2]))).toEqual({ task_id: task[1][0] })
  expect(f.connection.commit).toHaveBeenCalledOnce()
})
it('rolls back task registration if outbox insertion fails', async () => {
  const f = fixture(); f.state.failOutbox = true
  await expect(f.repository.scheduleDue(10, now)).rejects.toThrow('outbox_insert_failed')
  expect(f.connection.rollback).toHaveBeenCalledOnce(); expect(f.connection.commit).not.toHaveBeenCalled()
})
it('rejects future freshness instead of creating an invalid collection window', async () => {
  const f = fixture(String(now.getTime()+1))
  await expect(f.repository.scheduleDue(10, now)).rejects.toThrow('history_task_window_invalid')
  expect(f.accounts.lockAccount).not.toHaveBeenCalled(); expect(f.connection.rollback).toHaveBeenCalledOnce()
})
