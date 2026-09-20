import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { strategyRoutes } from '../src/modules/strategies/transport/http/strategy-routes.js'
import type { StrategyService } from '../src/modules/strategies/application/strategy-service.js'

it('validates the account trader contract before dispatching a single authenticated write', async () => {
  const app = Fastify(), setAccountTrader = vi.fn(async () => ({ enabled: false }))
  const assertWrite = vi.fn(async () => ({ userId: 7 }))
  await app.register(strategyRoutes, { service: { setAccountTrader } as unknown as StrategyService,
    auth: { assertWrite, authenticate: async () => ({ userId: 7 }) } })
  try {
    const headers = { 'idempotency-key': 'account-trader-http-key', 'x-csrf-token': 'csrf-token-test-123456' }
    const body = { account_id: '1', enabled: false, expected: [{ id: '2', revision: 3 }] }
    const invalid = await app.inject({ method: 'POST', url: '/strategy-subscriptions/trader-control', headers, payload: { ...body, expected: [{ id: '2', revision: -1 }] } })
    expect(invalid.statusCode).toBe(400)
    expect(setAccountTrader).not.toHaveBeenCalled()
    const response = await app.inject({ method: 'POST', url: '/strategy-subscriptions/trader-control', headers, payload: body })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual({ enabled: false })
    expect(setAccountTrader).toHaveBeenCalledExactlyOnceWith({ userId: 7, accountId: '1', enabled: false, expected: body.expected, idempotencyKey: headers['idempotency-key'] })
  } finally { await app.close() }
})
