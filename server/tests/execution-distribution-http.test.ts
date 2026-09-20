import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import type { ExecutionDistributionService } from '../src/modules/execution/application/execution-distribution-service.js'
import { executionDistributionRoutes } from '../src/modules/execution/transport/http/execution-distribution-routes.js'

for (const close of [false, true]) {
  it(`validates ${close ? 'close' : 'create'} distribution writes and keeps post-commit failures uncertain`, async () => {
    const operation = { id: 'op-1', kind: 'execution_distribution', status: 'queued', acceptedAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z', completedAt: null, resourceId: 'd1', errorCode: null, revision: 1 }
    const execute = vi.fn().mockResolvedValue({ operation })
    const assertWrite = vi.fn().mockResolvedValue({ userId: 7, role: 'admin' })
    const app = Fastify()
    await app.register(executionDistributionRoutes, { prefix: '/api/v4',
      service: { createManualOrderDistribution: execute, createDistributionClose: execute } as unknown as ExecutionDistributionService,
      auth: { assertWrite, async authenticate() { return { userId: 7, role: 'admin' } } } })
    const body = close ? { expected_revision: '3', target_ids: ['t1'] } : { strategy_id: 's1', command: {
      command_type: 'market_order', symbol: 'XAUUSD', side: 'buy', volume: '0.01', stop_loss: '2490', reference_price: '2500',
    } }
    const send = (payload: unknown = body, headers = {}, suffix = '') => app.inject({ method: 'POST',
      url: '/api/v4/execution-distributions' + (close ? '/d1/close-commands' : '') + suffix,
      headers: { 'idempotency-key': 'distribution-request-0001', 'x-csrf-token': 'csrf-token-1234567890', ...headers }, payload: payload as object })
    try {
      assertWrite.mockRejectedValueOnce(new AuthError('auth_session_invalid', 401))
      expect((await send({})).statusCode).toBe(401)
      expect((await send({ ...body, actor: 9 })).statusCode).toBe(400)
      expect((await send(body, {}, '?actor=9')).statusCode).toBe(400)
      expect((await send(body, { 'x-csrf-token': 'short' })).statusCode).toBe(400)
      expect(execute).not.toHaveBeenCalled()
      const accepted = await send()
      expect(accepted.statusCode).toBe(202)
      expect(accepted.headers['cache-control']).toBe('no-store')
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 7, actorRole: 'admin',
        idempotencyKey: 'distribution-request-0001', ...(close ? { expectedRevision: 3, targetIds: ['t1'] } : { strategyId: 's1' }) }))
      execute.mockResolvedValueOnce({ operation: { ...operation, status: 'private-invalid' } })
      const unknown = await send()
      expect(unknown.statusCode).toBe(503); expect(unknown.json().code).toBe('distribution_commit_unknown')
      expect(unknown.body).not.toContain('private-invalid')
      expect(unknown.headers['content-type']).toContain('application/problem+json')
      expect(execute).toHaveBeenCalledTimes(2)
    } finally { await app.close() }
  })
}
