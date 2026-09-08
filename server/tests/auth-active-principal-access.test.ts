import type { PoolConnection } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { createActivePrincipalAccess } from '../src/modules/auth/composition.js'

it('uses only the supplied connection and preserves explicit locking mode and user binding', async () => {
  const execute = vi.fn(async (_sql: string, _params: unknown[]) => [[{ id: 42 }]])
  const access = createActivePrincipalAccess({ execute } as unknown as PoolConnection)
  expect(await access.isActive(42, 'update')).toBe(true)
  expect(execute).toHaveBeenLastCalledWith("SELECT id FROM users WHERE id=? AND deletion_status='active' AND deleted_at IS NULL FOR UPDATE", [42])
  expect(await access.isActive(42, 'share')).toBe(true)
  expect(execute).toHaveBeenLastCalledWith("SELECT id FROM users WHERE id=? AND deletion_status='active' AND deleted_at IS NULL FOR SHARE", [42])
  expect(await access.isActive(7, 'none')).toBe(true)
  expect(execute).toHaveBeenLastCalledWith("SELECT id FROM users WHERE id=? AND deletion_status='active' AND deleted_at IS NULL", [7])
  execute.mockResolvedValueOnce([[]])
  expect(await access.isActive(42, 'none')).toBe(false)
  execute.mockResolvedValueOnce([[{ id: 42 }, { id: 42 }]])
  expect(await access.isActive(42, 'update')).toBe(false)
  execute.mockRejectedValueOnce(Error('private SQL details'))
  await expect(access.isActive(42, 'update')).rejects.toThrow(/^auth_principal_unavailable$/)
})

it('refuses invalid identifiers and lock values before querying', async () => {
  const execute = vi.fn()
  const access = createActivePrincipalAccess({ execute } as unknown as PoolConnection)
  for (const userId of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(await access.isActive(userId, 'none')).toBe(false)
  expect(await access.isActive(42, 'invalid' as 'update')).toBe(false)
  expect(execute).not.toHaveBeenCalled()
})
