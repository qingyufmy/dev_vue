import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { listAdminReferralRules } from '../src/modules/commerce/infrastructure/mysql-referral-rule-list.js'
const row = { id: '2', plan: 'plus', period: 'monthly', rate_bps: '0', enabled: '0', revision: '9007199254740993' }
function fixture(rows: object[], activeAdmin = true) {
  const c = { beginTransaction: vi.fn(), execute: vi.fn().mockResolvedValue([activeAdmin ? [{ id: 1 }] : [], []]),
    query: vi.fn().mockResolvedValue([rows, []]), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  return { c, pool: { getConnection: async () => c } as unknown as Pick<Pool, 'getConnection'> }
}
describe('administrator referral rule list', () => {
  it('preserves disabled/zero and bigint precision, with no synthesized missing rules', async () => {
    const f = fixture([row])
    expect(await listAdminReferralRules(f.pool, 1)).toEqual([{ id: '2', plan: 'plus', period: 'monthly', rateBps: 0, enabled: false, revision: '9007199254740993' }])
    expect(f.c.rollback).toHaveBeenCalledOnce()
    expect(f.c.release).toHaveBeenCalledOnce()
    expect(await listAdminReferralRules(fixture([]).pool, 1)).toEqual([])
  })
  it('checks active administrator permission before reading any rules', async () => {
    const f = fixture([row], false)
    await expect(listAdminReferralRules(f.pool, 1)).rejects.toThrow('admin_required')
    expect(f.c.query).not.toHaveBeenCalled()
    expect(f.c.rollback).toHaveBeenCalledOnce()
  })
  it('rejects duplicate, out-of-scope, excessive and corrupt rows rather than truncating silently', async () => {
    for (const rows of [[row, row], [{ ...row, plan: 'PLUS' }], [{ ...row, rate_bps: '10001' }],
      [{ ...row, revision: '18446744073709551616' }], Array(5).fill(row)])
      await expect(listAdminReferralRules(fixture(rows).pool, 1)).rejects.toThrow('state_invalid')
  })
})
