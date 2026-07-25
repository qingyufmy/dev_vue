import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryOne: vi.fn(),
  queryRun: vi.fn(),
}))

import { queryOne, queryRun } from '../server/db.js'
import {
  consumeBridgeConnectionTicket,
  createBridgeConnectionTicket,
  createBridgeRefreshSession,
  revokeBridgeRefreshSession,
  revokeBridgeRefreshSessions,
  useBridgeRefreshSession,
} from '../server/bridge-auth-session.js'

describe('bridge refresh sessions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a hashed durable device session for an eligible Bridge user', async () => {
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
    expect(queryRun.mock.calls[1][0]).not.toContain('expires_at <= NOW()')
  })

  it('does not create a Bridge session for a non-Pro user', async () => {
    await expect(createBridgeRefreshSession({ id: 9, role: 'user', plan: 'plus' }))
      .rejects.toMatchObject({ code: 'bridge_membership_required' })
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('keeps a device authorization active without a fixed expiry gate', async () => {
    queryOne.mockResolvedValue({
      session_id: 12, id: 4, role: 'user', plan: 'pro', plan_expires_at: null,
    })
    queryRun.mockResolvedValue({ changes: 1 })
    const result = await useBridgeRefreshSession('x'.repeat(64), { userAgent: 'bridge', ip: '1.2.3.4' })
    expect(result.user.id).toBe(4)
    expect(queryOne.mock.calls[0][1][0]).toMatch(/^[a-f0-9]{64}$/)
    expect(queryOne.mock.calls[0][0]).not.toContain('sessions.expires_at > NOW()')
    expect(queryRun.mock.calls[0][0]).not.toContain('expires_at =')
    expect(queryRun.mock.calls[0][0]).toContain('last_used_at = NOW()')
  })

  it('rejects missing and explicitly invalidated refresh credentials', async () => {
    await expect(useBridgeRefreshSession('short')).rejects.toMatchObject({ code: 'bridge_refresh_invalid' })
    queryOne.mockResolvedValue(null)
    await expect(useBridgeRefreshSession('x'.repeat(64))).rejects.toMatchObject({ code: 'bridge_refresh_revoked' })
  })

  it('revokes every active Bridge session after a password change or logout', async () => {
    queryRun.mockResolvedValue({ changes: 2 })
    await revokeBridgeRefreshSessions(15)
    expect(queryRun).toHaveBeenCalledWith(expect.stringContaining('revoked_at'), [15])
  })

  it('uses the caller transaction when revoking sessions atomically with an account change', async () => {
    const run = vi.fn().mockResolvedValue([{ affectedRows: 2 }, []])
    await revokeBridgeRefreshSessions(15, { run })
    expect(run).toHaveBeenCalledWith(expect.stringContaining('revoked_at'), [15])
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('revokes only the refresh session selected by Bridge logout', async () => {
    queryRun.mockResolvedValue({ affectedRows:1 })
    await expect(revokeBridgeRefreshSession(15, 'r'.repeat(64))).resolves.toBe(true)
    expect(queryRun).toHaveBeenCalledWith(expect.stringContaining('token_hash = ?'), [
      15, expect.stringMatching(/^[a-f0-9]{64}$/),
    ])
  })
})

describe('bridge websocket tickets', () => {
  it('creates an opaque ticket and consumes it exactly once', async () => {
    const issued = await createBridgeConnectionTicket({
      id: 7, role: 'user', plan: 'pro', plan_expires_at: null, token_version: 3,
    }, { redis: null })
    expect(issued.ticket.length).toBeGreaterThan(40)
    expect(issued.expiresInSeconds).toBe(30)
    await expect(consumeBridgeConnectionTicket(issued.ticket, { redis: null }))
      .resolves.toEqual({ userId: 7, tokenVersion: 3 })
    await expect(consumeBridgeConnectionTicket(issued.ticket, { redis: null }))
      .rejects.toMatchObject({ code: 'bridge_ticket_expired' })
  })

  it('rejects malformed tickets and ineligible users', async () => {
    await expect(consumeBridgeConnectionTicket('short', { redis: null }))
      .rejects.toMatchObject({ code: 'bridge_ticket_invalid' })
    await expect(createBridgeConnectionTicket({ id: 8, role: 'user', plan: 'plus' }, { redis: null }))
      .rejects.toMatchObject({ code: 'bridge_membership_required' })
  })

  it('stores and atomically consumes tickets through Redis when available', async () => {
    const values = new Map()
    const redis = {
      set: vi.fn(async (key, value) => { values.set(key, value); return 'OK' }),
      eval: vi.fn(async (_script, _count, key) => {
        const value = values.get(key) || null
        values.delete(key)
        return value
      }),
    }
    const issued = await createBridgeConnectionTicket({
      id: 9, role: 'admin', plan: 'free', token_version: 5,
    }, { redis })
    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining('bridge:ws-ticket:'), expect.any(String), 'NX', 'EX', 30)
    await expect(consumeBridgeConnectionTicket(issued.ticket, { redis }))
      .resolves.toEqual({ userId: 9, tokenVersion: 5 })
    expect(redis.eval).toHaveBeenCalledTimes(1)
  })
})
