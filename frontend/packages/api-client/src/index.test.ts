import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createApiClient } from './index'

describe('createApiClient', () => {
  it('queries the original risk receipt key and preserves unconfirmed without issuing a write', async () => {
    const meta = { request_id: 'receipt-test', generated_at: '2026-09-09T00:00:00.000Z' }
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ data: { state: 'unconfirmed', release: null }, meta }), { status: 200 }))
    const client = createApiClient({ fetchImpl })
    expect((await client.getManualRiskReleaseReceipt('account/7', 'original:key')).data).toEqual({ state: 'unconfirmed', release: null })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/risk-accounts/account%2F7/manual-release-receipt?idempotency_key=original%3Akey')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(() => client.getManualRiskReleaseReceipt('account/7', 'bad')).toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
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
    await client.selectTradingAccount('csrf', 'acc/2', 1, 'd97382ac-4b49-42db-b1f1-850ec403848a')

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
    await client.leaveObserverMode('csrf', 4, 'd97382ac-4b49-42db-b1f1-850ec403848a').catch(() => undefined)

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/trading-accounts/source%2F7/snapshot?observer_channel_id=observer%2F1')
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v4/market/quotes/XAUUSD?account_id=source%2F7&observer_channel_id=observer%2F1')
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/v4/market/candles?account_id=source%2F7&symbol=XAUUSD&timeframe=M5&page_size=200&observer_channel_id=observer%2F1')
    expect(fetchImpl.mock.calls[3]?.[0]).toBe('/api/v4/trading-context/observer?expected_revision=4')
    expect(new Headers(fetchImpl.mock.calls[3]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf')
  })

  it('keeps current account listing backward compatible and adds history access explicitly', async () => {
    const response = () => new Response(JSON.stringify({
      data: { items: [] }, meta: { request_id: 'accounts', generated_at: '2026-09-03T04:00:00.000Z' },
    }), { status: 200 })
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response())
    const client = createApiClient({ fetchImpl })

    await client.listTradingAccounts()
    await client.listTradingAccounts('current')
    await client.listTradingAccounts('history')

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      '/api/v4/trading-accounts',
      '/api/v4/trading-accounts',
      '/api/v4/trading-accounts?access=history',
    ])
  })

  it('keeps analysis reads user-scoped and manual analysis idempotent', async () => {
    const meta = { request_id: 'analysis', generated_at: '2026-09-04T04:00:00.000Z' }
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [] }, meta }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [], next_cursor: null }, meta }), { status: 200 }))
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
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v4/market-analyses?page_size=200')
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

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/trade-decisions?account_id=account%2F7&page_size=200')
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

  it('reads command context, operation and distribution state from encoded V4 paths', async () => {
    const meta = { request_id: 'read', generated_at: '2026-09-04T04:00:00.000Z' }
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        account_id: 'account/7', symbol: 'XAUUSD', ticket: 'ticket:1', read_only: false, trade_permission: true,
        expected_state: { account_revision: '1', positions_revision: '2', pending_orders_revision: '3', quote_revision: '4', contract_revision: '5', risk_revision: '6' },
        target_revision: '7', quote: { bid: '2500', ask: '2501', observed_at: meta.generated_at }, instrument: null,
      }, meta })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        operation_id: 'op/1', kind: 'user_execution_command', status: 'running', accepted_at: meta.generated_at, updated_at: meta.generated_at,
        completed_at: null, resource_id: null, error_code: null, revision: '2', parent_operation_id: null, distribution_id: null, result_summary: null,
      }, meta })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        strategy_id: 's/1', strategy_version_id: 'v1', strategy_revision: '3', symbol: 'XAUUSD', target_count: 0, targets: [],
      }, meta })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        id: 'd/1', operation_id: 'op/2', strategy_id: 's/1', strategy_version_id: 'v1', kind: 'manual_order', source_distribution_id: null,
        command: {}, status: 'queued', target_count: 0, result_summary: {}, created_at: meta.generated_at, updated_at: meta.generated_at,
        completed_at: null, revision: '1', targets: [],
      }, meta })))
    const client = createApiClient({ fetchImpl })

    await client.getExecutionCommandContext('account/7', 'XAUUSD', 'ticket:1')
    await client.getOperation('op/1')
    await client.previewExecutionDistribution('s/1', 'XAUUSD')
    await client.getExecutionDistribution('d/1')

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      '/api/v4/trading-accounts/account%2F7/execution-context?symbol=XAUUSD&ticket=ticket%3A1',
      '/api/v4/operations/op%2F1',
      '/api/v4/execution-distributions/preview?strategy_id=s%2F1&symbol=XAUUSD',
      '/api/v4/execution-distributions/d%2F1',
    ])
    for (const [, request] of fetchImpl.mock.calls) expect(request?.method).toBe('GET')
  })

  it('reads risk resources and preserves CAS, CSRF and idempotency headers on risk writes', async () => {
    const generatedAt = '2026-09-04T04:00:00.000Z'
    const meta = { request_id: 'risk', generated_at: generatedAt }
    const policy = {
      account_id: 'account/7', platform_policy_version_id: 'platform-1', account_policy_version_id: 'account-policy-1',
      global_kill_switch: false, allowed_symbols: ['XAUUSD'], fail_closed_on_incomplete_data: true,
      max_quote_age_seconds: 15, max_risk_summary_age_seconds: 30, max_decision_age_seconds: 45, max_price_deviation_percent: '0.2',
      manual_release_enabled: true, manual_release_max_daily_loss_percent: '5', manual_release_max_drawdown_percent: '12',
      manual_release_max_daily_open_count: 30, manual_release_consecutive_loss_limit: 5,
      max_risk_per_trade_percent: '1', max_daily_loss_percent: '3', max_drawdown_percent: '8', max_open_positions: 5,
      max_pending_orders: 5, max_order_volume: '0.05', max_total_volume: '2', max_spread_points: '30', min_open_interval_seconds: 60,
      max_daily_open_count: 20, consecutive_loss_limit: 3, loss_cooldown_minutes: 15, pending_valid_minutes: 240,
      weekend_close_minutes: 30, trade_send_enabled: true, account_kill_switch: false, require_stop_loss: true,
      editable_fields: ['max_risk_per_trade_percent', 'trade_send_enabled'], revision: '3', updated_at: generatedAt,
    }
    const summary = {
      account_id: 'account/7', business_date: '2026-09-04', equity: '10000', free_margin: '9000', margin_level_percent: null,
      daily_loss_percent: '1.2', drawdown_percent: '2.1', open_positions: 1, pending_orders: 0, total_volume: '0.1',
      daily_open_count: 2, consecutive_losses: 0, terminal_timezone_offset_minutes: 180, clock_status: 'calibrated',
      last_successful_open_at: null, cooldown_until: null, data_complete: true, incomplete_reasons: [], observed_at: generatedAt, revision: '8',
    }
    const release = {
      manual_release_id: 'release-1', account_id: 'account/7', platform_policy_version_id: 'platform-1', account_policy_version_id: 'account-policy-1',
      policy_set_revision: '3', status: 'active', released_rules: ['RISK_DAILY_LOSS_LIMIT'],
      baseline: { business_date: '2026-09-04', daily_loss_percent: '3.2', drawdown_percent: '2.1', daily_open_count: 2, consecutive_losses: 0, cooldown_until: null },
      risk_state_revision: '8', reason: '确认风险后恢复交易', expires_at: '2026-09-05T00:00:00.000Z', created_at: generatedAt,
      invalidated_at: null, invalidation_reason: null, revision: '1',
    }
    const decision = {
      risk_decision_id: 'risk-1', trade_decision_id: 'trade-1', account_id: 'account/7', status: 'rejected', reject_code: 'RISK_DAILY_LOSS_LIMIT',
      platform_policy_version_id: 'platform-1', account_policy_version_id: 'account-policy-1', account_risk_revision: '8', manual_release_id: null,
      created_at: generatedAt, revision: '2',
    }
    const responses = [
      { data: policy, meta }, { data: summary, meta },
      { data: { release: null, availability: { available: false, code: 'risk_manual_release_no_active_block', rules: [], expires_at: null, policy_set_revision: '3', risk_state_revision: '8' } }, meta },
      { data: policy, meta }, { data: release, meta }, { data: { items: [decision] }, meta },
      { data: { summary: decision, rules: [], approved_actions: [], evaluated_at: generatedAt, policy_hash: 'a'.repeat(64) }, meta },
    ]
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }))
    const client = createApiClient({ fetchImpl })

    await client.getRiskPolicy('account/7')
    await client.getRiskSummary('account/7')
    await client.getManualRiskRelease('account/7')
    await client.replaceRiskPolicy('csrf', 'account/7', { max_risk_per_trade_percent: '0.5', reason: '降低风险' }, 3, 'original-policy-key')
    await client.createManualRiskRelease('csrf', 'account/7', { acknowledge_risk: true, reason: '确认风险后恢复交易' }, 8, 'risk-release-idempotency-1')
    await client.listRiskDecisions('account/7', 200)
    await client.getRiskDecision('risk/1')

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      '/api/v4/risk-accounts/account%2F7/policy',
      '/api/v4/risk-accounts/account%2F7/summary',
      '/api/v4/risk-accounts/account%2F7/manual-release',
      '/api/v4/risk-accounts/account%2F7/policy',
      '/api/v4/risk-accounts/account%2F7/manual-release',
      '/api/v4/risk-decisions?account_id=account%2F7&page_size=100',
      '/api/v4/risk-decisions/risk%2F1',
    ])
    const [, policyRequest] = fetchImpl.mock.calls[3] ?? []
    expect(new Headers(policyRequest?.headers).get('If-Match')).toBe('"3"')
    expect(new Headers(policyRequest?.headers).get('Idempotency-Key')).toBe('original-policy-key')
    const [, releaseRequest] = fetchImpl.mock.calls[4] ?? []
    expect(new Headers(releaseRequest?.headers).get('If-Match')).toBe('"8"')
    expect(new Headers(releaseRequest?.headers).get('Idempotency-Key')).toBe('risk-release-idempotency-1')
    expect(new Headers(releaseRequest?.headers).get('X-CSRF-Token')).toBe('csrf')
  })

  it('uses the normalized review paths, selection tokens and optimistic revisions', async () => {
    const response = () => new Response(JSON.stringify({ data: { items: [] }, meta: { request_id: 'review-1', generated_at: '2026-09-04T09:00:00.000Z' } }), { status: 200 })
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response())
    const client = createApiClient({ fetchImpl })

    await client.listReviewCases({ kind: 'manual', accountId: 'account/1', pageSize: 25 })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/review-cases?kind=manual&account_id=account%2F1&page_size=25')

    await client.createManualReviewCase('csrf-review', {
      candidate_ids: ['candidate-1'], selection_tokens: [`candidate-1.2.${'a'.repeat(64)}`], strategy_id: 'strategy-1', user_thesis: '当时计划等待突破',
    }, 'manual-review-0001').catch(() => undefined)
    const [, request] = fetchImpl.mock.calls[1] ?? []
    expect(new Headers(request?.headers).get('X-CSRF-Token')).toBe('csrf-review')
    expect(new Headers(request?.headers).get('Idempotency-Key')).toBe('manual-review-0001')
    expect(request?.body).toContain('selection_tokens')

    await client.returnReviewCase('csrf-review', 'case/1', '证据引用需要修正', 4).catch(() => undefined)
    const [, returnRequest] = fetchImpl.mock.calls[2] ?? []
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/v4/review-cases/case%2F1/return')
    expect(new Headers(returnRequest?.headers).get('If-Match')).toBe('"4"')
  })
})

