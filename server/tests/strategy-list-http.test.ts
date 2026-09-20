import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { createStrategyHttp } from '../src/modules/strategies/composition.js'
import type { StrategyService } from '../src/modules/strategies/index.js'

it('owns strategy listing in the strategy module with authentication and strict read contracts', async () => {
  const list = vi.fn().mockResolvedValue([]), authenticate = vi.fn().mockResolvedValue({ userId: 7 })
  const app = Fastify()
  await app.register(createStrategyHttp({ list } as unknown as StrategyService, { authenticate, assertWrite: authenticate }))
  try {
    authenticate.mockRejectedValueOnce(new AuthError('auth_session_invalid', 401))
    expect((await app.inject('/api/v4/strategies?kind=invalid')).statusCode).toBe(401)
    for (const query of ['kind=invalid', 'kind=analysis&kind=trader', 'actor=8']) {
      expect((await app.inject('/api/v4/strategies?' + query)).statusCode).toBe(400)
    }
    expect(list).not.toHaveBeenCalled()
    const response = await app.inject('/api/v4/strategies?kind=analysis')
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store')
    expect(list).toHaveBeenCalledWith(7, 'analysis')
    list.mockResolvedValueOnce([{ id: 'private-invalid' }])
    const invalid = await app.inject('/api/v4/strategies')
    expect(invalid.statusCode).toBe(503); expect(invalid.body).not.toContain('private-invalid')
  } finally { await app.close() }
})
it('validates detail and subscription reads before accessing the scoped service', async () => {
  const detail = vi.fn().mockResolvedValue(null), listSubscriptions = vi.fn().mockResolvedValue([])
  const authenticate = vi.fn().mockResolvedValue({ userId: 7 })
  const app = Fastify()
  await app.register(createStrategyHttp({ detail, listSubscriptions } as unknown as StrategyService, { authenticate, assertWrite: authenticate }))
  try {
    authenticate.mockRejectedValueOnce(new AuthError('auth_session_invalid', 401))
    expect((await app.inject('/api/v4/strategies/s1?actor=9')).statusCode).toBe(401)
    expect((await app.inject('/api/v4/strategies/s1?actor=9')).statusCode).toBe(400)
    expect((await app.inject('/api/v4/strategy-subscriptions?account_id=42&account_id=43')).statusCode).toBe(400)
    expect(detail).not.toHaveBeenCalled(); expect(listSubscriptions).not.toHaveBeenCalled()
    expect((await app.inject('/api/v4/strategies/s1')).statusCode).toBe(404)
    expect(detail).toHaveBeenCalledWith(7, 's1')
    const response = await app.inject('/api/v4/strategy-subscriptions?account_id=42')
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store')
    expect(listSubscriptions).toHaveBeenCalledWith(7, '42')
    listSubscriptions.mockResolvedValueOnce([{ id: 'private-invalid' }])
    const invalid = await app.inject('/api/v4/strategy-subscriptions')
    expect(invalid.statusCode).toBe(503); expect(invalid.body).not.toContain('private-invalid')
  } finally { await app.close() }
})
