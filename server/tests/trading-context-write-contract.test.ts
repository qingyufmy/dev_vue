import { contextCommandPort } from './helpers/context-command-port.js'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import type { TradingService, ConnectionCapacityService } from '../src/modules/trading/application/trading-service.js'
import { TradingAccessError } from '../src/modules/trading/domain/trading.js'
import { tradingRoutes } from '../src/modules/trading/transport/http/trading-routes.js'

const key = 'd97382ac-4b49-42db-b1f1-850ec403848a'
const headers = { 'x-csrf-token': 'valid-test-csrf-token', 'idempotency-key': key }
async function fixture() {
  const memory = contextCommandPort()
  const execute = vi.fn(memory.port.execute), receipt = vi.fn(memory.port.receipt)
  const assertWrite = vi.fn(async () => ({ userId: 42 }))
  const app = Fastify()
  await app.register(tradingRoutes, { prefix: '/api/v4', service: { context: memory.context } as unknown as TradingService, contextCommands: { execute, receipt },
    capacity: {} as ConnectionCapacityService, auth: { authenticate: assertWrite, assertWrite } })
  return { app, execute, receipt, assertWrite }
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
    expect(f.execute).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('replays a keyed command and distinguishes stale new commands from changed bodies', async () => {
  const f = await fixture()
  try {
    const request = { method: 'PUT' as const, url: '/api/v4/trading-context', headers, payload: { mode: 'full', account_id: '7', expected_revision: '0' } }
    expect((await f.app.inject(request)).statusCode).toBe(200)
    const repeated = await f.app.inject(request)
    expect(repeated.statusCode).toBe(200)
    expect(repeated.json().data.revision).toBe('1')
    const changed = await f.app.inject({ ...request, payload: { ...request.payload, account_id: '8' } })
    expect(changed.json().code).toBe('trading_context_idempotency_conflict')
    const stale = await f.app.inject({ ...request, headers: { ...headers, 'idempotency-key': key.replace(/a$/, 'b') } })
    expect(stale.json().code).toBe('revision_conflict')
    expect(f.execute).toHaveBeenCalledWith({ userId: 42, requestId: key, action: 'select_account', targetId: '7', expectedRevision: 0 })
  } finally { await f.app.close() }
})

it('validates observer exit revision and CSRF format without calling the use case', async () => {
  const f = await fixture()
  try {
    for (const suffix of ['', '?expected_revision=', '?expected_revision=1e2', '?expected_revision=0&expected_revision=1']) {
      expect((await f.app.inject({ method: 'DELETE', url: '/api/v4/trading-context/observer' + suffix, headers })).statusCode).toBe(400)
    }
    expect((await f.app.inject({ method: 'DELETE', url: '/api/v4/trading-context/observer?expected_revision=0' })).statusCode).toBe(400)
    expect(f.execute).not.toHaveBeenCalled()
    expect((await f.app.inject({ method: 'DELETE', url: '/api/v4/trading-context/observer?expected_revision=0', headers })).statusCode).toBe(200)
    expect(f.execute).toHaveBeenCalledWith({ userId: 42, requestId: key, action: 'leave_observer', targetId: null, expectedRevision: 0 })
  } finally { await f.app.close() }
})

it('authenticates writes before validating an invalid payload', async () => {
  const f = await fixture()
  f.assertWrite.mockRejectedValue(new AuthError('csrf_invalid', 403))
  try {
    const result = await f.app.inject({ method: 'PUT', url: '/api/v4/trading-context', payload: {} })
    expect(result.statusCode).toBe(403)
    expect(result.json().code).toBe('csrf_invalid')
    expect(f.execute).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('reports an unknown result when a completed use case returns an invalid response', async () => {
  const f = await fixture()
  f.execute.mockResolvedValue({ secret: 'must-not-leak' } as never)
  try {
    const result = await f.app.inject({ method: 'PUT', url: '/api/v4/trading-context', headers,
      payload: { mode: 'observer', observer_channel_id: 'obs', expected_revision: '0' } })
    expect(result.statusCode).toBe(503)
    expect(result.json().code).toBe('trading_context_commit_unknown')
    expect(result.body).not.toContain('must-not-leak')
    expect(f.execute).toHaveBeenCalledTimes(1)
  } finally { await f.app.close() }
})

it('requires a single canonical command key for both write methods', async () => {
  const f = await fixture()
  try {
    for (const requestKey of [undefined, '', key.toUpperCase(), [key, key], 'invalid']) {
      const requestHeaders = { 'x-csrf-token': headers['x-csrf-token'], ...(requestKey === undefined ? {} : { 'idempotency-key': requestKey }) }
      for (const request of [
        { method: 'PUT' as const, url: '/api/v4/trading-context', payload: { mode: 'full', account_id: '7', expected_revision: '0' } },
        { method: 'DELETE' as const, url: '/api/v4/trading-context/observer?expected_revision=0' },
      ]) expect((await f.app.inject({ ...request, headers: requestHeaders })).statusCode).toBe(400)
    }
    expect(f.execute).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('authenticates receipt queries before validation and never caches a missing or existing receipt', async () => {
  const f = await fixture()
  try {
    const missing = await f.app.inject(`/api/v4/trading-context/commands/${key}?user_id=99`)
    expect(missing.statusCode).toBe(200)
    expect(missing.json().data).toBeNull()
    expect(missing.headers['cache-control']).toBe('no-store')
    expect(f.receipt).toHaveBeenCalledWith(42, key)
    expect((await f.app.inject('/api/v4/trading-context/commands/invalid')).statusCode).toBe(400)
    f.assertWrite.mockRejectedValueOnce(new AuthError('csrf_invalid', 403))
    expect((await f.app.inject('/api/v4/trading-context/commands/invalid')).statusCode).toBe(403)
    f.receipt.mockRejectedValueOnce(Error('database-secret'))
    const unavailable = await f.app.inject(`/api/v4/trading-context/commands/${key}`)
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.body).not.toContain('database-secret')
    expect(unavailable.headers['cache-control']).toBe('no-store')
  } finally { await f.app.close() }
})
