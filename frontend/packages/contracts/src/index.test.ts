import { describe, expect, it } from 'vitest'

import {
  analysisJobCreateSchema, closePositionCommandSchema, distributionCloseCommandSchema, executionCommandSchema,
  executionCommandContextResponseSchema, executionDistributionDetailResponseSchema, executionDistributionPreviewResponseSchema,
  executionDistributionSchema, executionExpectedStateSchema, marketAnalysisSummarySchema, marketCandleSchema,
  modifyOrderCommandSchema, modifyPositionCommandSchema, observerChannelSchema, operationSchema,
  operationRealtimeEventSchema, pendingOrderCommandSchema, traderDecisionSummarySchema, traderRunSchema, tradingContextSchema,
  tradingWorkspaceResponseSchema, sessionResponseSchema, manualReleaseStateSchema, riskDecisionDetailSchema,
  riskPolicyPatchBodySchema, riskPolicySchema, riskSummarySchema,
} from './index'

describe('sessionResponseSchema', () => {
  it('accepts the normalized V4 session envelope', () => {
    const result = sessionResponseSchema.safeParse({
      data: {
        user: { id: 'usr_1', display_name: '量见用户', avatar_url: null },
        app: 'trade',
        permissions: ['trade.read'],
        authenticated_at: '2026-09-03T04:00:00.000Z',
        mfa_level: 'none',
        csrf_token: 'csrf_once_per_session',
      },
      meta: {
        request_id: 'req_1',
        generated_at: '2026-09-03T04:00:00.000Z',
      },
    })

    expect(result.success).toBe(true)
  })

  it('rejects legacy camelCase fields', () => {
    const result = sessionResponseSchema.safeParse({
      data: {
        user: { id: 'usr_1', displayName: '量见用户', avatarUrl: null },
      },
    })

    expect(result.success).toBe(false)
  })
})

describe('execution read model schemas', () => {
  const meta = { request_id: 'req-1', generated_at: '2026-09-04T08:00:00.000Z' }

  it('parses command context without weakening the six-revision command boundary', () => {
    const result = executionCommandContextResponseSchema.parse({ data: {
      account_id: '42', symbol: 'XAUUSD', ticket: null, read_only: false, trade_permission: true,
      expected_state: { account_revision: '2', positions_revision: '3', pending_orders_revision: '4', quote_revision: '5', contract_revision: '6', risk_revision: '7' },
      target_revision: null,
      quote: { bid: '2500.1', ask: '2500.3', observed_at: meta.generated_at },
      instrument: { point: '0.01', tick_size: '0.01', tick_value: '1', volume_min: '0.01', volume_max: '100', volume_step: '0.01', trade_enabled: true },
    }, meta })
    expect(result.data.expectedState.risk_revision).toBe('7')
    expect(result.data.instrument?.volumeStep).toBe('0.01')
  })

  it('parses distribution estimate and immutable frozen target detail', () => {
    expect(executionDistributionPreviewResponseSchema.safeParse({ data: {
      strategy_id: 's1', strategy_version_id: 'v1', strategy_revision: '2', symbol: 'XAUUSD', target_count: 1,
      targets: [{ account_id: '42', subscription_id: 'sub1', trade_permission: true, ready: false, missing_resources: ['risk'] }],
    }, meta }).success).toBe(true)
    expect(executionDistributionDetailResponseSchema.safeParse({ data: {
      id: 'd1', operation_id: 'op1', strategy_id: 's1', strategy_version_id: 'v1', kind: 'manual_order', source_distribution_id: null,
      command: { command_type: 'market_order' }, status: 'running', target_count: 1, result_summary: { target_count: 1 },
      created_at: meta.generated_at, updated_at: meta.generated_at, completed_at: null, revision: '2',
      targets: [{ id: 't1', account_id: '42', subscription_id: 'sub1', child_operation_id: null, source_ticket: null, status: 'running', error_code: null, revision: '2' }],
    }, meta }).success).toBe(true)
  })

  it('allows user-scoped operation events for distribution parent operations', () => {
    expect(operationRealtimeEventSchema.safeParse({
      v: 4, event_id: 'evt-1', type: 'operation.changed', occurred_at: meta.generated_at, sequence: 1,
      scope: { user_id: '7', trading_account_id: null, terminal_instance_id: null, observer_channel_id: null },
      resource: { kind: 'operation', id: 'op1' }, revision: '2', data: {}, correlation_id: null,
    }).success).toBe(true)
  })
})

