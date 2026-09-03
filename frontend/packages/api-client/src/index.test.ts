import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createApiClient } from './index'

describe('createApiClient', () => {
  it('always uses the current host session cookie', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: 'ok' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }))
    const client = createApiClient({ fetchImpl })

    await client.request(z.object({ data: z.literal('ok') }), '/api/v4/example')

    expect(fetchImpl).toHaveBeenCalledWith('/api/v4/example', expect.objectContaining({ credentials: 'same-origin' }))
  })

  it('requires and sends CSRF for writes', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: 'ok' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }))
    const client = createApiClient({ fetchImpl })

    await expect(client.request(z.any(), '/api/v4/example', { method: 'POST' })).rejects.toThrow('CSRF')
    await client.request(z.object({ data: z.literal('ok') }), '/api/v4/example', {
      method: 'POST',
      body: '{}',
      csrfToken: 'csrf_1',
    })

    const [, request] = fetchImpl.mock.calls[0] ?? []
    expect(new Headers(request?.headers).get('X-CSRF-Token')).toBe('csrf_1')
    expect(request).not.toHaveProperty('csrfToken')
  })

  it('exempts only identity-center login from application-session CSRF', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { redirect_to: 'https://trade.example.test/auth/callback?code=one&state=two' },
      meta: { request_id: 'req_1', generated_at: '2026-09-03T04:00:00.000Z' },
    }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
    const client = createApiClient({ fetchImpl })

    await client.login({
      client_id: 'trade-web', redirect_uri: 'https://trade.example.test/auth/callback',
      response_type: 'code', scope: 'openid profile',
      state: 'state_abcdefghijklmnopqrstuvwxyz123456', nonce: 'nonce_abcdefghijklmnopqrstuvwxyz123456',
      code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
      login: 'user@example.test', password: 'not-persisted', remember: false,
    })

    const [, request] = fetchImpl.mock.calls[0] ?? []
    expect(new Headers(request?.headers).has('X-CSRF-Token')).toBe(false)
    expect(request).toMatchObject({ credentials: 'same-origin', method: 'POST' })
  })

  it('encodes account-scoped market paths and requires CSRF when switching accounts', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, meta: { request_id: 'r1', generated_at: '2026-09-03T04:00:00.000Z' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { user_id: '7', mode: 'full', account_id: 'acc/2', observer_channel_id: null, read_only: false, revision: '2' }, meta: { request_id: 'r2', generated_at: '2026-09-03T04:00:00.000Z' } }), { status: 200 }))
    const client = createApiClient({ fetchImpl })

    await client.getMarketQuote('acc/2', 'XAUUSD.m')
    await client.selectTradingAccount('csrf', 'acc/2', 1)

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/market/quotes/XAUUSD.m?account_id=acc%2F2')
    const [, request] = fetchImpl.mock.calls[1] ?? []
    expect(new Headers(request?.headers).get('X-CSRF-Token')).toBe('csrf')
    expect(request?.body).toBe(JSON.stringify({ mode: 'full', account_id: 'acc/2', expected_revision: '1' }))
  })

  it('keeps observer authorization explicit on every source-account snapshot and realtime bootstrap read', async () => {
    const empty = () => new Response(JSON.stringify({ data: null, meta: { request_id: 'observer', generated_at: '2026-09-03T04:00:00.000Z' } }), { status: 200 })
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => empty())
    const client = createApiClient({ fetchImpl })

    await client.getTradingWorkspace('source/7', 'observer/1').catch(() => undefined)
    await client.getMarketQuote('source/7', 'XAUUSD', 'observer/1')
    await client.getMarketCandles('source/7', 'XAUUSD', 'M5', 200, 'observer/1').catch(() => undefined)
    await client.leaveObserverMode('csrf', 4).catch(() => undefined)

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/trading-accounts/source%2F7/snapshot?observer_channel_id=observer%2F1')
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v4/market/quotes/XAUUSD?account_id=source%2F7&observer_channel_id=observer%2F1')
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/v4/market/candles?account_id=source%2F7&symbol=XAUUSD&timeframe=M5&page_size=200&observer_channel_id=observer%2F1')
    expect(fetchImpl.mock.calls[3]?.[0]).toBe('/api/v4/trading-context/observer?expected_revision=4')
    expect(new Headers(fetchImpl.mock.calls[3]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf')
  })
})
