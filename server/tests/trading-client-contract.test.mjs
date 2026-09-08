// Cross-project runtime test: don't merge frontend Bundler and server NodeNext typecheck graphs.
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { createApiClient } from '../../frontend/packages/api-client/src/index.ts'
import { tradingRoutes } from '../src/modules/trading/transport/http/trading-routes.ts'

it('serves connection reads through the actual API client with authenticated scope', async () => {
  const app = Fastify()
  const summary = vi.fn(async () => ({ included: 1, purchased: 2, total: 3, active: 1, available: 2 }))
  const listTerminalProfiles = vi.fn(async () => [{ id: 'profile-1', displayName: 'Terminal', platform: 'mt5', installationId: 'installation-1', accountId: null, connectionState: 'offline', lastSeenAt: null }])
  await app.register(tradingRoutes, { prefix: '/api/v4', service: { listTerminalProfiles }, capacity: { summary },
    auth: { authenticate: async () => ({ userId: 42 }) }, contextCommands: {} })
  try {
    const client = createApiClient({ fetchImpl: async url => {
      const result = await app.inject(url)
      return new Response(result.body, { status: result.statusCode, headers: { 'Content-Type': String(result.headers['content-type']) } })
    } })
    expect((await client.getConnectionCapacity()).data).toEqual({ included: 1, purchased: 2, total: 3, active: 1, available: 2 })
    expect((await client.listTerminalProfiles()).data.items[0]).toMatchObject({ id: 'profile-1', platform: 'mt5', account_id: null, last_seen_at: null })
    expect(summary).toHaveBeenCalledWith(42)
    expect(listTerminalProfiles).toHaveBeenCalledWith(42)
    summary.mockResolvedValue({ included: 1, purchased: 0, total: 1, active: -1, available: 2 })
    await expect(client.getConnectionCapacity()).rejects.toMatchObject({ status: 503, problem: { code: 'api_response_invalid' } })
  } finally { await app.close() }
})
