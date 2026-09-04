import { describe, expect, it } from 'vitest'

import {
  analysisJobCreateSchema, closePositionCommandSchema, distributionCloseCommandSchema, executionCommandSchema,
  executionCommandContextResponseSchema, executionDistributionDetailResponseSchema, executionDistributionPreviewResponseSchema,
  executionDistributionSchema, executionExpectedStateSchema, marketAnalysisSummarySchema, marketCandleSchema,
  modifyOrderCommandSchema, modifyPositionCommandSchema, observerChannelSchema, operationSchema,
  operationRealtimeEventSchema, pendingOrderCommandSchema, traderDecisionSummarySchema, traderRunSchema, tradingContextSchema,
  tradingWorkspaceResponseSchema, sessionResponseSchema,
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
