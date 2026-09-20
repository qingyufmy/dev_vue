import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { RiskService } from '../src/modules/risk/application/risk-service.js'
import type { RiskRepository } from '../src/modules/risk/application/risk-ports.js'
import { DEFAULT_RISK_POLICY, resolveRiskPolicy } from '../src/modules/risk/domain/risk.js'
import { riskRoutes } from '../src/modules/risk/transport/http/risk-routes.js'
import { AuthError } from '../src/modules/auth/index.js'

it('returns the original policy or unconfirmed, rejects missing keys, and reauthenticates each query', async () => {
  const lookup = vi.fn(), authenticate = vi.fn(async () => ({ userId: 42 }))
  const service = new RiskService({ getPolicyReceipt: lookup } as unknown as RiskRepository)
  const app = Fastify()
  await app.register(riskRoutes, { prefix: '/api/v4', service,
    auth: { authenticate, assertWrite: async () => { throw Error('unexpected write') } } })
  const path = '/api/v4/risk-accounts/7/policy-receipt'
  const url = path + '?idempotency_key=original-policy-key'
  try {
    expect((await app.inject({ url: path })).statusCode).toBe(400)
    expect(lookup).not.toHaveBeenCalled()
    lookup.mockResolvedValueOnce(null)
    const unknown = await app.inject({ url })
    expect(unknown.statusCode).toBe(200)
    expect(unknown.json().data).toEqual({ state: 'unconfirmed', policy: null })
    const policy = resolveRiskPolicy({ userId: 42, accountId: '7', platformPolicyVersionId: '101', accountPolicyVersionId: '103', policySetRevision: 4,
      platform: { values: DEFAULT_RISK_POLICY, globalKillSwitch: false, revision: 1 }, account: {}, updatedAt: '2026-09-09T00:00:00.000Z' })
    lookup.mockResolvedValueOnce({ policy, requestHash: 'stored' })
    const known = await app.inject({ url })
    expect(known.statusCode).toBe(200)
    expect(known.headers['cache-control']).toBe('no-store')
    expect(known.json().data).toMatchObject({ state: 'confirmed', policy: { revision: '4', account_policy_version_id: '103' } })
    expect(lookup).toHaveBeenLastCalledWith(42, '7', 'original-policy-key')
    const historical = JSON.parse(JSON.stringify(policy))
    delete historical.values.maxOrderVolume
    delete historical.numericControls
    const frozen = JSON.stringify(historical)
    lookup.mockResolvedValueOnce({ policy: historical, requestHash: 'stored' })
    const legacy = await app.inject({ url })
    expect(legacy.statusCode).toBe(200)
    expect(legacy.json().data.state).toBe('confirmed')
    expect(legacy.json().data.policy).not.toHaveProperty('max_order_volume')
    expect(JSON.stringify(historical)).toBe(frozen)
    lookup.mockResolvedValueOnce({ policy: { ...policy, accountId: '8' } })
    expect((await app.inject({ url })).statusCode).toBe(403)
    authenticate.mockRejectedValueOnce(new AuthError('session_required', 401))
    expect((await app.inject({ url })).statusCode).toBe(401)
    expect(lookup).toHaveBeenCalledTimes(4)
  } finally { await app.close() }
})
