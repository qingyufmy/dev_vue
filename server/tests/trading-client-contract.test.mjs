// Cross-project runtime test: don't merge frontend Bundler and server NodeNext typecheck graphs.
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { createApiClient } from '../../frontend/packages/api-client/src/index.ts'
import { tradingRoutes } from '../src/modules/trading/transport/http/trading-routes.ts'
import { AuthError } from '../src/modules/auth/index.ts'

it('validates quote and candle contracts, pagination and observer scope through the API client', async () => {
  const app = Fastify(), stamp = '2026-09-09T00:00:00.123Z'
  const quoteData = { accountId: '7', symbol: 'XAUUSD', bid: '2000.12345', ask: '2000.22345', last: null, spread: '0.10000', tradeMode: 'full', observedAt: stamp, revision: 1 }
  const candle = { accountId: '7', symbol: 'XAUUSD', timeframe: 'M1', openTime: stamp, open: '2000.12345', high: '2002', low: '1999', close: '2001', tickVolume: '12', closed: true, revision: 1 }
  const quote = vi.fn(async () => quoteData), candles = vi.fn(async () => [candle])
  const authenticate = vi.fn(async () => ({ userId: 42 }))
  await app.register(tradingRoutes, { prefix: '/api/v4', service: { quote, candles }, capacity: {}, auth: { authenticate }, contextCommands: {} })
  try {
    const client = createApiClient({ fetchImpl: async url => {
      const result = await app.inject(url)
      expect(result.headers['cache-control']).toBe('no-store')
      if (result.statusCode === 200 && result.json().data?.bid) expect(result.json().data.bid).toBe('2000.12345')
      return new Response(result.body, { status: result.statusCode, headers: { 'Content-Type': String(result.headers['content-type']) } })
    } })
    expect((await client.getMarketQuote('7', 'XAUUSD', 'observer-1')).data).toMatchObject({ accountId: '7', observedAt: stamp })
    expect(quote).toHaveBeenLastCalledWith(42, '7', 'XAUUSD', 'observer-1')
    expect((await client.getMarketCandles('7', 'XAUUSD', 'M1', 500, 'observer-1')).data.items[0]).toMatchObject({ accountId: '7', openTime: stamp })
    expect(candles).toHaveBeenLastCalledWith(42, '7', 'XAUUSD', 'M1', 500, 'observer-1')
    quote.mockResolvedValue(null)
    expect((await client.getMarketQuote('7', 'XAUUSD')).data).toBeNull()
    candles.mockClear(); quote.mockClear()
    const base = '/api/v4/market/candles?account_id=7&symbol=XAUUSD&timeframe=M1'
    for (const size of ['0', '501', '1.5', '1e2', '1&page_size=2']) {
      const result = await app.inject(base + '&page_size=' + size)
      expect(result.statusCode).toBe(400)
      expect(result.json().code).toBe('api_request_invalid')
    }
    const missing = await app.inject('/api/v4/market/quotes/XAUUSD')
    expect(missing.statusCode).toBe(400)
    expect(quote).not.toHaveBeenCalled(); expect(candles).not.toHaveBeenCalled()
    authenticate.mockRejectedValueOnce(new AuthError('auth_session_required', 401))
    expect((await app.inject(base + '&page_size=0')).statusCode).toBe(401)
    expect(candles).not.toHaveBeenCalled()
    candles.mockResolvedValue([{ ...candle, openTime: 'secret-invalid-time' }])
    await expect(client.getMarketCandles('7', 'XAUUSD', 'M1')).rejects.toMatchObject({ status: 503, problem: { code: 'api_response_invalid' } })
  } finally { await app.close() }
})

it('validates workspace scope, nullable snapshots and failures across server and client', async () => {
  const app = Fastify()
  const account = { id: '7', platform: 'mt5', login: '100', server: 'demo', currency: 'USD', terminalProfileId: null,
    terminalInstanceId: null, bridgeState: 'offline', tradePermission: false, lastSeenAt: null }
  const workspace = vi.fn(async () => ({ account, snapshot: null, symbols: ['XAUUSD'], positions: { revision: 0, items: [] }, pendingOrders: { revision: 0, items: [] } }))
  const authenticate = vi.fn(async () => ({ userId: 42 }))
  await app.register(tradingRoutes, { prefix: '/api/v4', service: { workspace }, capacity: {}, auth: { authenticate }, contextCommands: {} })
  try {
    const client = createApiClient({ fetchImpl: async url => {
      const result = await app.inject(url)
      expect(result.headers['cache-control']).toBe('no-store')
      if (result.statusCode === 200) expect(result.json().data.positions.revision).toBe('0')
      return new Response(result.body, { status: result.statusCode, headers: { 'Content-Type': String(result.headers['content-type']) } })
    } })
    expect((await client.getTradingWorkspace('7', 'observer-1')).data).toMatchObject({ account: { id: '7' }, snapshot: null, positions: { revision: 0, items: [] } })
    expect(workspace).toHaveBeenLastCalledWith(42, '7', 'observer-1')
    workspace.mockClear()
    for (const url of ['/api/v4/trading-accounts/7/snapshot?observer_channel_id=', '/api/v4/trading-accounts/7/snapshot?observer_channel_id=a&observer_channel_id=b']) {
      const result = await app.inject(url)
      expect(result.statusCode).toBe(400)
      expect(result.json().code).toBe('api_request_invalid')
      expect(result.headers['cache-control']).toBe('no-store')
    }
    expect(workspace).not.toHaveBeenCalled()
    authenticate.mockRejectedValueOnce(new AuthError('auth_session_required', 401))
    const denied = await app.inject('/api/v4/trading-accounts/7/snapshot?observer_channel_id=')
    expect(denied.statusCode).toBe(401)
    expect(workspace).not.toHaveBeenCalled()
    workspace.mockResolvedValue({ account: { ...account, id: '', server: 'secret invalid account' }, snapshot: null, symbols: [], positions: { revision: 0, items: [] }, pendingOrders: { revision: 0, items: [] } })
    await expect(client.getTradingWorkspace('7')).rejects.toMatchObject({ status: 503, problem: { code: 'api_response_invalid' } })
    const invalid = await app.inject('/api/v4/trading-accounts/7/snapshot')
    expect(invalid.body).not.toContain('secret invalid account')
  } finally { await app.close() }
})

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