describe('trading V4 contracts', () => {
  it('accepts snake_case transport data and exposes typed frontend names', () => {
    expect(tradingContextSchema.parse({ user_id: '7', mode: 'full', account_id: '21', observer_channel_id: null, read_only: false, revision: '3' })).toEqual({ userId: '7', mode: 'full', accountId: '21', observerChannelId: null, readOnly: false, revision: 3 })
    expect(marketCandleSchema.parse({ account_id: '21', symbol: 'XAUUSD', timeframe: 'M5', open_time: '2026-09-03T08:00:00.000Z', open: '1', high: '2', low: '0.5', close: '1.5', tick_volume: '100', closed: false, revision: '8' })).toMatchObject({ accountId: '21', openTime: '2026-09-03T08:00:00.000Z', tickVolume: '100', revision: 8 })
    expect(observerChannelSchema.parse({ id: 'watch-1', display_name: '黄金观摩', source_account_id: '21', active: true })).toEqual({ id: 'watch-1', displayName: '黄金观摩', sourceAccountId: '21', active: true })
  })

  it('rejects legacy or accidental camelCase at the HTTP boundary', () => {
    expect(tradingContextSchema.safeParse({ userId: '7', mode: 'full', accountId: '21', observerChannelId: null, readOnly: false, revision: '3' }).success).toBe(false)
    expect(tradingWorkspaceResponseSchema.safeParse({ data: { pendingOrders: [] }, meta: {} }).success).toBe(false)
  })
})

describe('analyst and account-trader V4 contracts', () => {
  it('keeps manual analysis separate from account execution', () => {
    expect(analysisJobCreateSchema.safeParse({ strategy_id: '10', symbol: 'XAUUSD', mode: 'manual' }).success).toBe(true)
    expect(analysisJobCreateSchema.safeParse({ strategy_id: '10', symbol: 'XAUUSD', mode: 'manual', auto_execute: true }).success).toBe(false)
  })

  it('uses distinct market-analysis and account-level decision summaries', () => {
    expect(marketAnalysisSummarySchema.parse({ analysis_id: 'a1', strategy_id: '10', strategy_version_id: '11', symbol: 'XAUUSD', market_bias: 'bullish', opportunity: 'long_setup', confidence: 76, summary: '结构偏多', analyzed_at: '2026-09-03T08:00:00.000Z', valid_until: '2026-09-03T08:03:00.000Z', revision: '1' })).toMatchObject({ analysisId: 'a1', marketBias: 'bullish', opportunity: 'long_setup' })
    expect(traderRunSchema.parse({ trader_run_id: 't1', analysis_id: 'a1', trading_account_id: '7', strategy_id: '20', strategy_version_id: '21', task_mode: 'manage', status: 'queued', created_at: '2026-09-03T08:00:01.000Z', updated_at: '2026-09-03T08:00:01.000Z', revision: '1' })).toMatchObject({ traderRunId: 't1', taskMode: 'manage' })
    expect(traderDecisionSummarySchema.parse({ decision_id: 'd1', analysis_id: 'a1', trading_account_id: '7', strategy_id: '20', strategy_version_id: '21', action: 'hold', side: null, confidence: 80, summary: '账户保证金不足', status: 'proposed', stale_reason: 'quote_revision_changed', created_at: '2026-09-03T08:00:01.000Z', revision: '1' })).toMatchObject({ decisionId: 'd1', tradingAccountId: '7', action: 'hold', staleReason: 'quote_revision_changed' })
  })
})

