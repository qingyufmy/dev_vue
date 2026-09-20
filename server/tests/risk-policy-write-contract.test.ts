import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { DEFAULT_RISK_POLICY, resolveRiskPolicy, RiskError } from '../src/modules/risk/domain/risk.js'
import type { RiskService } from '../src/modules/risk/application/risk-service.js'
import { riskRoutes } from '../src/modules/risk/transport/http/risk-routes.js'

const url = '/api/v4/risk-accounts/7/policy'
const headers = { 'if-match': '"3"', 'idempotency-key': 'original-policy-key', 'x-csrf-token': 'csrf-test-token-0123456789abcdef' }
const payload = { max_risk_per_trade_percent: '0.5', reason: '降低单笔风险' }

async function fixture() {
  const app = Fastify(), replacePolicy = vi.fn(), assertWrite = vi.fn(async () => ({ userId: 42 }))
  await app.register(riskRoutes, { prefix: '/api/v4', service: { replacePolicy } as unknown as RiskService,
    auth: { assertWrite, authenticate: async () => ({ userId: 42 }) } })
  return { app, replacePolicy, assertWrite }
}

it('validates policy input before mutation and retains missing revision as 428', async () => {
  const f = await fixture()
  try {
    for (const body of [{ ...payload, extra: true }, { ...payload, max_open_positions: 'two' }, { ...payload, reason: 'x' }]) {
      const result = await f.app.inject({ method: 'PUT', url, headers, payload: body })
      expect(result.statusCode).toBe(400)
      expect(result.json()).toMatchObject({ code: 'api_request_invalid' })
    }
    expect((await f.app.inject({ method: 'PUT', url, payload })).statusCode).toBe(428)
    expect(f.replacePolicy).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('preserves authorization, stale revision and unknown commit problems', async () => {
  const f = await fixture()
  try {
    f.assertWrite.mockRejectedValueOnce(new AuthError('csrf_invalid', 403))
    expect((await f.app.inject({ method: 'PUT', url, headers, payload })).statusCode).toBe(403)
    expect(f.replacePolicy).not.toHaveBeenCalled()
    for (const [code, status] of [['risk_policy_revision_conflict', 412], ['risk_commit_unknown', 503]] as const) {
      f.replacePolicy.mockRejectedValueOnce(new RiskError(code, status))
      const result = await f.app.inject({ method: 'PUT', url, headers, payload })
      expect(result.statusCode).toBe(status)
      expect(result.headers['content-type']).toContain('application/problem+json')
      expect(result.json()).toMatchObject({ code, retryable: status >= 500 })
    }
  } finally { await f.app.close() }
})

it('returns validated policy and revision while rejecting corrupt post-write output', async () => {
  const f = await fixture()
  try {
    const policy = resolveRiskPolicy({ accountId: '7', userId: 42, platformPolicyVersionId: '101',
      accountPolicyVersionId: '102', policySetRevision: 4,
      platform: { values: { ...DEFAULT_RISK_POLICY }, globalKillSwitch: false, revision: 2 },
      account: { maxRiskPerTradePercent: 0.5 }, updatedAt: '2026-09-09T00:00:00.000Z' })
    f.replacePolicy.mockResolvedValueOnce(policy)
    const result = await f.app.inject({ method: 'PUT', url, headers, payload })
    expect(result.statusCode).toBe(200)
    expect(result.headers.etag).toBe('"4"')
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.json().data).toMatchObject({ account_id: '7', revision: '4', max_risk_per_trade_percent: '0.5' })
    expect(f.replacePolicy).toHaveBeenCalledWith(42, '7', 3, { maxRiskPerTradePercent: 0.5 }, payload.reason, 'original-policy-key')
    f.replacePolicy.mockResolvedValueOnce({ ...policy, updatedAt: 'invalid-date' })
    const corrupt = await f.app.inject({ method: 'PUT', url, headers, payload })
    expect(corrupt.statusCode).toBe(503)
    expect(corrupt.json()).toMatchObject({ code: 'api_response_invalid' })
  } finally { await f.app.close() }
})
