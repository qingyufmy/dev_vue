import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryOne: vi.fn(),
  queryRun: vi.fn(),
}))

import { queryOne, queryRun } from '../server/db.js'
import {
  createBridgeRefreshSession,
  revokeBridgeRefreshSessions,
  useBridgeRefreshSession,
} from '../server/bridge-auth-session.js'

describe('bridge refresh sessions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a hashed sliding session for an eligible Bridge user', async () => {
    queryRun.mockResolvedValue({ changes: 1, insertId: 8 })
    const result = await createBridgeRefreshSession({ id: 7, role: 'user', plan: 'pro', plan_expires_at: null }, {
      userAgent: 'bridge-test', ip: '127.0.0.1',
    })
    expect(result.refreshToken.length).toBeGreaterThan(40)
    expect(result.expiresInSeconds).toBe(90 * 86400)
    const [sql, params] = queryRun.mock.calls[0]
    expect(sql).toContain('INSERT INTO bridge_refresh_sessions')
    expect(params[0]).toBe(7)
    expect(params[1]).toMatch(/^[a-f0-9]{64}$/)
    expect(params[1]).not.toBe(result.refreshToken)
  })

  it('does not create a Bridge session for a non-Pro user', async () => {
    await expect(createBridgeRefreshSession({ id: 9, role: 'user', plan: 'plus' }))
      .rejects.toMatchObject({ code: 'bridge_membership_required' })
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('refreshes the sliding expiry after validating the stored hash', async () => {
    queryOne.mockResolvedValue({
      session_id: 12, id: 4, role: 'user', plan: 'pro', plan_expires_at: null,
    })
    queryRun.mockResolvedValue({ changes: 1 })
    const result = await useBridgeRefreshSession('x'.repeat(64), { userAgent: 'bridge', ip: '1.2.3.4' })
    expect(result.user.id).toBe(4)
    expect(queryOne.mock.calls[0][1][0]).toMatch(/^[a-f0-9]{64}$/)
    expect(queryRun.mock.calls[0][0]).toContain('expires_at = DATE_ADD')
  })

  it('rejects missing and expired refresh credentials', async () => {
    await expect(useBridgeRefreshSession('short')).rejects.toMatchObject({ code: 'bridge_refresh_invalid' })
    queryOne.mockResolvedValue(null)
    await expect(useBridgeRefreshSession('x'.repeat(64))).rejects.toMatchObject({ code: 'bridge_refresh_expired' })
  })

  it('revokes every active Bridge session after a password change or logout', async () => {
    queryRun.mockResolvedValue({ changes: 2 })
    await revokeBridgeRefreshSessions(15)
    expect(queryRun).toHaveBeenCalledWith(expect.stringContaining('revoked_at'), [15])
  })
})
