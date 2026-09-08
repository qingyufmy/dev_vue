import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { TradingService, type ConnectionCapacityService } from '../src/modules/trading/application/trading-service.js'
import type { TradingReadRepository } from '../src/modules/trading/application/trading-ports.js'
import { tradingRoutes } from '../src/modules/trading/transport/http/trading-routes.js'

async function fixture() {
  const repository = {
    getContext: vi.fn(async () => null),
    listAccounts: vi.fn(async () => [{ id: '7', platform: 'mt5', login: '100', server: 'demo', currency: 'USD',
      terminalProfileId: null, terminalInstanceId: null, bridgeState: 'offline', tradePermission: false, lastSeenAt: null }]),
    listObserverChannels: vi.fn(async () => [{ id: 'observer-1', displayName: 'Observation', sourceAccountId: '7', active: true }]),
  }
  const authenticate = vi.fn(async () => ({ userId: 42 }))
  const app = Fastify()
  await app.register(tradingRoutes, { prefix: '/api/v4', service: new TradingService(repository as unknown as TradingReadRepository),
    contextCommands: { async execute() { throw Error('unexpected-write') }, async receipt() { throw Error('unexpected-receipt') } }, capacity: {} as ConnectionCapacityService, auth: { authenticate, assertWrite: authenticate } })
  return { app, repository, authenticate }
}

describe('account entry read contracts', () => {
  it('returns blocked initial context and authorized lists with the authenticated user scope', async () => {
    const { app, repository } = await fixture()
    try {
      const context = await app.inject('/api/v4/trading-context')
      expect(context.statusCode).toBe(200)
      expect(context.json().data).toMatchObject({ user_id: '42', mode: 'blocked', account_id: null, revision: '0' })
      const accounts = await app.inject('/api/v4/trading-accounts?access=history&user_id=99')
      expect(accounts.statusCode).toBe(200)
      expect(accounts.json().data.items[0]).toMatchObject({ id: '7', bridge_state: 'offline', last_seen_at: null })
      expect(repository.listAccounts).toHaveBeenCalledWith(42, 'history')
      expect((await app.inject('/api/v4/observer-channels')).statusCode).toBe(200)
      expect(repository.listObserverChannels).toHaveBeenCalledWith(42)
    } finally { await app.close() }
  })

  it('rejects invalid access before calling the use case repository', async () => {
    const { app, repository } = await fixture()
    try {
      for (const query of ['access=all', 'access=current&access=history']) {
        const result = await app.inject('/api/v4/trading-accounts?' + query)
        expect(result.statusCode).toBe(400)
        expect(result.headers['content-type']).toContain('application/problem+json')
        expect(result.json().code).toBe('api_request_invalid')
      }
      expect(repository.listAccounts).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it.each([401, 403])('preserves authentication status %s before validating query input', async status => {
    const { app, repository, authenticate } = await fixture()
    authenticate.mockRejectedValue(new AuthError('session_unavailable', status))
    try {
      for (const url of ['/trading-context', '/trading-accounts?access=bad', '/observer-channels']) {
        const result = await app.inject('/api/v4' + url)
        expect(result.statusCode).toBe(status)
        expect(result.json()).toMatchObject({ status, code: 'session_unavailable' })
      }
      expect(repository.listAccounts).not.toHaveBeenCalled()
      expect(repository.getContext).not.toHaveBeenCalled()
      expect(repository.listObserverChannels).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('rejects malformed success data without returning its values', async () => {
    const { app, repository } = await fixture()
    repository.listAccounts.mockResolvedValue([{ id: 'secret-invalid-account' }] as never)
    try {
      const result = await app.inject('/api/v4/trading-accounts')
      expect(result.statusCode).toBe(503)
      expect(result.json().code).toBe('api_response_invalid')
      expect(result.body).not.toContain('secret-invalid-account')
    } finally { await app.close() }
  })

  it('replaces invalid error bodies with a validated fixed error', async () => {
    const { app, authenticate } = await fixture()
    authenticate.mockRejectedValue(new AuthError('secret-invalid-error', 418))
    try {
      const result = await app.inject('/api/v4/observer-channels')
      expect(result.statusCode).toBe(503)
      expect(result.json()).toMatchObject({ status: 503, code: 'api_response_invalid' })
      expect(result.body).not.toContain('secret-invalid-error')
    } finally { await app.close() }
  })
})
