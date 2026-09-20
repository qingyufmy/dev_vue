import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { createStrategyHttp } from '../src/modules/strategies/composition.js'
import { compileStrategy, type StrategyService } from '../src/modules/strategies/application/strategy-service.js'
import { AuthError } from '../src/modules/auth/index.js'

it('validates pure compile transport without turning invalid strategy rules into a persistence request', async () => {
  const compile = vi.fn(compileStrategy), auth = vi.fn(async () => ({ userId: 7 }))
  const app = Fastify()
  await app.register(createStrategyHttp({ compile } as unknown as StrategyService, { authenticate: auth, assertWrite: auth }))
  const request = { method: 'POST' as const, url: '/api/v4/strategies/compile', headers: { 'x-csrf-token': 'csrf-token-123456789' },
    payload: { kind: 'analysis', prompt_text: 'analyse', config: {} } }
  try {
    auth.mockRejectedValueOnce(new AuthError('auth_csrf_invalid', 403))
    expect((await app.inject({ ...request, payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ ...request, url: request.url + '?actor=8' })).statusCode).toBe(400)
    expect((await app.inject({ ...request, payload: { ...request.payload, unknown: true } })).statusCode).toBe(400)
    expect(compile).not.toHaveBeenCalled()
    const invalidRules = await app.inject({ ...request, payload: { ...request.payload, config: { script: 'unsupported' } } })
    expect(invalidRules.statusCode).toBe(200)
    expect(invalidRules.json().data.valid).toBe(false)
    expect(invalidRules.headers['cache-control']).toBe('no-store')
    compile.mockReturnValueOnce({ valid: true } as ReturnType<typeof compileStrategy>)
    const badResult = await app.inject(request)
    expect(badResult.statusCode).toBe(503)
    expect(badResult.headers['content-type']).toContain('application/problem+json')
    expect(badResult.json().code).not.toBe('strategy_commit_unknown')
  } finally { await app.close() }
})
