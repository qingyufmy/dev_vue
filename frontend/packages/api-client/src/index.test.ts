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

  it('keeps analysis reads user-scoped and manual analysis idempotent', async () => {
    const meta = { request_id: 'analysis', generated_at: '2026-09-04T04:00:00.000Z' }
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [] }, meta }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [] }, meta }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        analysis_id: 'run-1', strategy_id: 'strategy/1', strategy_version_id: 'version-1', symbol: 'XAUUSD',
        trigger: 'manual', status: 'queued', created_at: '2026-09-04T04:00:00.000Z',
        updated_at: '2026-09-04T04:00:00.000Z', revision: '1',
      }, meta }), { status: 202 }))
    const client = createApiClient({ fetchImpl })

    await client.listStrategies('analysis')
    await client.listMarketAnalyses(200)
    await client.createManualAnalysis('csrf', { strategy_id: 'strategy/1', symbol: 'XAUUSD', mode: 'manual' }, 'manual-analysis-idempotency-1')

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/strategies?kind=analysis')
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v4/market-analyses?page_size=100')
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/v4/analysis-jobs')
    const [, request] = fetchImpl.mock.calls[2] ?? []
    expect(new Headers(request?.headers).get('X-CSRF-Token')).toBe('csrf')
    expect(new Headers(request?.headers).get('Idempotency-Key')).toBe('manual-analysis-idempotency-1')
    expect(request?.body).toBe(JSON.stringify({ strategy_id: 'strategy/1', symbol: 'XAUUSD', mode: 'manual' }))
  })

  it('keeps trader decisions account-scoped and encodes detail identifiers', async () => {
    const meta = { request_id: 'trader', generated_at: '2026-09-04T04:00:00.000Z' }
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [] }, meta }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        summary: {
          decision_id: 'decision/1', analysis_id: 'analysis-1', trading_account_id: 'account/7', strategy_id: 'strategy-1',
          strategy_version_id: 'version-1', action: 'hold', side: null, confidence: 60, summary: '暂不调整',
          status: 'proposed', created_at: '2026-09-04T04:00:00.000Z', revision: '1',
        },
        actions: [], reasoning: '账户状态稳定', input_snapshot_hash: 'a'.repeat(64),
      }, meta }), { status: 200 }))
    const client = createApiClient({ fetchImpl })

    await client.listTradeDecisions('account/7', 200)
    await client.getTradeDecision('decision/1')

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/trade-decisions?account_id=account%2F7&page_size=100')
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v4/trade-decisions/decision%2F1')
  })

  it('sends unified execution commands with idempotency, CSRF and exact account paths', async () => {
    const operationPayload = {
      data: {
        operation_id: 'op_1', kind: 'user_execution_command', status: 'accepted',
        accepted_at: '2026-09-04T04:00:00.000Z', updated_at: '2026-09-04T04:00:00.000Z',
        completed_at: null, resource_id: null, error_code: null, revision: '1',
        parent_operation_id: null, distribution_id: null, result_summary: null,
      },
      meta: { request_id: 'execution', generated_at: '2026-09-04T04:00:00.000Z' },
    }
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(operationPayload), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(operationPayload), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(operationPayload), { status: 202 }))
    const client = createApiClient({ fetchImpl })
    const expectedState = {
      account_revision: '12', positions_revision: '34', pending_orders_revision: '56',
      quote_revision: '78', contract_revision: '90', risk_revision: '123',
    }

    await client.createExecutionCommand('csrf', 'account/7', {
      command_type: 'market_order', side: 'buy', symbol: 'XAUUSD', volume: '0.10', stop_loss: '2300.00',
      reference_price: '2350.00', expected_state: expectedState,
    }, 'execution-idempotency-1')
    await client.createExecutionDistribution('csrf', {
      strategy_id: 'strategy/1',
      command: { command_type: 'market_order', side: 'sell', symbol: 'XAUUSD', volume: '0.10', stop_loss: '2400.00', reference_price: '2350.00' },
    }, 'distribution-idempotency-1')
    await client.createDistributionCloseCommand('csrf', 'distribution/1', { expected_revision: '8', target_ids: [] }, 'distribution-close-idempotency-1')

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/trading-accounts/account%2F7/execution-commands')
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v4/execution-distributions')
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/v4/execution-distributions/distribution%2F1/close-commands')
    for (const [, request] of fetchImpl.mock.calls) {
      expect(request?.method).toBe('POST')
      expect(new Headers(request?.headers).get('X-CSRF-Token')).toBe('csrf')
      expect(new Headers(request?.headers).get('Idempotency-Key')).toMatch(/idempotency-1$/)
    }
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({ command_type: 'market_order', expected_state: expectedState }))
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({ expected_revision: '8', target_ids: [] })
  })
})
