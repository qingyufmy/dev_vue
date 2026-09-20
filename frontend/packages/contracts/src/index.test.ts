import { describe, expect, it } from 'vitest'

import {
  analysisJobCreateSchema, closePositionCommandSchema, distributionCloseCommandSchema, executionCommandSchema,
  executionCommandContextResponseSchema, executionDistributionDetailResponseSchema, executionDistributionPreviewResponseSchema,
  executionDistributionSchema, executionExpectedStateSchema, marketAnalysisSummarySchema, marketCandleSchema,
  modifyOrderCommandSchema, modifyPositionCommandSchema, observerChannelSchema, operationSchema,
  operationRealtimeEventSchema, pendingOrderCommandSchema, traderDecisionSummarySchema, traderRunSchema, tradingContextSchema,
  tradingWorkspaceResponseSchema, sessionResponseSchema, manualReleaseStateSchema, riskDecisionDetailSchema,
  riskPolicyPatchBodySchema, riskPolicySchema, riskSummarySchema, strategyCompileBodySchema, strategyCompileResultSchema,
  strategyCreateBodySchema, strategyDetailSchema, strategyMetadataPatchBodySchema, strategySubscriptionSchema,
  strategySubscriptionCreateBodySchema, strategySubscriptionPatchBodySchema, strategyVersionCreateBodySchema,
  browserRealtimeEventSchema, manualReviewCandidateSchema, reviewCaseDetailSchema, reviewContentSchema,
  reviewVersionCreateBodySchema, strategyMemoryDetailSchema, strategyMemoryUpdateSchema,
  accountSnapshotSchema, tradingAccountSchema,
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

  it('requires terminal_profile_id while accepting an explicit null profile', () => {
    const account = {
      id: 'account-1', platform: 'mt5', login: '10001', server: 'Demo', currency: 'USD',
      terminal_instance_id: null, bridge_state: 'offline', trade_permission: false, last_seen_at: null,
    }
    const snapshot = {
      ...account, balance: '10000', equity: '10000', margin: '0', free_margin: '10000', floating_profit: '0',
      leverage: null, timezone_offset_minutes: null, clock_status: 'unavailable', observed_at: '2026-09-04T08:00:00.000Z', revision: '1',
    }

    expect(tradingAccountSchema.safeParse(account).success).toBe(false)
    expect(tradingAccountSchema.parse({ ...account, terminal_profile_id: null })).toMatchObject({ terminalProfileId: null })
    expect(accountSnapshotSchema.safeParse(snapshot).success).toBe(false)
    expect(accountSnapshotSchema.parse({ ...snapshot, terminal_profile_id: null })).toMatchObject({ terminalProfileId: null })
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

describe('strategy management V4 contracts', () => {
  const version = {
    id: 'version-1', strategy_id: 'strategy-1', kind: 'analysis', version: 1,
    prompt_text: '分析 XAUUSD 的市场结构', prompt_hash: 'a'.repeat(64), config: { timeframes: ['M5'] },
    input_contract_version: 'market-analysis-input/v1', output_contract_version: 'market-analysis/v1',
    created_by_user_id: '7', created_at: '2026-09-04T04:00:00.000Z',
  }
  const subscription = {
    id: 'subscription-1', user_id: '7', trading_account_id: 'account-1', symbol: 'XAUUSD',
    analysis_strategy_id: 'strategy-1', analysis_strategy_version_id: 'version-1', trader_strategy_id: null,
    trader_strategy_version_id: null, analysis_enabled: true, trader_enabled: false, trade_send_enabled: false,
    status: 'active', revision: '1', created_at: '2026-09-04T04:00:00.000Z', updated_at: '2026-09-04T04:00:00.000Z',
    schedule: { cadence_seconds: 300, receive_timezone: 'UTC', receive_window: { enabled: false }, next_due_at: null, revision: '1' },
  }

  it('normalizes strategy details and keeps immutable versions explicit', () => {
    const result = strategyDetailSchema.parse({
      id: 'strategy-1', kind: 'analysis', scope: 'user', owner_user_id: '7', name: '黄金分析', description: '结构分析',
      status: 'draft', active_version_id: null, revision: '1', versions: [version],
    })
    expect(result).toMatchObject({ ownerUserId: '7', activeVersionId: null, versions: [{ strategyId: 'strategy-1', createdByUserId: '7' }] })
    expect(strategyDetailSchema.safeParse({
      id: 'strategy-1', kind: 'analysis', scope: 'user', owner_user_id: '7', name: '黄金分析', description: '结构分析',
      status: 'draft', active_version_id: null, revision: '1', versions: [], unexpected: true,
    }).success).toBe(false)
  })

  it('accepts strict strategy inputs and rejects camelCase or unsupported capabilities', () => {
    expect(strategyCompileBodySchema.safeParse({ kind: 'analysis', prompt_text: '分析', config: { timeframes: ['M5'] } }).success).toBe(true)
    expect(strategyCompileBodySchema.safeParse({ kind: 'analysis', promptText: '分析', config: {} }).success).toBe(false)
    expect(strategyCreateBodySchema.safeParse({ kind: 'trader', name: '执行策略', description: '', prompt_text: '执行', config: {} }).success).toBe(true)
    expect(strategyVersionCreateBodySchema.safeParse({ prompt_text: 'v2', config: {} }).success).toBe(true)
    expect(strategyMetadataPatchBodySchema.safeParse({ name: '新名字', description: '说明' }).success).toBe(true)
    expect(strategyCompileResultSchema.safeParse({
      valid: false, kind: 'trader', prompt_hash: 'b'.repeat(64), normalized_config: {},
      input_contract_version: 'account-trader-input/v1', output_contract_version: 'trade-decision/v1',
      issues: [{ level: 'error', code: 'dangerous_capability_forbidden', message: '禁止', path: 'config.network' }],
    }).success).toBe(true)
  })

  it('normalizes subscription resources and keeps update fields strict', () => {
    expect(strategySubscriptionSchema.parse(subscription)).toMatchObject({ tradingAccountId: 'account-1', standardSymbol: 'XAUUSD', schedule: { cadenceSeconds: 300, receiveTimezone: 'UTC' } })
    expect(strategySubscriptionSchema.parse({ ...subscription, schedule: { ...subscription.schedule, receive_timezone: 'Asia/Shanghai' } }).schedule.receiveTimezone).toBe('Asia/Shanghai')
    expect(strategySubscriptionCreateBodySchema.safeParse({ trading_account_id: 'account-1', symbol: 'XAUUSD', analysis_strategy_id: 'strategy-1' }).success).toBe(true)
    expect(strategySubscriptionPatchBodySchema.safeParse({ trader_enabled: true, trader_strategy_id: 'trader-1' }).success).toBe(true)
    expect(strategySubscriptionPatchBodySchema.safeParse({ traderEnabled: true }).success).toBe(false)
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
    max_pending_orders: 5, max_order_volume: '0.05', max_total_volume: '2', max_spread_points: '30', min_open_interval_seconds: 60,
    max_daily_open_count: 20, consecutive_loss_limit: 3, loss_cooldown_minutes: 15, pending_valid_minutes: 240,
    weekend_close_minutes: 30, trade_send_enabled: true, account_kill_switch: false, require_stop_loss: true,
    editable_fields: ['max_risk_per_trade_percent', 'trade_send_enabled'], revision: '3', updated_at: meta.generated_at,
  }

  it('preserves decimal control ranges and rejects inverted or invalid locked bounds', () => {
    const control = { allowed_min: '0.01', allowed_max: '0.2', locked_value: null, user_editable: true }
    expect(riskPolicySchema.parse({ ...policy, numeric_controls: { max_order_volume: control } }).numericControls.max_order_volume).toEqual(control)
    expect(riskPolicySchema.parse(policy).numericControls).toEqual({})
    const { max_order_volume: _oldAbsent, ...historical } = policy
    expect(riskPolicySchema.parse(historical).maxOrderVolume).toBeUndefined()
    expect(riskPolicySchema.safeParse({ ...policy, numeric_controls: { max_order_volume: { ...control, allowed_min: '0.3' } } }).success).toBe(false)
    expect(riskPolicySchema.safeParse({ ...policy, numeric_controls: { max_order_volume: { ...control, locked_value: '0.3' } } }).success).toBe(false)
  })

  it('reads the system ATR multiplier without allowing account writes or inventing it for old responses', () => {
    expect(riskPolicySchema.parse(policy).pendingDedupAtrMultiplier).toBeUndefined()
    for (const value of ['0', '0.05', '5']) {
      expect(riskPolicySchema.parse({ ...policy, pending_dedup_atr_multiplier: value }).pendingDedupAtrMultiplier).toBe(value)
    }
    for (const value of ['-1', '5.01', '01', 0.05]) {
      expect(riskPolicySchema.safeParse({ ...policy, pending_dedup_atr_multiplier: value }).success).toBe(false)
    }
    expect(riskPolicyPatchBodySchema.safeParse({ pending_dedup_atr_multiplier: '0.5', reason: '不能编辑系统字段' }).success).toBe(false)
  })

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

describe('review and strategy-memory contracts', () => {
  const reviewContent = {
    schema_version: 'review.v4.1', conclusion: 'mixed', headline: '复盘结论', summary: '冻结证据下的摘要',
    metrics: { net_profit: '12.5', trade_count: 1, win_rate_percent: '100', profit_factor: '2.0' },
    trade_episodes: [],
    roles: Object.fromEntries(['analyst', 'trader', 'risk', 'execution'].map(key => [key, { assessment: 'effective', summary: `${key} 正常`, evidence_refs: ['source:1'] }])),
    counterexamples: [], memory_candidates: [], evidence_refs: ['source:1'], full_analysis_text: '完整正文',
  }

  it('normalizes a complete review while retaining the full analysis body', () => {
    expect(reviewContentSchema.parse(reviewContent)).toMatchObject({ schemaVersion: 'review.v4.1', fullAnalysisText: '完整正文', roles: { analyst: { evidenceRefs: ['source:1'] } } })
    expect(reviewCaseDetailSchema.parse({
      summary: {
        id: 'case-1', kind: 'daily', user_id: '7', trading_account_id: 'account-1', account_label: 'MT5 · 10001 · Demo', symbol: 'XAUUSD',
        subscription_id: 'subscription-1', subscription_revision: '4',
        analysis_strategy_id: 'strategy-1', analysis_strategy_name: '分析策略', trader_strategy_id: 'strategy-2', trader_strategy_name: '交易策略',
        terminal_period_start: '2026-09-03T21:00:00.000Z', terminal_period_end: '2026-09-04T21:00:00.000Z', terminal_timezone_offset_minutes: 180,
        status: 'awaiting_confirmation', evidence_status: 'complete', evidence_revision: '2', evidence_hash: 'b'.repeat(64), current_version_id: 'version-1', confirmed_version_id: null,
        updated_at: '2026-09-04T22:00:00.000Z', revision: '3',
      },
      current_version: { id: 'version-1', review_case_id: 'case-1', version: 1, author_kind: 'ai', conclusion: 'mixed', content: reviewContent, created_at: '2026-09-04T22:00:00.000Z' },
      sources: [{ kind: 'market_analysis', source_id: 'source:1', relation: 'direct', evidence_hash: 'a'.repeat(64) }],
      current_job: null, return_reason: null,
    })).toMatchObject({ summary: { evidenceRevision: 2, evidenceHash: 'b'.repeat(64), revision: 3 }, currentVersion: { versionNumber: 1 } })
  })

  it('keeps manual candidate tokens and memory CAS revisions explicit', () => {
    expect(manualReviewCandidateSchema.parse({ id: 'candidate-1', trading_account_id: 'account-1', account_label: 'MT5 · 10001 · Demo', ticket: '123', position_id: null, symbol: 'XAUUSD', side: 'buy', volume: '0.10', opened_at: '2026-09-04T08:00:00.000Z', closed_at: '2026-09-04T09:00:00.000Z', net_profit: '12.5', terminal_timezone_offset_minutes: 180, source_classification: 'manual', eligibility_status: 'eligible', selection_token: `candidate-1.2.${'b'.repeat(64)}`, selection_expires_at: '2026-09-04T09:05:00.000Z', revision: '2' })).toMatchObject({ selectionToken: expect.any(String), revision: 2, terminalTimezoneOffsetMinutes: 180 })
    expect(strategyMemoryDetailSchema.parse({ id: 'memory-1', strategy_id: 'strategy-1', strategy_name: '分析策略', strategy_kind: 'analysis', owner_user_id: '7', mode: 'shadow', status: 'active', current_version: 1, pending_count: 1, updated_at: '2026-09-04T09:00:00.000Z', revision: '4', current_revision_id: 'memory-version-1', content_text: '经验正文', content_hash: 'c'.repeat(64), max_context_tokens: 800 })).toMatchObject({ currentVersionNumber: 1, pendingCount: 1, revision: 4 })
    expect(strategyMemoryUpdateSchema.parse({ id: 'update-1', library_id: 'memory-1', source_review_case_id: 'case-1', source_review_version_id: 'version-1', update_kind: 'short_term', status: 'awaiting_confirmation', expected_library_revision: '4', proposal: { memory_key: 'entry.confirmation', title: '等待确认', content: '连续证据确认后再入场。', evidence_refs: ['market_analysis:1'] }, diff_preview_text: '+经验', conflicts: [{ type: 'same_key_content_changed', prior_update_id: 'update-0', memory_key: 'entry.confirmation' }], created_at: '2026-09-04T09:00:00.000Z', revision: '1' })).toMatchObject({ proposal: { memoryKey: 'entry.confirmation' }, conflicts: [{ priorUpdateId: 'update-0' }], revision: 1 })
    expect(strategyMemoryUpdateSchema.safeParse({ id: 'update-1', library_id: 'memory-1', source_review_case_id: 'case-1', source_review_version_id: 'version-1', update_kind: 'short_term', status: 'awaiting_confirmation', expected_library_revision: '4', proposal: {}, diff_preview_text: '+经验', conflicts: [], created_at: '2026-09-04T09:00:00.000Z', revision: '1' }).success).toBe(false)
    expect(reviewVersionCreateBodySchema.safeParse({ content: reviewContent }).success).toBe(true)
    expect(reviewVersionCreateBodySchema.safeParse({ content: { schema_version: 'review.v4.1' } }).success).toBe(false)
  })

  it('recognizes review invalidation events without accepting an oversized payload', () => {
    expect(browserRealtimeEventSchema.safeParse({ v: 4, event_id: 'event-1', type: 'review.case.changed', occurred_at: '2026-09-04T09:00:00.000Z', sequence: 1, scope: { user_id: '7', trading_account_id: 'account-1', terminal_instance_id: null, observer_channel_id: null }, resource: { kind: 'review_case', id: 'case-1' }, revision: '4', data: { review_case_id: 'case-1', status: 'awaiting_confirmation', current_version_id: 'version-1', revision: '4' }, correlation_id: null }).success).toBe(true)
    expect(browserRealtimeEventSchema.safeParse({ v: 4, event_id: 'event-1', type: 'review.case.changed', occurred_at: '2026-09-04T09:00:00.000Z', sequence: 1, scope: { user_id: '7', trading_account_id: null, terminal_instance_id: null, observer_channel_id: null }, resource: { kind: 'review_case', id: 'case-1' }, revision: '4', data: { review_case_id: 'case-1', status: 'confirmed', revision: '4', full_analysis_text: 'must-not-stream' }, correlation_id: null }).success).toBe(false)
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
