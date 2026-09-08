import type { PoolConnection } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import { createAdminPrincipalAccess } from '../src/modules/auth/composition.js'

describe('transaction-bound administrator identity', () => {
  it('uses the supplied executor and holds a shared lock only when requested', async () => {
    const execute = vi.fn(async () => [[{ id: 7 }], []])
    const access = createAdminPrincipalAccess({ execute } as unknown as PoolConnection)
    await expect(access.isAdmin(7, 'share')).resolves.toBe(true)
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('FOR SHARE'), [7])
    await expect(access.isAdmin(7, 'none')).resolves.toBe(true)
    expect(execute).toHaveBeenLastCalledWith(expect.not.stringContaining('FOR SHARE'), [7])
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining("role='admin' AND deletion_status='active' AND deleted_at IS NULL"), [7])
  })

  it('rejects invalid identity or lock without querying', async () => {
    const execute = vi.fn()
    const access = createAdminPrincipalAccess({ execute } as unknown as PoolConnection)
    for (const userId of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(access.isAdmin(userId, 'share')).resolves.toBe(false)
    }
    await expect(access.isAdmin(7, 'update' as 'share')).resolves.toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects absent or ambiguous identities and sanitizes storage failure', async () => {
    const execute = vi.fn().mockResolvedValueOnce([[], []]).mockResolvedValueOnce([[{ id: 7 }, { id: 8 }], []])
      .mockRejectedValueOnce(new Error('private_sql_details'))
    const access = createAdminPrincipalAccess({ execute } as unknown as PoolConnection)
    await expect(access.isAdmin(7, 'share')).resolves.toBe(false)
    await expect(access.isAdmin(7, 'share')).resolves.toBe(false)
    await expect(access.isAdmin(7, 'share')).rejects.toThrow('auth_principal_unavailable')
  })
})
