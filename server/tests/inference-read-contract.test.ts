import type { StrategyService } from '../src/modules/strategies/index.js'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { InferenceService } from '../src/modules/inference/application/inference-service.js'
import type { InferenceRepository } from '../src/modules/inference/application/inference-ports.js'
import { inferenceRoutes, type InferenceRoutesOptions } from '../src/modules/inference/transport/http/inference-routes.js'

it('validates read queries after authentication and preserves scoped detail absence', async () => {
  const analysis = vi.fn().mockResolvedValue(null), decision = vi.fn().mockResolvedValue(null), decisions = vi.fn().mockResolvedValue([])
  const authenticate = vi.fn().mockResolvedValue({ userId: 7 })
  const app = Fastify()
  await app.register(inferenceRoutes, { prefix: '/api/v4',
    service: { analysis, decision, decisions } as unknown as InferenceRoutesOptions['service'],
    analysisList: { async list() { return { items: [], nextCursor: null } } },
    auth: { authenticate, assertWrite: authenticate } })
  try {
    for (const path of ['/market-analyses/a1', '/trade-decisions/d1', '/trade-decisions']) {
      authenticate.mockRejectedValueOnce(new AuthError('auth_session_invalid', 401))
      const r = await app.inject('/api/v4' + path + '?unknown=1')
      expect(r.statusCode).toBe(401); expect(r.headers['cache-control']).toBe('no-store')
      expect((await app.inject('/api/v4' + path + '?unknown=1')).statusCode).toBe(400)
    }
    expect(analysis).not.toHaveBeenCalled(); expect(decision).not.toHaveBeenCalled(); expect(decisions).not.toHaveBeenCalled()
    expect((await app.inject('/api/v4/market-analyses/a1')).statusCode).toBe(404)
    expect((await app.inject('/api/v4/trade-decisions/d1')).statusCode).toBe(404)
    expect(analysis).toHaveBeenCalledWith(7, 'a1'); expect(decision).toHaveBeenCalledWith(7, 'd1')
    expect((await app.inject('/api/v4/trade-decisions?account_id=42&page_size=200')).statusCode).toBe(200)
    expect(decisions).toHaveBeenCalledWith(7, '42', 200)
    decisions.mockResolvedValueOnce([{ id: 'private-invalid-row' }])
    const invalid = await app.inject('/api/v4/trade-decisions?account_id=42')
    expect(invalid.statusCode).toBe(503); expect(invalid.body).not.toContain('private-invalid-row')
  } finally { await app.close() }
})
it('keeps decision list limits consistent with the public 1–200 range without silently clamping', async () => {
  const listTraderDecisions = vi.fn().mockResolvedValue([])
  const service = new InferenceService({ listTraderDecisions } as unknown as InferenceRepository, {} as StrategyService)
  for (const limit of [0, 201, 1.5, NaN]) expect(() => service.decisions(7, '42', limit)).toThrow('decision_list_limit_invalid')
  expect(listTraderDecisions).not.toHaveBeenCalled()
  await service.decisions(7, '42', 200)
  expect(listTraderDecisions).toHaveBeenCalledWith(7, '42', 200)
})
