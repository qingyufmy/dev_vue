import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { historyScheduleTransaction } from '../src/modules/trade-history/infrastructure/history-schedule-transaction.js'
import { HistoryCommitUnknown } from '../src/modules/trade-history/application/history-commit-unknown.js'
function fixture() {
  const state = { acquired: 1 as number | null, released: 1 }
  const connection = { query: vi.fn(async () => [[{ db: 'dev_vue', timezone: '+00:00' }]]),
    execute: vi.fn(async (sql: string) => [[sql.includes('GET_LOCK') ? { acquired: state.acquired } : { released: state.released }]]),
    beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}), release: vi.fn(), destroy: vi.fn() }
  const work = vi.fn(async () => ['5'])
  const pool = { getConnection: async () => connection } as unknown as Pool
  return { state, connection, work, run: () => historyScheduleTransaction(pool, work) }
}
it('owns one connection until commit and named-lock release', async () => {
  const f = fixture(); expect(await f.run()).toEqual(['5'])
  expect(f.connection.commit).toHaveBeenCalledOnce(); expect(f.connection.execute).toHaveBeenCalledTimes(2)
  expect(f.connection.release).toHaveBeenCalledOnce(); expect(f.connection.destroy).not.toHaveBeenCalled()
})
it('skips a concurrent scheduler without entering a transaction or releasing its lock', async () => {
  const f = fixture(); f.state.acquired = 0
  expect(await f.run()).toEqual([])
  expect(f.work).not.toHaveBeenCalled(); expect(f.connection.beginTransaction).not.toHaveBeenCalled()
  expect(f.connection.execute).toHaveBeenCalledTimes(1); expect(f.connection.release).toHaveBeenCalledOnce()
})
it('rejects a failed lock call rather than claiming there is no due work', async () => {
  const f = fixture(); f.state.acquired = null
  await expect(f.run()).rejects.toThrow('history_schedule_lock_unavailable')
  expect(f.work).not.toHaveBeenCalled()
})
it('destroys an unknown commit connection without rollback or lock reuse', async () => {
  const f = fixture(); f.connection.commit.mockRejectedValueOnce(Error('lost_ack'))
  await expect(f.run()).rejects.toBeInstanceOf(HistoryCommitUnknown)
  expect(f.connection.destroy).toHaveBeenCalledOnce(); expect(f.connection.release).not.toHaveBeenCalled()
  expect(f.connection.rollback).not.toHaveBeenCalled(); expect(f.connection.execute).toHaveBeenCalledTimes(1)
})
it('reports lock-release uncertainty after a successful commit', async () => {
  const f = fixture(); f.state.released = 0
  await expect(f.run()).rejects.toThrow('history_schedule_lock_release_failed')
  expect(f.connection.destroy).toHaveBeenCalledOnce(); expect(f.connection.release).not.toHaveBeenCalled()
})
it('preserves the work error if cleanup also fails', async () => {
  const f = fixture(); f.state.released = 0; f.work.mockRejectedValueOnce(Error('original_failure'))
  await expect(f.run()).rejects.toThrow('original_failure')
  expect(f.connection.rollback).toHaveBeenCalledOnce(); expect(f.connection.destroy).toHaveBeenCalledOnce()
})
