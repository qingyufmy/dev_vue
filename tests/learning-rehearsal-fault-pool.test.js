import { expect, it, vi } from 'vitest'
import { learningRehearsalFaultPool } from '../scripts/lib/learning-rehearsal-fault-pool.mjs'
import { MysqlBackfillRepository } from '../scripts/lib/v4-backfill-mysql-repository.mjs'
function fixture(database = 'dev_vue_m1_source_20260907_02') {
  const connection = { query: vi.fn(async () => [[{ db: database, uuid: 'ac423207-6ef3-11f1-b302-000c29fda104' }]]), execute: vi.fn(async () => [{}]),
    commit: vi.fn(), rollback: vi.fn(), destroy: vi.fn(), release: vi.fn() }
  return { connection, pool: learningRehearsalFaultPool({ getConnection: async () => connection }) }
}
it('injects only after successful batch commit, once, and leaves ordinary preparation commits intact', async () => {
  const f = fixture(), c = await f.pool.getConnection()
  await c.execute('INSERT INTO data_migration_runs (...)', [])
  await c.commit()
  expect(f.pool.injected).toBe(false)
  await c.execute('INSERT INTO data_migration_batches (...)', [])
  await expect(c.commit()).rejects.toThrow('learning_rehearsal_lost_acknowledgement')
  expect(f.connection.commit).toHaveBeenCalledTimes(2)
  expect(f.pool.injected).toBe(true)
  await c.commit()
  expect(f.connection.commit).toHaveBeenCalledTimes(3)
})
it('does not claim injection if actual commit fails and clears batch state after rollback', async () => {
  const f = fixture(), c = await f.pool.getConnection()
  await c.execute('INSERT INTO data_migration_batches (...)', [])
  f.connection.commit.mockRejectedValueOnce(new Error('real failure'))
  await expect(c.commit()).rejects.toThrow('real failure')
  expect(f.pool.injected).toBe(false)
  await c.rollback(); await c.commit()
  expect(f.pool.injected).toBe(false)
})
it('rejects current dev_vue before any batch action and destroys the connection', async () => {
  const f = fixture('dev_vue')
  await expect(f.pool.getConnection()).rejects.toThrow('learning_rehearsal_fault_scope')
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.execute).not.toHaveBeenCalled()
})

it('surfaces the injected committed outcome through the real transaction adapter without rollback or replay', async () => {
  const f = fixture()
  f.connection.beginTransaction = vi.fn()
  let committed = false
  f.connection.commit.mockImplementation(async () => { committed = true })
  const repository = new MysqlBackfillRepository(f.pool)
  const work = vi.fn(async tx => {
    await tx.insertBatch('fixture-run', { batchId: 'fixture-batch', streamId: 'fixture-stream',
      sequence: 1, requestHash: 'a'.repeat(64), rows: 0, endCursor: null })
  })
  await expect(repository.transaction(work)).rejects.toMatchObject({ code: 'backfill_commit_unknown' })
  expect(committed).toBe(true)
  expect(f.pool.injected).toBe(true)
  expect(work).toHaveBeenCalledOnce()
  expect(f.connection.commit).toHaveBeenCalledOnce()
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.release).not.toHaveBeenCalled()
  expect(f.connection.rollback).not.toHaveBeenCalled()
})

it('stops the real transaction adapter before BEGIN when the rehearsal pool rejects its database', async () => {
  const f = fixture('dev_vue')
  f.connection.beginTransaction = vi.fn()
  const work = vi.fn()
  await expect(new MysqlBackfillRepository(f.pool).transaction(work)).rejects.toMatchObject({ code: 'backfill_storage_failed' })
  expect(work).not.toHaveBeenCalled()
  expect(f.connection.beginTransaction).not.toHaveBeenCalled()
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.release).not.toHaveBeenCalled()
})