describe('account risk V4 contracts', () => {
  const meta = { request_id: 'risk-1', generated_at: '2026-09-04T04:00:00.000Z' }
  const policy = {
    account_id: 'account-7', platform_policy_version_id: 'platform-1', account_policy_version_id: 'account-policy-1',
    global_kill_switch: false, allowed_symbols: ['XAUUSD'], fail_closed_on_incomplete_data: true,
    max_quote_age_seconds: 15, max_risk_summary_age_seconds: 30, max_decision_age_seconds: 45, max_price_deviation_percent: '0.2',
    manual_release_enabled: true, manual_release_max_daily_loss_percent: '5', manual_release_max_drawdown_percent: '12',
    manual_release_max_daily_open_count: 30, manual_release_consecutive_loss_limit: 5,
    max_risk_per_trade_percent: '1', max_daily_loss_percent: '3', max_drawdown_percent: '8', max_open_positions: 5,
    max_pending_orders: 5, max_total_volume: '2', max_spread_points: '30', min_open_interval_seconds: 60,
    max_daily_open_count: 20, consecutive_loss_limit: 3, loss_cooldown_minutes: 15, pending_valid_minutes: 240,
    weekend_close_minutes: 30, trade_send_enabled: true, account_kill_switch: false, require_stop_loss: true,
    editable_fields: ['max_risk_per_trade_percent', 'trade_send_enabled'], revision: '3', updated_at: meta.generated_at,
  }

  it('normalizes strict snake_case policy and summary resources without accepting camelCase wire fields', () => {
    expect(riskPolicySchema.parse(policy)).toMatchObject({ accountId: 'account-7', maxRiskPerTradePercent: '1', editableFields: ['max_risk_per_trade_percent', 'trade_send_enabled'], revision: 3 })
    expect(riskPolicySchema.safeParse({ ...policy, accountId: 'account-7' }).success).toBe(false)
    expect(riskPolicyPatchBodySchema.safeParse({ max_risk_per_trade_percent: '0.5', reason: '降低风险' }).success).toBe(true)
    expect(riskPolicyPatchBodySchema.safeParse({ maxRiskPerTradePercent: '0.5', reason: '降低风险' }).success).toBe(false)

    expect(riskSummarySchema.parse({
      account_id: 'account-7', business_date: '2026-09-04', equity: '10000', free_margin: '9000', margin_level_percent: null,
      daily_loss_percent: '1.2', drawdown_percent: '2.1', open_positions: 1, pending_orders: 0, total_volume: '0.1',
      daily_open_count: 2, consecutive_losses: 0, terminal_timezone_offset_minutes: 180, clock_status: 'calibrated',
      last_successful_open_at: null, cooldown_until: null, data_complete: true, incomplete_reasons: [], observed_at: meta.generated_at, revision: '8',
    })).toMatchObject({ accountId: 'account-7', dailyLossPercent: '1.2', clockStatus: 'calibrated', revision: 8 })
  })

  it('keeps the manual release envelope separate from the write response and exposes server availability', () => {
    const state = manualReleaseStateSchema.parse({
      release: null,
      availability: {
        available: true, code: null, rules: ['RISK_DAILY_LOSS_LIMIT'], expires_at: '2026-09-05T00:00:00.000Z',
        policy_set_revision: '3', risk_state_revision: '8',
      },
    })
    expect(state.release).toBeNull()
    expect(state.availability).toMatchObject({ available: true, expiresAt: '2026-09-05T00:00:00.000Z', policySetRevision: 3, riskStateRevision: 8 })
    expect(manualReleaseStateSchema.safeParse({
      release: null,
      availability: { available: false, code: null, rules: [], expires_at: null, policy_set_revision: '3', risk_state_revision: null },
    }).success).toBe(false)
  })

  it('normalizes risk decisions while preserving explicit rule outcomes and actions', () => {
    const detail = riskDecisionDetailSchema.parse({
      summary: {
        risk_decision_id: 'risk-1', trade_decision_id: 'trade-1', account_id: 'account-7', status: 'rejected', reject_code: 'RISK_DAILY_LOSS_LIMIT',
        platform_policy_version_id: 'platform-1', account_policy_version_id: 'account-policy-1', account_risk_revision: '8', manual_release_id: null,
        created_at: meta.generated_at, revision: '2',
      },
      rules: [{ code: 'RISK_DAILY_LOSS_LIMIT', outcome: 'rejected', action_id: null, details: { current: '3.2' } }],
      approved_actions: [], evaluated_at: meta.generated_at, policy_hash: 'a'.repeat(64),
    })
    expect(detail).toMatchObject({ summary: { riskDecisionId: 'risk-1', rejectCode: 'RISK_DAILY_LOSS_LIMIT' }, rules: [{ actionId: null }], approvedActions: [] })
  })
})

