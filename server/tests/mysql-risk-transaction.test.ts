import { expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { inRiskTransaction } from '../src/modules/risk/infrastructure/mysql-risk-transaction.js'
import { RiskError } from '../src/modules/risk/domain/risk.js'

function fixture() {
  const connection = { beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}), destroy: vi.fn(), release: vi.fn() }
  const getConnection = vi.fn(async () => connection as unknown as PoolConnection)
  return { connection, getConnection, pool: { getConnection } as Pick<Pool, 'getConnection'> }
}

it('releases a successful transaction and preserves the returned value', async () => {
  const f = fixture()
  expect(await inRiskTransaction(f.pool, async () => 'saved')).toBe('saved')
  expect(f.connection.commit).toHaveBeenCalledTimes(1)
  expect(f.connection.release).toHaveBeenCalledTimes(1)
  expect(f.connection.rollback).not.toHaveBeenCalled()
})

it('rolls back a rejected business operation and preserves its conflict', async () => {
  const f = fixture(), failure = new RiskError('risk_policy_revision_conflict', 409)
  await expect(inRiskTransaction(f.pool, async () => { throw failure })).rejects.toBe(failure)
  expect(f.connection.rollback).toHaveBeenCalledTimes(1)
  expect(f.connection.release).toHaveBeenCalledTimes(1)
  expect(f.connection.commit).not.toHaveBeenCalled()
})

it('discards uncertain commits without rollback, retry or leaked driver detail', async () => {
  const f = fixture(), work = vi.fn(async () => 'saved')
  f.connection.commit.mockRejectedValueOnce(Error('SQL connection secret'))
  await expect(inRiskTransaction(f.pool, work)).rejects.toMatchObject({ code: 'risk_commit_unknown', status: 503 })
  expect(work).toHaveBeenCalledTimes(1)
  expect(f.getConnection).toHaveBeenCalledTimes(1)
  expect(f.connection.destroy).toHaveBeenCalledTimes(1)
  expect(f.connection.rollback).not.toHaveBeenCalled()
  expect(f.connection.release).not.toHaveBeenCalled()
})

it('discards failed begin and rollback connections instead of recycling them', async () => {
  for (const stage of ['beginTransaction', 'rollback'] as const) {
    const f = fixture()
    f.connection[stage].mockRejectedValueOnce(Error('broken connection'))
    await expect(inRiskTransaction(f.pool, async () => { throw Error('write failed') })).rejects.toMatchObject({
      code: stage === 'rollback' ? 'risk_rollback_unknown' : 'risk_storage_unavailable', status: 503,
    })
    expect(f.connection.destroy).toHaveBeenCalledTimes(1)
    expect(f.connection.release).not.toHaveBeenCalled()
    expect(f.connection.commit).not.toHaveBeenCalled()
  }
})

it('sanitizes acquire and statement failures and only releases after confirmed rollback', async () => {
  const f = fixture()
  f.getConnection.mockRejectedValueOnce(Error('password'))
  await expect(inRiskTransaction(f.pool, async () => {})).rejects.toMatchObject({ code: 'risk_storage_unavailable' })
  await expect(inRiskTransaction(f.pool, async () => { throw Error('SQL') })).rejects.toMatchObject({ code: 'risk_storage_unavailable' })
  expect(f.connection.rollback).toHaveBeenCalledTimes(1)
  expect(f.connection.release).toHaveBeenCalledTimes(1)
})
