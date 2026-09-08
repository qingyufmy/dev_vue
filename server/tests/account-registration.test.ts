import type { PoolConnection } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import { createAccountRegistration } from '../src/modules/trading/composition.js'

const input = { platform: 'mt5' as const, brokerServer: 'Broker-Demo', login: '10001', currency: 'USD', registeredAt: '2026-09-08T00:00:00.000Z' }
function fixture(results: unknown[]) {
  const execute = vi.fn(async (..._args: unknown[]) => {
    if (!results.length) throw new Error('unexpected_query')
    return [results.shift(), []]
  })
  // No pool/commit capability is provided: the external transaction owns them.
  return { execute, registration: createAccountRegistration({ execute } as unknown as PoolConnection) }
}

describe('transaction-bound account registration (SQL double)', () => {
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
