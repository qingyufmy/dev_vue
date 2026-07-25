import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryRun: vi.fn(),
  withTransaction: vi.fn(),
}))

vi.mock('../server/bridge-auth-session.js', () => ({
  assertBridgeEligible: vi.fn(),
  createBridgeRefreshSession: vi.fn(),
}))

import { queryRun, withTransaction } from '../server/db.js'
import { assertBridgeEligible, createBridgeRefreshSession } from '../server/bridge-auth-session.js'
import {
  approveBridgePairing, consumeBridgePairing, startBridgePairing,
} from '../server/bridge-pairing.js'

describe('bridge device pairing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stores only hashes while returning separate device and user codes', async () => {
    queryRun.mockResolvedValue({ changes: 1 })
    const result = await startBridgePairing({ deviceName: 'Desk PC', ip: '127.0.0.1' })

    expect(result.deviceCode.length).toBeGreaterThan(40)
    expect(result.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(result.verificationPath).toBe('/bridge/pair')
    const [sql, params] = queryRun.mock.calls[0]
    expect(sql).toContain('INSERT INTO bridge_device_pairings')
    expect(params[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(params[1]).toMatch(/^[a-f0-9]{64}$/)
    expect(params).not.toContain(result.deviceCode)
    expect(params).not.toContain(result.userCode)
  })

  it('approves one valid pending code for an eligible signed-in user', async () => {
    queryRun.mockResolvedValue({ changes: 1 })
    await expect(approveBridgePairing(
      { id: 7, role: 'user', plan: 'pro' },
      'ABCD-2345',
      { ip: '1.2.3.4' },
    )).resolves.toEqual({ approved: true })

    expect(assertBridgeEligible).toHaveBeenCalled()
    expect(queryRun.mock.calls[0][0]).toContain("status = 'approved'")
    expect(queryRun.mock.calls[0][1][3]).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns pending without issuing a refresh credential', async () => {
    const run = vi.fn().mockResolvedValueOnce([[
      { pairing_id: 8, pairing_status: 'pending', pairing_expired: 0 },
    ], []])
    withTransaction.mockImplementation(callback => callback(run))

    await expect(consumeBridgePairing('x'.repeat(48))).resolves.toEqual({ status: 'pending' })
    expect(createBridgeRefreshSession).not.toHaveBeenCalled()
  })

  it('issues the refresh credential and consumes approval in one transaction', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce([[
        {
          pairing_id: 9, pairing_status: 'approved', pairing_expired: 0,
          pairing_token_version: 3,
          id: 7, role: 'user', plan: 'pro', plan_expires_at: null, token_version: 3,
        },
      ], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
    withTransaction.mockImplementation(callback => callback(run))
    createBridgeRefreshSession.mockResolvedValue({
      refreshToken: 'r'.repeat(64), expiresInSeconds: 7776000,
    })

    await expect(consumeBridgePairing('d'.repeat(48), {
      userAgent: 'AURUM', ip: '1.2.3.4',
    })).resolves.toMatchObject({ status: 'approved', refreshToken: 'r'.repeat(64) })
    expect(createBridgeRefreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      expect.objectContaining({ run }),
    )
    expect(run.mock.calls[1][0]).toContain("status = 'consumed'")
  })

  it('does not issue a credential after password logout invalidates the approval', async () => {
    const run = vi.fn().mockResolvedValueOnce([[
      {
        pairing_id: 10, pairing_status: 'approved', pairing_expired: 0,
        pairing_token_version: 3,
        id: 7, role: 'user', plan: 'pro', plan_expires_at: null, token_version: 4,
      },
    ], []])
    withTransaction.mockImplementation(callback => callback(run))

    await expect(consumeBridgePairing('z'.repeat(48)))
      .rejects.toMatchObject({ code: 'bridge_pair_device_code_consumed' })
    expect(createBridgeRefreshSession).not.toHaveBeenCalled()
  })

  it('rate-limits start and approval without exhausting the polling window', () => {
    const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
    expect(server).toContain("app.use('/api/auth/bridge-pair/start', authLimiter)")
    expect(server).toContain("app.use('/api/auth/bridge-pair/approve', authLimiter)")
    expect(server).not.toContain("app.use('/api/auth/bridge-pair', authLimiter)")
  })
})
