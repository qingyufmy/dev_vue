import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { createApiClient } from '../frontend/packages/api-client/src/index.ts'
import { tradingRoutes } from '../server/src/modules/trading/transport/http/trading-routes.ts'
import { TradingAccessError } from '../server/src/modules/trading/domain/trading.ts'
const headers = { 'x-csrf-token': 'valid-test-csrf-token' }
async function fixture() {
  let revision = 0
  const enterObserver = vi.fn(async () => ({ userId: 42, accountId: null, mode: 'observer', observerChannelId: 'obs', readOnly: true, revision: 1 }))
  const app = Fastify()
  await app.register(tradingRoutes, { prefix: '/api/v4', service: {
    async selectAccount(userId, accountId, expected) {
      if (expected !== revision) throw new TradingAccessError('revision_conflict', 409)
      return { userId, accountId, mode: 'full', observerChannelId: null, readOnly: false, revision: ++revision }
    }, enterObserver,
    async leaveObserver() { return { userId: 42, accountId: null, mode: 'blocked', observerChannelId: null, readOnly: true, revision: 1 } },
  }, capacity: {}, auth: { async assertWrite() { return { userId: 42 } } } })
  return { app, enterObserver }
}

it('accepts requests from the real frontend client and preserves conflict and unknown result codes', async () => {
  const f = await fixture()
  const fetchImpl = async (input, init) => {
    const result = await f.app.inject({ method: init?.method, url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers)), ...(typeof init?.body === 'string' ? { payload: init.body } : {}) })
    return new Response(result.body, { status: result.statusCode, headers: { 'content-type': String(result.headers['content-type']) } })
  }
  const client = createApiClient({ fetchImpl })
  try {
    expect((await client.selectTradingAccount(headers['x-csrf-token'], '7', 0)).data).toMatchObject({ accountId: '7', revision: 1 })
    await expect(client.selectTradingAccount(headers['x-csrf-token'], '7', 0)).rejects.toMatchObject({ status: 409, problem: { code: 'revision_conflict' } })
    expect((await client.enterObserverMode(headers['x-csrf-token'], 'obs', 1)).data).toMatchObject({ mode: 'observer', observerChannelId: 'obs' })
    expect((await client.leaveObserverMode(headers['x-csrf-token'], 1)).data).toMatchObject({ mode: 'blocked', accountId: null })
    f.enterObserver.mockResolvedValue({ secret: 'invalid-result' })
    await expect(client.enterObserverMode(headers['x-csrf-token'], 'obs', 1)).rejects.toMatchObject({ status: 503, problem: { code: 'trading_context_commit_unknown' } })
  } finally { await f.app.close() }
})