describe('strategy management API client', () => {
  const meta = { request_id: 'strategy', generated_at: '2026-09-04T04:00:00.000Z' }
  const version = {
    id: 'version-1', strategy_id: 'strategy/1', kind: 'analysis', version: 1,
    prompt_text: '分析黄金', prompt_hash: 'a'.repeat(64), config: { timeframes: ['M5'] },
    input_contract_version: 'market-analysis-input/v1', output_contract_version: 'market-analysis/v1',
    created_by_user_id: '7', created_at: meta.generated_at,
  }
  const detail = {
    id: 'strategy/1', kind: 'analysis', scope: 'user', owner_user_id: '7', name: '黄金分析', description: '结构',
    status: 'draft', active_version_id: null, paired_trader_strategy: null, revision: '1',
    performance: { status: 'insufficient', currency: null, currencies: [], net_profit: null, max_drawdown: null,
      return_percent: null, max_drawdown_percent: null, trade_count: 0, win_rate_percent: null, profit_factor: null,
      period_start: null, period_end: null }, versions: [version],
  }
  const compile = {
    valid: true, kind: 'analysis', prompt_hash: 'a'.repeat(64), normalized_config: { timeframes: ['M5'], candle_limit: 300 },
    input_contract_version: 'market-analysis-input/v1', output_contract_version: 'market-analysis/v1', issues: [],
  }
  const subscription = {
    id: 'subscription/1', user_id: '7', trading_account_id: 'account/1', symbol: 'XAUUSD',
    analysis_strategy_id: 'strategy/1', analysis_strategy_version_id: 'version-1', trader_strategy_id: null,
    trader_strategy_version_id: null, analysis_enabled: true, trader_enabled: false, trade_send_enabled: false,
    status: 'active', revision: '1', created_at: meta.generated_at, updated_at: meta.generated_at,
    schedule: { cadence_seconds: 300, receive_timezone: 'UTC', receive_window: { enabled: false }, next_due_at: null, revision: '1' },
  }

  it('uses stable strategy paths, strict request bodies and CAS headers', async () => {
    const responses = [
      { data: detail, meta }, { data: compile, meta }, { data: detail, meta }, { data: detail, meta },
      { data: detail, meta }, { data: detail, meta }, { data: detail, meta },
      { data: { items: [subscription] }, meta }, { data: subscription, meta }, { data: subscription, meta },
    ]
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }))
    const client = createApiClient({ fetchImpl })

    await client.getStrategy('strategy/1')
    await client.compileStrategy('csrf', { kind: 'analysis', prompt_text: '分析黄金', config: { timeframes: ['M5'] } })
    await client.createStrategy('csrf', { kind: 'analysis', name: '黄金分析', description: '结构', prompt_text: '分析黄金', config: {} }, 'strategy-create-001')
    await client.updateStrategyMetadata('csrf', 'strategy/1', { name: '新名字', description: '新说明' }, 1, 'strategy-metadata-001')
    await client.createStrategyVersion('csrf', 'strategy/1', { prompt_text: 'v2', config: {} }, 2, 'strategy-version-001')
    await client.publishStrategyVersion('csrf', 'strategy/1', 'version/2', 3, 'strategy-publish-001')
    await client.retireStrategy('csrf', 'strategy/1', 4, 'strategy-retire-001')
    await client.listStrategySubscriptions('account/1')
    await client.createStrategySubscription('csrf', { trading_account_id: 'account/1', symbol: 'XAUUSD', analysis_strategy_id: 'strategy/1' }, 'subscription-create-001')
    await client.updateStrategySubscription('csrf', 'subscription/1', { status: 'paused' }, 1, 'subscription-update-001')

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      '/api/v4/strategies/strategy%2F1', '/api/v4/strategies/compile', '/api/v4/strategies',
      '/api/v4/strategies/strategy%2F1', '/api/v4/strategies/strategy%2F1/versions',
      '/api/v4/strategies/strategy%2F1/versions/version%2F2/publish', '/api/v4/strategies/strategy%2F1/retire',
      '/api/v4/strategy-subscriptions?account_id=account%2F1', '/api/v4/strategy-subscriptions',
      '/api/v4/strategy-subscriptions/subscription%2F1',
    ])
    for (const index of [1, 2, 3, 4, 5, 6, 8, 9]) {
      const [, request] = fetchImpl.mock.calls[index] ?? []
      expect(new Headers(request?.headers).get('X-CSRF-Token')).toBe('csrf')
    }
    expect(new Headers(fetchImpl.mock.calls[3]?.[1]?.headers).get('If-Match')).toBe('"1"')
    expect(new Headers(fetchImpl.mock.calls[2]?.[1]?.headers).get('Idempotency-Key')).toBe('strategy-create-001')
    expect(new Headers(fetchImpl.mock.calls[3]?.[1]?.headers).get('Idempotency-Key')).toBe('strategy-metadata-001')
    expect(new Headers(fetchImpl.mock.calls[4]?.[1]?.headers).get('Idempotency-Key')).toBe('strategy-version-001')
    expect(new Headers(fetchImpl.mock.calls[5]?.[1]?.headers).get('Idempotency-Key')).toBe('strategy-publish-001')
    expect(new Headers(fetchImpl.mock.calls[6]?.[1]?.headers).get('Idempotency-Key')).toBe('strategy-retire-001')
    expect(new Headers(fetchImpl.mock.calls[8]?.[1]?.headers).get('Idempotency-Key')).toBe('subscription-create-001')
    expect(new Headers(fetchImpl.mock.calls[9]?.[1]?.headers).get('Idempotency-Key')).toBe('subscription-update-001')
    expect(new Headers(fetchImpl.mock.calls[4]?.[1]?.headers).get('If-Match')).toBe('"2"')
    expect(new Headers(fetchImpl.mock.calls[9]?.[1]?.headers).get('If-Match')).toBe('"1"')
    expect(JSON.parse(String(fetchImpl.mock.calls[9]?.[1]?.body))).toEqual({ status: 'paused' })
  })

  it('validates strategy request bodies before making a network call', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = createApiClient({ fetchImpl })
    expect(() => client.updateStrategySubscription('csrf', 'subscription/1', { status: 'bad' as never }, 1, 'subscription-update-001')).toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
