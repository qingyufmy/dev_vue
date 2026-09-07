import { expect, it, vi } from 'vitest'
import { learningRehearsalFaultPool } from '../scripts/lib/learning-rehearsal-fault-pool.mjs'
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
