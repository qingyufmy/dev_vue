import { describe, it, expect, vi } from 'vitest'

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(() => []),
  queryRun: vi.fn(),
  beijingNow: vi.fn(),
}))

import { queryAll } from '../../server/db.js'
import { getAutoSubscribers } from '../../server/routes/ai/config.js'

describe('automatic inference subscriber entitlement', () => {
  it('excludes expired Pro users in the database query', async () => {
    await getAutoSubscribers(1, 'XAUUSD')

    const sql = queryAll.mock.calls[0][0]
    expect(sql).toContain("u.plan = 'pro'")
    expect(sql).toContain('u.plan_expires_at IS NULL')
    expect(sql).toContain('u.plan_expires_at >= NOW()')
  })
})
