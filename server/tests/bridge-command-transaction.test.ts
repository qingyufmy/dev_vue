import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { bridgeCommandTransaction } from '../src/modules/execution/infrastructure/bridge-command-transaction.js'

function fixture() {
  const connection = { beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}),
    release: vi.fn(), destroy: vi.fn() }
  return { connection, pool: { getConnection: async () => connection } as unknown as Pool }
}
describe('Bridge command transaction uncertainty', () => {
  it('returns only after a confirmed commit and releases a healthy connection', async () => {
    const f = fixture()
    await expect(bridgeCommandTransaction(f.pool, async actual => { expect(actual).toBe(f.connection); return 'saved' })).resolves.toBe('saved')
    expect(f.connection.commit).toHaveBeenCalledOnce()
    expect(f.connection.release).toHaveBeenCalledOnce()
    expect(f.connection.rollback).not.toHaveBeenCalled()
  })
  it('rolls back preparation failures and preserves the original error', async () => {
    const f = fixture(), error = new Error('workflow_audit_failed')
    await expect(bridgeCommandTransaction(f.pool, async () => { throw error })).rejects.toBe(error)
    expect(f.connection.rollback).toHaveBeenCalledOnce()
    expect(f.connection.commit).not.toHaveBeenCalled()
    expect(f.connection.release).toHaveBeenCalledOnce()
  })
  it('discards a connection whose rollback failed without masking the preparation error', async () => {
    const f = fixture(), error = new Error('workflow_failed')
    f.connection.rollback.mockRejectedValue(new Error('connection_lost'))
    await expect(bridgeCommandTransaction(f.pool, async () => { throw error })).rejects.toBe(error)
    expect(f.connection.destroy).toHaveBeenCalledOnce()
    expect(f.connection.release).not.toHaveBeenCalled()
  })
  it.each([false, true])('does not infer rollback or rerun work after COMMIT acknowledgement failure, committed=%s', committed => {
    const f = fixture(), work = vi.fn(async () => 'saved')
    let durable = false
    f.connection.commit.mockImplementation(async () => { durable = committed; throw new Error('ack_lost') })
    return expect(bridgeCommandTransaction(f.pool, work)).rejects.toMatchObject({ code: 'bridge_command_commit_unknown', status: 503 }).then(() => {
      expect(durable).toBe(committed)
      expect(work).toHaveBeenCalledOnce()
      expect(f.connection.rollback).not.toHaveBeenCalled()
      expect(f.connection.destroy).toHaveBeenCalledOnce()
      expect(f.connection.release).not.toHaveBeenCalled()
    })
  })
})
