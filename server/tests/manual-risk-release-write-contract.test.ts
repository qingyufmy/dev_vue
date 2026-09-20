import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { RiskError } from '../src/modules/risk/domain/risk.js'
import type { RiskService } from '../src/modules/risk/application/risk-service.js'
import { riskRoutes } from '../src/modules/risk/transport/http/risk-routes.js'

async function fixture() {
  const app = Fastify(), create = vi.fn(), assertWrite = vi.fn(async () => ({ userId: 42 }))
  await app.register(riskRoutes, { prefix: '/api/v4', service: { createManualRelease: create } as unknown as RiskService,
    auth: { assertWrite, authenticate: async () => ({ userId: 42 }) } })
  return { app, create, assertWrite }
}
const headers = { 'if-match': '"8"', 'idempotency-key': 'original-request-key', 'x-csrf-token': 'csrf-test-token-0123456789abcdef' }
const payload = { acknowledge_risk: true, reason: 'confirmed reason' }
const url = '/api/v4/risk-accounts/7/manual-release'

it('rejects malformed writes before invoking the use case and retains missing-version semantics', async () => {
  const f = await fixture()
  try {
    for (const body of [{ ...payload, acknowledge_risk: false }, { ...payload, reason: 'x' }, { ...payload, extra: true }]) {
      const response = await f.app.inject({ method: 'POST', url, headers, payload: body })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ code: 'api_request_invalid' })
    }
    const response = await f.app.inject({ method: 'POST', url, payload })
    expect(response.statusCode).toBe(428)
    expect(f.create).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('preserves authorization and commit-unknown errors as distinct contract problems', async () => {
  const f = await fixture()
  try {
    f.assertWrite.mockRejectedValueOnce(new AuthError('csrf_invalid', 403))
    let response = await f.app.inject({ method: 'POST', url, headers, payload })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'csrf_invalid', retryable: false })
    expect(f.create).not.toHaveBeenCalled()
    f.create.mockRejectedValueOnce(new RiskError('risk_commit_unknown', 503))
    response = await f.app.inject({ method: 'POST', url, headers, payload })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ code: 'risk_commit_unknown', retryable: true })
    expect(f.create).toHaveBeenCalledTimes(1)
  } finally { await f.app.close() }
})

it('rejects invalid post-commit response data without representing it as a known failed write', async () => {
  const f = await fixture()
  try {
    f.create.mockResolvedValueOnce({ revision: 1, baseline: {} })
    const response = await f.app.inject({ method: 'POST', url, headers, payload })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ code: 'api_response_invalid' })
    expect(f.create).toHaveBeenCalledTimes(1)
  } finally { await f.app.close() }
})
