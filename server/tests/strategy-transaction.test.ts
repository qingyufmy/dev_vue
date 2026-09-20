import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import Fastify from 'fastify'
import { strategyTransaction } from '../src/modules/strategies/infrastructure/strategy-transaction.js'
import { StrategyAccessError } from '../src/modules/strategies/domain/strategy.js'
import { createStrategyHttp } from '../src/modules/strategies/composition.js'
import { StrategyService } from '../src/modules/strategies/application/strategy-service.js'
import { AuthError } from '../src/modules/auth/index.js'

function fixture() {
  const connection = { beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}), release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(async () => [{ insertId: 17 }, []]) }
  const pool = { getConnection: vi.fn(async () => connection), execute: vi.fn() }
  return { connection, pool: pool as unknown as Pool }
}

describe('strategy transaction outcomes', () => {
  it('returns acknowledged results and never retries a lost commit acknowledgement', async () => {
    const { connection, pool } = fixture()
    const work = vi.fn(async (_connection: PoolConnection) => 'created')
    await expect(strategyTransaction(pool, work)).resolves.toBe('created')
    expect(connection.release).toHaveBeenCalledTimes(1)
    connection.commit.mockRejectedValueOnce(new Error('private database error'))
    await expect(strategyTransaction(pool, work)).rejects.toMatchObject({ code: 'strategy_commit_unknown', status: 503 })
    expect(work).toHaveBeenCalledTimes(2)
    expect(connection.rollback).not.toHaveBeenCalled()
    expect(connection.destroy).toHaveBeenCalledTimes(1)
    expect(connection.release).toHaveBeenCalledTimes(1)
  })

  it('preserves precommit domain errors even when rollback fails, discarding the connection', async () => {
    const { connection, pool } = fixture()
    const error = new StrategyAccessError('strategy_revision_conflict', 412)
    connection.rollback.mockRejectedValueOnce(new Error('rollback disconnected'))
    await expect(strategyTransaction(pool, async () => { throw error })).rejects.toBe(error)
    expect(connection.commit).not.toHaveBeenCalled()
    expect(connection.destroy).toHaveBeenCalledTimes(1)
    expect(connection.release).not.toHaveBeenCalled()
  })

  it('exposes nonretryable unknown results and preserves write authentication errors over HTTP', async () => {
    const create = vi.fn(async () => { throw new StrategyAccessError('strategy_commit_unknown', 503) })
    const service = { create } as unknown as StrategyService
    let authorized = false
    const app = Fastify()
    await app.register(createStrategyHttp(service, {
      authenticate: async () => ({ userId: 7 }),
      assertWrite: async () => { if (!authorized) throw new AuthError('auth_required', 401); return { userId: 7 } },
    }))
    try {
      const request = { method: 'POST' as const, url: '/api/v4/strategies', headers: { 'x-csrf-token': 'csrf-token-123456789', 'idempotency-key': 'strategy-create-001' }, payload: { kind: 'analysis', name: 'test', description: '', prompt_text: 'analyse', config: {} } }
      const denied = await app.inject(request)
      expect(denied.statusCode).toBe(401)
      expect(create).not.toHaveBeenCalled()
      authorized = true
      const result = await app.inject(request)
      expect(result.statusCode).toBe(503)
      expect(result.json()).toMatchObject({ code: 'strategy_commit_unknown', retryable: false })
      expect(result.headers['cache-control']).toBe('no-store')
      expect(result.headers['content-type']).toContain('application/problem+json')
      expect(result.body).not.toContain('private database error')
      expect(create).toHaveBeenCalledTimes(1)
    } finally { await app.close() }
  })
})
