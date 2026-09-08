import type { PoolConnection } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import { createAccountRegistration } from '../src/modules/trading/composition.js'

const input = { platform: 'mt5' as const, brokerServer: 'Broker-Demo', login: '10001', currency: 'USD', registeredAt: '2026-09-08T00:00:00.000Z' }
function fixture(results: unknown[], active = true) {
  const execute = vi.fn(async (..._args: unknown[]) => {
    if (!results.length) throw new Error('unexpected_query')
    return [results.shift(), []]
  })
  // No pool/commit capability is provided: the external transaction owns them.
  const isActive = vi.fn(async (_userId: number, _lock: string) => active)
  return { execute, isActive, registration: createAccountRegistration({ execute } as unknown as PoolConnection, { isActive }) }
}

describe('transaction-bound account registration (SQL double)', () => {
  it('returns only account identity/currency and preserves large ownership revisions', async () => {
    const id = '18446744073709551615'
    const f = fixture([[{ id, currency: 'USD', internalDetail: 'not-a-public-field' }], [{ ownership_revision: id }]])
    await expect(f.registration.lockAccount(input)).resolves.toEqual({ id, currency: 'USD' })
    await expect(f.registration.lockCurrentOwnership({ userId: 7, accountId: id })).resolves.toBe(id)
    expect(f.execute.mock.calls[0]![1]).toEqual([input.platform, input.brokerServer, input.login])
    expect(f.execute.mock.calls[1]![1]).toEqual([7, id])
    expect(f.isActive).toHaveBeenCalledWith(7, 'update')
    expect(f.execute.mock.invocationCallOrder[1]).toBeLessThan(f.isActive.mock.invocationCallOrder[0]!)
  })

  it('does not grant ownership proof for missing, ambiguous or malformed revision rows', async () => {
    for (const rows of [[], [{ ownership_revision: '1' }, { ownership_revision: '1' }],
      [{ ownership_revision: '0' }], [{ ownership_revision: '-1' }], [{ ownership_revision: '1.5' }], [{ ownership_revision: null }]]) {
      const f = fixture([rows])
      await expect(f.registration.lockCurrentOwnership({ userId: 7, accountId: '42' })).resolves.toBeNull()
      expect(f.isActive).not.toHaveBeenCalled()
    }
    await expect(fixture([[]]).registration.lockAccount(input)).resolves.toBeNull()
  })

  it('rejects inactive principals after locking ownership and propagates unavailable identity checks', async () => {
    const inactive = fixture([[{ ownership_revision: '3' }]], false)
    await expect(inactive.registration.lockCurrentOwnership({ userId: 7, accountId: '42' })).resolves.toBeNull()
    expect(inactive.isActive).toHaveBeenCalledWith(7, 'update')
    const unavailable = fixture([[{ ownership_revision: '3' }]])
    unavailable.isActive.mockRejectedValueOnce(new Error('auth_principal_unavailable'))
    await expect(unavailable.registration.lockCurrentOwnership({ userId: 7, accountId: '42' })).rejects.toThrow('auth_principal_unavailable')
  })

  it('preserves unsigned BIGINT identity and the original ownership provenance', async () => {
    const id = '18446744073709551615'
    const f = fixture([{ affectedRows: 1 }, [{ id }], { affectedRows: 1 }, { affectedRows: 1 }])
    await expect(f.registration.createAccount(input)).resolves.toEqual({ ok: true, accountId: id })
    await expect(f.registration.grantFirstOwnership({ userId: 7, accountId: id, registeredAt: input.registeredAt })).resolves.toEqual({ ok: true })
    expect(f.execute.mock.calls[0]![1]).toEqual([input.platform, input.brokerServer, input.login, input.currency, input.registeredAt, input.registeredAt])
    expect(f.execute.mock.calls[2]![1]).toEqual([expect.any(String), 7, id, input.registeredAt, `bridge-first-account:${id}`, input.registeredAt, input.registeredAt])
    expect(f.execute.mock.calls[3]![1]).toEqual([7, id, input.registeredAt, expect.any(String)])
  })

  it('rejects invalid identity values without number coercion', async () => {
    for (const id of [42, null, '', '0', '1.5', '123456789012345678901']) {
      const f = fixture([{ affectedRows: 1 }, [{ id }]])
      await expect(f.registration.createAccount(input)).resolves.toEqual({ ok: false, reason: 'storage_invalid' })
      expect(f.execute).toHaveBeenCalledTimes(2)
    }
  })

  it('stops on unexpected insert counts so the transaction owner can roll back', async () => {
    const creation = fixture([{ affectedRows: 0 }])
    await expect(creation.registration.createAccount(input)).resolves.toEqual({ ok: false, reason: 'storage_unavailable' })
    expect(creation.execute).toHaveBeenCalledOnce()
    for (const results of [[{ affectedRows: 0 }], [{ affectedRows: 1 }, { affectedRows: 0 }]]) {
      const expectedCalls = results.length
      const f = fixture(results)
      await expect(f.registration.grantFirstOwnership({ userId: 7, accountId: '42', registeredAt: input.registeredAt }))
        .resolves.toEqual({ ok: false, reason: 'storage_unavailable' })
      expect(f.execute).toHaveBeenCalledTimes(expectedCalls)
    }
  })
})
