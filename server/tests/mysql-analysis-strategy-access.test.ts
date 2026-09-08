import type { PoolConnection } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { createAnalysisStrategyAccess } from '../src/modules/strategies/composition.js'

it('preserves unsigned identity and the caller transaction shared lock', async () => {
  const execute = vi.fn(async () => [[{ id: '18446744073709551615' }], []])
  const access = createAnalysisStrategyAccess({ execute } as unknown as PoolConnection)
  await expect(access.canUse(7, '18446744073709551615')).resolves.toBe(true)
  expect(execute).toHaveBeenCalledWith(expect.stringContaining('FOR SHARE'), ['18446744073709551615', 7])
})

it('rejects malformed or overflowing identities before querying', async () => {
  const execute = vi.fn()
  const access = createAnalysisStrategyAccess({ execute } as unknown as PoolConnection)
  for (const id of ['', '0', '01', '-1', '1.5', '18446744073709551616', '1 OR 1=1']) {
    await expect(access.canUse(7, id)).resolves.toBe(false)
  }
  for (const userId of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(access.canUse(userId, '1')).resolves.toBe(false)
  }
  expect(execute).not.toHaveBeenCalled()
})

it('fails closed for absent/ambiguous rows and sanitizes storage failure', async () => {
  const execute = vi.fn().mockResolvedValueOnce([[], []]).mockResolvedValueOnce([[{ id: 1 }, { id: 2 }], []])
    .mockRejectedValueOnce(new Error('private_sql_details'))
  const access = createAnalysisStrategyAccess({ execute } as unknown as PoolConnection)
  await expect(access.canUse(7, '1')).resolves.toBe(false)
  await expect(access.canUse(7, '1')).resolves.toBe(false)
  await expect(access.canUse(7, '1')).rejects.toThrow('strategy_access_unavailable')
})