describe('unified execution command contracts', () => {
  const expectedState = {
    account_revision: '12',
    positions_revision: '34',
    pending_orders_revision: '56',
    quote_revision: '78',
    contract_revision: '90',
    risk_revision: '123',
  }
  const resourceExpectedState = { ...expectedState, resource_revision: '456' }

  it('requires the complete optimistic revision vector for every account command', () => {
    expect(executionExpectedStateSchema.safeParse(expectedState).success).toBe(true)
    expect(executionExpectedStateSchema.safeParse({ ...expectedState, quote_revision: 'rev-1' }).success).toBe(false)
    expect(executionExpectedStateSchema.safeParse({ ...expectedState, risk_revision: undefined }).success).toBe(false)
    expect(executionExpectedStateSchema.safeParse({ ...expectedState, extra_revision: '1' }).success).toBe(false)

    expect(executionCommandSchema.safeParse({
      command_type: 'market_order', side: 'buy', symbol: 'XAUUSD', volume: '0.10', stop_loss: '2300.00',
      reference_price: '2350.00', take_profit: '2400.00', expected_state: expectedState,
    }).success).toBe(true)
    expect(executionCommandSchema.safeParse({
      command_type: 'market_order', side: 'buy', symbol: 'XAUUSD', volume: '0.10', stop_loss: '2300.00',
      reference_price: '2350.00', expected_state: resourceExpectedState,
    }).success).toBe(false)
    expect(executionCommandSchema.safeParse({
      command_type: 'market_order', side: 'buy', symbol: 'XAUUSD', volume: '0.10', stop_loss: '0',
      reference_price: '2350.00', expected_state: expectedState,
    }).success).toBe(false)
  })

  it('keeps pending order fields explicit and rejects unknown command fields', () => {
    expect(pendingOrderCommandSchema.safeParse({
      command_type: 'pending_order', order_type: 'buy_stop_limit', symbol: 'XAUUSD', volume: '0.10',
      stop_loss: '2300.00', reference_price: '2350.00', price: '2360.00', stop_limit_price: '2359.00',
      expiration_utc_msc: 1_756_000_000_000, expected_state: expectedState,
    }).success).toBe(true)
    expect(pendingOrderCommandSchema.safeParse({
      command_type: 'pending_order', order_type: 'buy_limit', symbol: 'XAUUSD', volume: '0.10',
      stop_loss: '2300.00', reference_price: '2350.00', price: '2360.00', expected_state: expectedState,
      unsupported: true,
    }).success).toBe(false)
  })

  it('requires an explicit value or remove flag for protection changes', () => {
    expect(modifyPositionCommandSchema.safeParse({ command_type: 'modify_position', ticket: '1001', stop_loss: '2300.00', expected_state: resourceExpectedState }).success).toBe(true)
    expect(modifyPositionCommandSchema.safeParse({ command_type: 'modify_position', ticket: '1001', remove_stop_loss: true, expected_state: resourceExpectedState }).success).toBe(true)
    expect(modifyPositionCommandSchema.safeParse({ command_type: 'modify_position', ticket: '1001', stop_loss: '2300.00', expected_state: expectedState }).success).toBe(false)
    expect(modifyPositionCommandSchema.safeParse({ command_type: 'modify_position', ticket: '1001', expected_state: resourceExpectedState }).success).toBe(false)
    expect(modifyPositionCommandSchema.safeParse({ command_type: 'modify_position', ticket: '1001', stop_loss: '2300.00', remove_stop_loss: true, expected_state: resourceExpectedState }).success).toBe(false)
    expect(modifyPositionCommandSchema.safeParse({ command_type: 'modify_position', ticket: '1001', stop_loss: '0', expected_state: resourceExpectedState }).success).toBe(false)
    expect(modifyPositionCommandSchema.safeParse({ command_type: 'modify_position', ticket: '1001', stop_loss: '2300.00', expected_state: { ...resourceExpectedState, resource_revision: '0' } }).success).toBe(false)
  })

  it('supports exact ticket management and rejects empty order edits', () => {
    expect(closePositionCommandSchema.safeParse({ command_type: 'close_position', ticket: '1001', expected_state: resourceExpectedState }).success).toBe(true)
    expect(closePositionCommandSchema.safeParse({ command_type: 'close_position', ticket: '1001', volume: '0.05', expected_state: resourceExpectedState }).success).toBe(true)
    expect(modifyOrderCommandSchema.safeParse({ command_type: 'modify_order', ticket: '2002', price: '2360.00', expected_state: resourceExpectedState }).success).toBe(true)
    expect(modifyOrderCommandSchema.safeParse({ command_type: 'modify_order', ticket: '2002', remove_expiration: true, expected_state: resourceExpectedState }).success).toBe(true)
    expect(modifyOrderCommandSchema.safeParse({ command_type: 'modify_order', ticket: '2002', expected_state: resourceExpectedState }).success).toBe(false)
    expect(modifyOrderCommandSchema.safeParse({ command_type: 'modify_order', ticket: '2002', expiration_utc_msc: 1_756_000_000_000, remove_expiration: true, expected_state: resourceExpectedState }).success).toBe(false)
  })

  it('keeps distributions limited to entry commands and exact target IDs', () => {
    expect(executionDistributionSchema.safeParse({
      strategy_id: 'strategy_1',
      command: { command_type: 'market_order', side: 'sell', symbol: 'XAUUSD', volume: '0.10', stop_loss: '2400.00', reference_price: '2350.00' },
    }).success).toBe(true)
    expect(executionDistributionSchema.safeParse({
      strategy_id: 'strategy_1',
      command: { command_type: 'close_position', ticket: '1001' },
    }).success).toBe(false)
    expect(distributionCloseCommandSchema.safeParse({ expected_revision: '8', target_ids: [] }).success).toBe(true)
    expect(distributionCloseCommandSchema.safeParse({ expected_revision: '8', target_ids: ['target_1', 'target_1'] }).success).toBe(false)
    expect(distributionCloseCommandSchema.safeParse({ expected_revision: '8', target_ids: [], ticket: '1001' }).success).toBe(false)
  })

  it('accepts operation extension fields without requiring them from older responses', () => {
    const base = {
      operation_id: 'op_1', kind: 'user_execution_command', status: 'accepted',
      accepted_at: '2026-09-04T04:00:00.000Z', updated_at: '2026-09-04T04:00:00.000Z',
      completed_at: null, resource_id: null, error_code: null, revision: '1',
    }
    expect(operationSchema.parse(base)).toMatchObject({ operationId: 'op_1', parentOperationId: null, distributionId: null, resultSummary: null })
    expect(operationSchema.parse({ ...base, parent_operation_id: 'parent_1', distribution_id: 'dist_1', result_summary: { succeeded: 1 } })).toMatchObject({ parentOperationId: 'parent_1', distributionId: 'dist_1', resultSummary: { succeeded: 1 } })
  })
})
