import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import type { TradingService, ConnectionCapacityService } from '../src/modules/trading/application/trading-service.js'
import { TradingAccessError } from '../src/modules/trading/domain/trading.js'
import { tradingRoutes } from '../src/modules/trading/transport/http/trading-routes.js'

const headers = { 'x-csrf-token': 'valid-test-csrf-token' }
async function fixture() {
  let revision = 0
  const selectAccount = vi.fn(async (userId: number, accountId: string, expected: number) => {
    if (expected !== revision) throw new TradingAccessError('revision_conflict', 409)
    return { userId, accountId, mode: 'full', observerChannelId: null, readOnly: false, revision: ++revision }
  })
  const enterObserver = vi.fn(async () => ({ userId: 42, accountId: null, mode: 'observer', observerChannelId: 'obs', readOnly: true, revision: 1 }))
  const leaveObserver = vi.fn(async () => ({ userId: 42, accountId: null, mode: 'blocked', observerChannelId: null, readOnly: true, revision: 1 }))
  const assertWrite = vi.fn(async () => ({ userId: 42 }))
  const app = Fastify()
  await app.register(tradingRoutes, { prefix: '/api/v4', service: { selectAccount, enterObserver, leaveObserver } as unknown as TradingService,
    capacity: {} as ConnectionCapacityService, auth: { authenticate: assertWrite, assertWrite } })
  return { app, selectAccount, enterObserver, leaveObserver, assertWrite }
}

it('requires canonical safe revisions and an unambiguous target before writing', async () => {
  const f = await fixture()
  try {
    for (const expected_revision of [undefined, '', '01', '-1', '1e2', '1.5', '9007199254740991', '9007199254740992']) {
      const result = await f.app.inject({ method: 'PUT', url: '/api/v4/trading-context', headers,
        payload: { mode: 'full', account_id: '7', expected_revision } })
      expect(result.statusCode, String(expected_revision)).toBe(400)
    }
    for (const payload of [
      { mode: 'full', expected_revision: '0' },
      { mode: 'observer', account_id: '7', expected_revision: '0' },
      { mode: 'full', account_id: '7', observer_channel_id: 'obs', expected_revision: '0' },
      { mode: 'full', account_id: '7', expected_revision: '0', user_id: '99' },
    ]) expect((await f.app.inject({ method: 'PUT', url: '/api/v4/trading-context', headers, payload })).statusCode).toBe(400)
    expect(f.selectAccount).not.toHaveBeenCalled()
    expect(f.enterObserver).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('preserves revision conflicts for a repeated write instead of claiming idempotent replay', async () => {
  const f = await fixture()
  try {
    const request = { method: 'PUT' as const, url: '/api/v4/trading-context', headers, payload: { mode: 'full', account_id: '7', expected_revision: '0' } }
    expect((await f.app.inject(request)).statusCode).toBe(200)
    const repeated = await f.app.inject(request)
    expect(repeated.statusCode).toBe(409)
    expect(repeated.json().code).toBe('revision_conflict')
    expect(f.selectAccount).toHaveBeenLastCalledWith(42, '7', 0)
  } finally { await f.app.close() }
})

it('validates observer exit revision and CSRF format without calling the use case', async () => {
  const f = await fixture()
  try {
    for (const suffix of ['', '?expected_revision=', '?expected_revision=1e2', '?expected_revision=0&expected_revision=1']) {
      expect((await f.app.inject({ method: 'DELETE', url: '/api/v4/trading-context/observer' + suffix, headers })).statusCode).toBe(400)
    }
    expect((await f.app.inject({ method: 'DELETE', url: '/api/v4/trading-context/observer?expected_revision=0' })).statusCode).toBe(400)
    expect(f.leaveObserver).not.toHaveBeenCalled()
    expect((await f.app.inject({ method: 'DELETE', url: '/api/v4/trading-context/observer?expected_revision=0', headers })).statusCode).toBe(200)
    expect(f.leaveObserver).toHaveBeenCalledWith(42, 0)
  } finally { await f.app.close() }
})

it('authenticates writes before validating an invalid payload', async () => {
  const f = await fixture()
  f.assertWrite.mockRejectedValue(new AuthError('csrf_invalid', 403))
  try {
    const result = await f.app.inject({ method: 'PUT', url: '/api/v4/trading-context', payload: {} })
    expect(result.statusCode).toBe(403)
    expect(result.json().code).toBe('csrf_invalid')
    expect(f.selectAccount).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('reports an unknown result when a completed use case returns an invalid response', async () => {
  const f = await fixture()
  f.enterObserver.mockResolvedValue({ secret: 'must-not-leak' } as never)
  try {
    const result = await f.app.inject({ method: 'PUT', url: '/api/v4/trading-context', headers,
      payload: { mode: 'observer', observer_channel_id: 'obs', expected_revision: '0' } })
    expect(result.statusCode).toBe(503)
    expect(result.json().code).toBe('trading_context_commit_unknown')
    expect(result.body).not.toContain('must-not-leak')
    expect(f.enterObserver).toHaveBeenCalledTimes(1)
  } finally { await f.app.close() }
})
