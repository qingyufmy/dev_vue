import type { PoolConnection } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { createAccountPrincipalReader } from '../src/modules/auth/composition.js'

const fact = (id = 42) => ({ id, plan: 'pro', plan_expires_at_utc: '2026-09-09T12:30:45.123Z', token_version: '7' })
function fixture(rows: Record<string, unknown>[] = [fact()]) {
  const execute = vi.fn(async (_sql: string, _params: unknown[]) => [rows])
  return { execute, reader: createAccountPrincipalReader({ execute } as unknown as PoolConnection) }
}

it('reads bounded active facts with stable ordering, shared locking and exact UTC expiry', async () => {
  const f = fixture([fact(), { ...fact(9), plan_expires_at_utc: null, token_version: '0' }])
  const facts = await f.reader.readMany([42, 9, 42], 'share')
  expect(f.execute.mock.calls[0]![1]).toEqual([9, 42])
  expect(f.execute.mock.calls[0]![0]).toContain("deletion_status='active' AND deleted_at IS NULL ORDER BY id FOR SHARE")
  expect(facts.get(42)).toEqual({ userId: 42, plan: 'pro', planExpiresAtUtc: '2026-09-09T12:30:45.123Z', tokenVersion: 7 })
  expect(facts.get(9)).toMatchObject({ planExpiresAtUtc: null, tokenVersion: 0 })
  expect(Object.isFrozen(facts.get(42))).toBe(true)
})

it('omits absent users and does not invent facts or acquire a lock in snapshot mode', async () => {
  const f = fixture([])
  expect((await f.reader.readMany([9, 42], 'none')).size).toBe(0)
  expect(f.execute.mock.calls[0]![0]).not.toContain('FOR SHARE')
  expect((await f.reader.readMany([], 'share')).size).toBe(0)
  expect(f.execute).toHaveBeenCalledOnce()
})

it('rejects invalid queries before executing SQL', async () => {
  const f = fixture()
  for (const ids of [[0], [-1], [1.5], [NaN], [2_147_483_648], Array(102).fill(42)]) {
    await expect(f.reader.readMany(ids, 'none')).rejects.toThrow('auth_principal_query_invalid')
  }
  await expect(f.reader.readMany([42], 'invalid' as 'share')).rejects.toThrow('auth_principal_query_invalid')
  expect(f.execute).not.toHaveBeenCalled()
})

it.each([
  { id: 43 }, { id: '42' }, { token_version: '-1' }, { token_version: '01' }, { token_version: '2147483648' },
  { plan: '' }, { plan_expires_at_utc: '2026-02-30T12:00:00.000Z' }, { plan_expires_at_utc: '2026-09-09 12:00:00' },
])('fails closed on malformed identity facts %j', async override => {
  const f = fixture([{ ...fact(), ...override }])
  await expect(f.reader.readMany([42], 'none')).rejects.toThrow(/^auth_principal_unavailable$/)
})

it('rejects duplicate results and redacts driver errors', async () => {
  const f = fixture([fact(), fact()])
  await expect(f.reader.readMany([42], 'none')).rejects.toThrow(/^auth_principal_unavailable$/)
  f.execute.mockRejectedValueOnce(Error('private SQL and credentials'))
  await expect(f.reader.readMany([42], 'share')).rejects.toThrow(/^auth_principal_unavailable$/)
})
