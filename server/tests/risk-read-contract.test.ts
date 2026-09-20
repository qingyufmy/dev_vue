import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import type { RiskService } from '../src/modules/risk/application/risk-service.js'
import { riskRoutes } from '../src/modules/risk/transport/http/risk-routes.js'

async function fixture() {
  const service = { policy: vi.fn(), summary: vi.fn(), manualReleaseState: vi.fn(), decisions: vi.fn(async () => []), decision: vi.fn() }
  const authenticate = vi.fn(async () => ({ userId: 42 }))
  // Let overlong opaque IDs reach the contract validator; the default router
  // otherwise rejects them earlier with 414 (before this module executes).
  const app = Fastify({ routerOptions: { maxParamLength: 256 } })
  await app.register(riskRoutes, { prefix: '/api/v4', service: service as unknown as RiskService,
    auth: { authenticate, assertWrite: authenticate } })
  return { app, service, authenticate }
}

it('preserves authentication failures as contract problems on all five read routes', async () => {
  const f = await fixture()
  try {
    f.authenticate.mockRejectedValue(new AuthError('session_required', 401))
    for (const url of ['/risk-accounts/7/policy', '/risk-accounts/7/summary', '/risk-accounts/7/manual-release',
      '/risk-decisions?account_id=7', '/risk-decisions/00000000-0000-4000-8000-000000000001']) {
      const response = await f.app.inject({ url: '/api/v4' + url })
      expect(response.statusCode).toBe(401)
      expect(response.headers['content-type']).toContain('application/problem+json')
      expect(response.json()).toMatchObject({ code: 'session_required', status: 401, retryable: false })
    }
    for (const method of Object.values(f.service)) expect(method).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('rejects invalid account and pagination inputs before invoking business reads', async () => {
  const f = await fixture()
  try {
    const invalidId = 'x'.repeat(192)
    for (const url of [`/risk-accounts/${invalidId}/policy`, `/risk-accounts/${invalidId}/summary`, `/risk-accounts/${invalidId}/manual-release`,
      '/risk-decisions', '/risk-decisions?account_id=7&page_size=abc', '/risk-decisions?account_id=7&page_size=0']) {
      const response = await f.app.inject({ url: '/api/v4' + url })
      expect(response.statusCode, url).toBe(400)
      expect(response.json()).toMatchObject({ code: 'api_request_invalid' })
    }
    for (const method of Object.values(f.service)) expect(method).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('validates a successful empty list and rejects malformed response data', async () => {
  const f = await fixture()
  try {
    const good = await f.app.inject({ url: '/api/v4/risk-decisions?account_id=7&page_size=10' })
    expect(good.statusCode).toBe(200)
    expect(good.json()).toMatchObject({ data: { items: [] } })
    expect(good.headers['cache-control']).toBe('no-store')
    expect(f.service.decisions).toHaveBeenCalledWith(42, '7', 10)
    f.service.decisions.mockResolvedValueOnce([{}] as never)
    const bad = await f.app.inject({ url: '/api/v4/risk-decisions?account_id=7' })
    expect(bad.statusCode).toBe(503)
    expect(bad.json()).toMatchObject({ code: 'api_response_invalid' })
  } finally { await f.app.close() }
})
