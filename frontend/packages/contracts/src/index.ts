import { z } from 'zod'

export const appSurfaceSchema = z.enum(['www', 'trade', 'admin'])

export const userSummarySchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  avatar_url: z.string().min(1).nullable(),
})

export const sessionSummarySchema = z.object({
  user: userSummarySchema,
  app: appSurfaceSchema,
  permissions: z.array(z.string()),
  authenticated_at: z.iso.datetime({ offset: true }),
  mfa_level: z.enum(['none', 'otp', 'strong']),
  csrf_token: z.string().min(1),
})

export const responseMetaSchema = z.object({
  request_id: z.string().min(1),
  generated_at: z.iso.datetime({ offset: true }),
})

export const sessionResponseSchema = z.object({
  data: sessionSummarySchema,
  meta: responseMetaSchema,
})

export const fieldProblemSchema = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
})

export const apiProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string(),
  instance: z.string(),
  correlation_id: z.string(),
  retryable: z.boolean(),
  errors: z.array(fieldProblemSchema).optional(),
  retry_after_ms: z.number().int().nonnegative().optional(),
})

export const realtimeTicketResponseSchema = z.object({
  data: z.object({
    ws_url: z.literal('/realtime/v4'),
    protocol: z.literal('aurum.realtime.v4'),
    capabilities: z.array(z.string()),
    expires_at: z.iso.datetime({ offset: true }),
  }),
  meta: responseMetaSchema,
})

export const authorizationRequestSchema = z.object({
  client_id: z.enum(['www-web', 'trade-web', 'admin-web']),
  redirect_uri: z.url(),
  response_type: z.literal('code'),
  scope: z.literal('openid profile'),
  state: z.string().min(24).max(128),
  nonce: z.string().min(24).max(128),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal('S256'),
})

export const authLoginRequestSchema = authorizationRequestSchema.extend({
  login: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(1024),
  remember: z.boolean(),
})

export const authLoginResponseSchema = z.object({
  data: z.object({ redirect_to: z.url() }),
  meta: responseMetaSchema,
})

export const tradingPlatformSchema = z.enum(['mt4', 'mt5'])
export const bridgeStateSchema = z.enum(['online', 'offline', 'paused', 'replaced', 'unauthorized'])
export const timeframeSchema = z.enum(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'])
export const decimalSchema = z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
const numericRevisionSchema = z.string().regex(/^\d+$/).transform(Number)

export const tradingContextSchema = z.object({
  user_id: z.string().min(1),
  mode: z.enum(['full', 'observer', 'blocked']),
  account_id: z.string().min(1).nullable(),
  observer_channel_id: z.string().min(1).nullable(),
  read_only: z.boolean(),
  revision: numericRevisionSchema,
}).transform((value) => ({ userId: value.user_id, mode: value.mode, accountId: value.account_id, observerChannelId: value.observer_channel_id, readOnly: value.read_only, revision: value.revision }))

export const tradingAccountSchema = z.object({
  id: z.string().min(1), platform: tradingPlatformSchema, login: z.string().min(1), server: z.string().min(1),
  currency: z.string().min(3), terminal_profile_id: z.string().min(1), terminal_instance_id: z.string().min(1).nullable(),
  bridge_state: bridgeStateSchema, trade_permission: z.boolean(), last_seen_at: z.iso.datetime({ offset: true }).nullable(),
}).transform((value) => ({ id: value.id, platform: value.platform, login: value.login, server: value.server, currency: value.currency,
  terminalProfileId: value.terminal_profile_id, terminalInstanceId: value.terminal_instance_id, bridgeState: value.bridge_state,
  tradePermission: value.trade_permission, lastSeenAt: value.last_seen_at }))

export const accountSnapshotSchema = z.object({
  id: z.string().min(1), platform: tradingPlatformSchema, login: z.string().min(1), server: z.string().min(1), currency: z.string().min(3),
  terminal_profile_id: z.string().min(1), terminal_instance_id: z.string().min(1).nullable(), bridge_state: bridgeStateSchema,
  trade_permission: z.boolean(), last_seen_at: z.iso.datetime({ offset: true }).nullable(),
  balance: decimalSchema, equity: decimalSchema, margin: decimalSchema, free_margin: decimalSchema,
  floating_profit: decimalSchema, leverage: z.number().int().positive().nullable(), timezone_offset_minutes: z.number().int().min(-840).max(840).nullable(),
  clock_status: z.enum(['calibrated', 'observer_bootstrap', 'stale', 'unavailable']), observed_at: z.iso.datetime({ offset: true }),
  revision: numericRevisionSchema,
}).transform((value) => ({ id: value.id, platform: value.platform, login: value.login, server: value.server, currency: value.currency,
  terminalProfileId: value.terminal_profile_id, terminalInstanceId: value.terminal_instance_id, bridgeState: value.bridge_state,
  tradePermission: value.trade_permission, lastSeenAt: value.last_seen_at, balance: value.balance, equity: value.equity, margin: value.margin,
  freeMargin: value.free_margin, floatingProfit: value.floating_profit, leverage: value.leverage, timezoneOffsetMinutes: value.timezone_offset_minutes,
  clockStatus: value.clock_status, observedAt: value.observed_at, revision: value.revision }))

export const marketQuoteSchema = z.object({
  account_id: z.string(), symbol: z.string(), bid: decimalSchema, ask: decimalSchema, last: decimalSchema.nullable(), spread: decimalSchema,
  trade_mode: z.enum(['full', 'long_only', 'short_only', 'close_only', 'disabled', 'unknown']),
  observed_at: z.iso.datetime({ offset: true }), revision: numericRevisionSchema,
}).transform((value) => ({ accountId: value.account_id, symbol: value.symbol, bid: value.bid, ask: value.ask, last: value.last, spread: value.spread, tradeMode: value.trade_mode, observedAt: value.observed_at, revision: value.revision }))

export const marketCandleSchema = z.object({
  account_id: z.string(), symbol: z.string(), timeframe: timeframeSchema, open_time: z.iso.datetime({ offset: true }),
  open: decimalSchema, high: decimalSchema, low: decimalSchema, close: decimalSchema, tick_volume: decimalSchema,
  closed: z.boolean(), revision: numericRevisionSchema,
}).transform((value) => ({ accountId: value.account_id, symbol: value.symbol, timeframe: value.timeframe, openTime: value.open_time, open: value.open, high: value.high, low: value.low, close: value.close, tickVolume: value.tick_volume, closed: value.closed, revision: value.revision }))

export const openPositionSchema = z.object({
  ticket: z.string(), account_id: z.string(), symbol: z.string(), side: z.enum(['buy', 'sell']), volume: decimalSchema,
  open_price: decimalSchema, current_price: decimalSchema, stop_loss: decimalSchema.nullable(), take_profit: decimalSchema.nullable(),
  floating_profit: decimalSchema, opened_at: z.iso.datetime({ offset: true }), source: z.enum(['manual', 'signal', 'unknown']),
  signal_id: z.string().nullable(), revision: numericRevisionSchema,
}).transform((value) => ({ ticket: value.ticket, accountId: value.account_id, symbol: value.symbol, side: value.side, volume: value.volume,
  openPrice: value.open_price, currentPrice: value.current_price, stopLoss: value.stop_loss, takeProfit: value.take_profit,
  floatingProfit: value.floating_profit, openedAt: value.opened_at, source: value.source, signalId: value.signal_id, revision: value.revision }))

export const pendingOrderSchema = z.object({
  ticket: z.string(), account_id: z.string(), symbol: z.string(),
  type: z.enum(['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit']), volume: decimalSchema,
  price: decimalSchema, stop_loss: decimalSchema.nullable(), take_profit: decimalSchema.nullable(), created_at: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }).nullable(), source: z.enum(['manual', 'signal', 'unknown']), signal_id: z.string().nullable(),
  revision: numericRevisionSchema,
}).transform((value) => ({ ticket: value.ticket, accountId: value.account_id, symbol: value.symbol, type: value.type, volume: value.volume,
  price: value.price, stopLoss: value.stop_loss, takeProfit: value.take_profit, createdAt: value.created_at, expiresAt: value.expires_at,
  source: value.source, signalId: value.signal_id, revision: value.revision }))

export const tradingContextResponseSchema = z.object({ data: tradingContextSchema, meta: responseMetaSchema })
export const tradingAccountsResponseSchema = z.object({ data: z.object({ items: z.array(tradingAccountSchema) }), meta: responseMetaSchema })
export const connectionCapacityResponseSchema = z.object({ data: z.object({ included: z.number().int(), purchased: z.number().int(), total: z.number().int(), active: z.number().int(), available: z.number().int() }), meta: responseMetaSchema })
export const terminalProfilesResponseSchema = z.object({ data: z.object({ items: z.array(z.object({
  id: z.string(), display_name: z.string(), platform: tradingPlatformSchema, installation_id: z.string(), account_id: z.string().nullable(),
  connection_state: z.enum(['online', 'offline', 'paused']), last_seen_at: z.iso.datetime({ offset: true }).nullable(),
})) }), meta: responseMetaSchema })
export const observerChannelSchema = z.object({ id: z.string(), display_name: z.string(), source_account_id: z.string(), active: z.boolean() })
  .transform((value) => ({ id: value.id, displayName: value.display_name, sourceAccountId: value.source_account_id, active: value.active }))
export const observerChannelsResponseSchema = z.object({ data: z.object({ items: z.array(observerChannelSchema) }), meta: responseMetaSchema })
export const tradingWorkspaceResponseSchema = z.object({
  data: z.object({ account: tradingAccountSchema, snapshot: accountSnapshotSchema.nullable(), symbols: z.array(z.string()),
    positions: z.object({ revision: numericRevisionSchema, items: z.array(openPositionSchema) }),
    pending_orders: z.object({ revision: numericRevisionSchema, items: z.array(pendingOrderSchema) }),
  }).transform((value) => ({ account: value.account, snapshot: value.snapshot, symbols: value.symbols, positions: value.positions, pendingOrders: value.pending_orders })), meta: responseMetaSchema,
})
export const marketQuoteResponseSchema = z.object({ data: marketQuoteSchema.nullable(), meta: responseMetaSchema })
export const marketCandlesResponseSchema = z.object({ data: z.object({ items: z.array(marketCandleSchema) }), meta: responseMetaSchema })

export const strategyKindSchema = z.enum(['analysis', 'trader'])
export const strategyScopeSchema = z.enum(['platform', 'user'])
export const strategyStatusSchema = z.enum(['draft', 'active', 'retired'])
export const strategySummarySchema = z.object({
  id: z.string().min(1),
  kind: strategyKindSchema,
  scope: strategyScopeSchema,
  owner_user_id: z.string().min(1).nullable(),
  name: z.string().min(1).max(191),
  description: z.string().max(2000),
  status: strategyStatusSchema,
  active_version_id: z.string().min(1).nullable(),
  revision: numericRevisionSchema,
}).transform((value) => ({
  id: value.id, kind: value.kind, scope: value.scope, ownerUserId: value.owner_user_id, name: value.name,
  description: value.description, status: value.status, activeVersionId: value.active_version_id, revision: value.revision,
}))
export const strategiesResponseSchema = z.object({ data: z.object({ items: z.array(strategySummarySchema) }), meta: responseMetaSchema })

export const analysisRunStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'])
export const analysisJobCreateSchema = z.object({
  strategy_id: z.string().min(1),
  symbol: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  mode: z.literal('manual'),
}).strict()
export const analysisJobSchema = z.object({
  analysis_id: z.string().min(1),
  strategy_id: z.string().min(1),
  strategy_version_id: z.string().min(1),
  symbol: z.string().min(1),
  trigger: z.enum(['manual', 'scheduled', 'event']),
  status: analysisRunStatusSchema,
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  revision: numericRevisionSchema,
}).transform((value) => ({
  analysisId: value.analysis_id, strategyId: value.strategy_id, strategyVersionId: value.strategy_version_id,
  symbol: value.symbol, trigger: value.trigger, status: value.status, createdAt: value.created_at,
  updatedAt: value.updated_at, revision: value.revision,
}))
export const analysisJobResponseSchema = z.object({ data: analysisJobSchema, meta: responseMetaSchema })

export const marketBiasSchema = z.enum(['bullish', 'bearish', 'neutral', 'uncertain'])
export const marketOpportunitySchema = z.enum(['none', 'long_setup', 'short_setup'])
export const marketAnalysisSummarySchema = z.object({
  analysis_id: z.string().min(1),
  strategy_id: z.string().min(1),
  strategy_version_id: z.string().min(1),
  symbol: z.string().min(1),
  market_bias: marketBiasSchema,
  opportunity: marketOpportunitySchema,
  confidence: z.number().min(0).max(100),
  summary: z.string(),
  analyzed_at: z.iso.datetime({ offset: true }),
  valid_until: z.iso.datetime({ offset: true }),
  revision: numericRevisionSchema,
}).transform((value) => ({
  analysisId: value.analysis_id, strategyId: value.strategy_id, strategyVersionId: value.strategy_version_id,
  symbol: value.symbol, marketBias: value.market_bias, opportunity: value.opportunity,
  confidence: value.confidence, summary: value.summary, analyzedAt: value.analyzed_at,
  validUntil: value.valid_until, revision: value.revision,
}))
export const marketAnalysisDetailSchema = z.object({
  summary: marketAnalysisSummarySchema,
  market_regime: z.string().max(128),
  supporting_evidence: z.array(z.string()),
  counter_evidence: z.array(z.string()),
  key_levels: z.record(z.string(), z.unknown()),
  invalidation: z.record(z.string(), z.unknown()),
  data_gaps: z.array(z.string()),
  analysis_body: z.string(),
  input_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
})
export const marketAnalysisListResponseSchema = z.object({ data: z.object({ items: z.array(marketAnalysisSummarySchema) }), meta: responseMetaSchema })
export const marketAnalysisDetailResponseSchema = z.object({ data: marketAnalysisDetailSchema, meta: responseMetaSchema })

const traderExecutableActionValues = ['market_order', 'pending_order', 'modify_position', 'close_position', 'modify_order', 'cancel_order'] as const
export const traderExecutableActionSchema = z.enum(traderExecutableActionValues)
export const traderActionSchema = z.enum(['hold', ...traderExecutableActionValues])
export const traderDecisionStatusSchema = z.enum(['proposed', 'stale', 'risk_rejected', 'accepted'])
export const traderTaskModeSchema = z.enum(['entry', 'manage', 'both'])
export const traderRunSchema = z.object({
  trader_run_id: z.string().min(1),
  analysis_id: z.string().min(1),
  trading_account_id: z.string().min(1),
  strategy_id: z.string().min(1),
  strategy_version_id: z.string().min(1),
  task_mode: traderTaskModeSchema,
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired']),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  revision: numericRevisionSchema,
}).transform((value) => ({
  traderRunId: value.trader_run_id, analysisId: value.analysis_id, tradingAccountId: value.trading_account_id,
  strategyId: value.strategy_id, strategyVersionId: value.strategy_version_id, taskMode: value.task_mode,
  status: value.status, createdAt: value.created_at, updatedAt: value.updated_at, revision: value.revision,
}))
export const traderRunResponseSchema = z.object({ data: traderRunSchema, meta: responseMetaSchema })
export const traderDecisionSummarySchema = z.object({
  decision_id: z.string().min(1),
  analysis_id: z.string().min(1),
  trading_account_id: z.string().min(1),
  strategy_id: z.string().min(1),
  strategy_version_id: z.string().min(1),
  action: traderActionSchema,
  side: z.enum(['buy', 'sell']).nullable(),
  confidence: z.number().min(0).max(100),
  summary: z.string(),
  status: traderDecisionStatusSchema,
  stale_reason: z.string().nullable().optional(),
  created_at: z.iso.datetime({ offset: true }),
  revision: numericRevisionSchema,
}).transform((value) => ({
  decisionId: value.decision_id, analysisId: value.analysis_id, tradingAccountId: value.trading_account_id,
  strategyId: value.strategy_id, strategyVersionId: value.strategy_version_id, action: value.action,
  side: value.side, confidence: value.confidence, summary: value.summary, status: value.status,
  staleReason: value.stale_reason ?? null, createdAt: value.created_at, revision: value.revision,
}))
export const traderDecisionDetailSchema = z.object({
  summary: traderDecisionSummarySchema,
  actions: z.array(z.object({
    action_id: z.string().min(1),
    kind: traderExecutableActionSchema,
    parameters: z.record(z.string(), z.unknown()),
    expected_state: z.record(z.string(), z.unknown()),
  })),
  reasoning: z.string(),
  input_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
})
export const traderDecisionListResponseSchema = z.object({ data: z.object({ items: z.array(traderDecisionSummarySchema) }), meta: responseMetaSchema })
export const traderDecisionDetailResponseSchema = z.object({ data: traderDecisionDetailSchema, meta: responseMetaSchema })

const riskPolicyDecimalSchema = decimalSchema
const riskPolicyEditableInteger = (minimum: number, maximum?: number) => {
  const schema = z.number().int().min(minimum)
  return maximum === undefined ? schema : schema.max(maximum)
}

/**
 * Account risk HTTP resources deliberately keep decimal values as strings on
 * the wire.  This avoids silently changing broker precision in the browser;
 * only revisions and explicitly integral counters are normalized to numbers.
 */
export const riskPolicySchema = z.object({
  account_id: z.string().min(1),
  platform_policy_version_id: z.string().min(1),
  account_policy_version_id: z.string().min(1).nullable(),
  global_kill_switch: z.boolean(),
  allowed_symbols: z.array(z.string().trim().min(1).max(64)).min(1).refine((values) => new Set(values).size === values.length),
  fail_closed_on_incomplete_data: z.literal(true),
  max_quote_age_seconds: riskPolicyEditableInteger(1),
  max_risk_summary_age_seconds: riskPolicyEditableInteger(1),
  max_decision_age_seconds: riskPolicyEditableInteger(1),
  max_price_deviation_percent: riskPolicyDecimalSchema,
  manual_release_enabled: z.boolean(),
  manual_release_max_daily_loss_percent: riskPolicyDecimalSchema,
  manual_release_max_drawdown_percent: riskPolicyDecimalSchema,
  manual_release_max_daily_open_count: riskPolicyEditableInteger(0),
  manual_release_consecutive_loss_limit: riskPolicyEditableInteger(0),
  max_risk_per_trade_percent: riskPolicyDecimalSchema,
  max_daily_loss_percent: riskPolicyDecimalSchema,
  max_drawdown_percent: riskPolicyDecimalSchema,
  max_open_positions: riskPolicyEditableInteger(0, 1000),
  max_pending_orders: riskPolicyEditableInteger(0, 1000),
  max_total_volume: riskPolicyDecimalSchema,
  max_spread_points: riskPolicyDecimalSchema,
  min_open_interval_seconds: riskPolicyEditableInteger(0, 86400),
  max_daily_open_count: riskPolicyEditableInteger(0, 10000),
  consecutive_loss_limit: riskPolicyEditableInteger(0, 1000),
  loss_cooldown_minutes: riskPolicyEditableInteger(0, 10080),
  pending_valid_minutes: riskPolicyEditableInteger(1, 10080),
  weekend_close_minutes: riskPolicyEditableInteger(0, 2880),
  trade_send_enabled: z.boolean(),
  account_kill_switch: z.boolean(),
  require_stop_loss: z.literal(true),
  editable_fields: z.array(z.string().trim().min(1).max(64)).refine((values) => new Set(values).size === values.length),
  revision: numericRevisionSchema,
  updated_at: z.iso.datetime({ offset: true }),
}).strict().transform((value) => ({
  accountId: value.account_id,
  platformPolicyVersionId: value.platform_policy_version_id,
  accountPolicyVersionId: value.account_policy_version_id,
  globalKillSwitch: value.global_kill_switch,
  allowedSymbols: value.allowed_symbols,
  failClosedOnIncompleteData: value.fail_closed_on_incomplete_data,
  maxQuoteAgeSeconds: value.max_quote_age_seconds,
  maxRiskSummaryAgeSeconds: value.max_risk_summary_age_seconds,
  maxDecisionAgeSeconds: value.max_decision_age_seconds,
  maxPriceDeviationPercent: value.max_price_deviation_percent,
  manualReleaseEnabled: value.manual_release_enabled,
  manualReleaseMaxDailyLossPercent: value.manual_release_max_daily_loss_percent,
  manualReleaseMaxDrawdownPercent: value.manual_release_max_drawdown_percent,
  manualReleaseMaxDailyOpenCount: value.manual_release_max_daily_open_count,
  manualReleaseConsecutiveLossLimit: value.manual_release_consecutive_loss_limit,
  maxRiskPerTradePercent: value.max_risk_per_trade_percent,
  maxDailyLossPercent: value.max_daily_loss_percent,
  maxDrawdownPercent: value.max_drawdown_percent,
  maxOpenPositions: value.max_open_positions,
  maxPendingOrders: value.max_pending_orders,
  maxTotalVolume: value.max_total_volume,
  maxSpreadPoints: value.max_spread_points,
  minOpenIntervalSeconds: value.min_open_interval_seconds,
  maxDailyOpenCount: value.max_daily_open_count,
  consecutiveLossLimit: value.consecutive_loss_limit,
  lossCooldownMinutes: value.loss_cooldown_minutes,
  pendingValidMinutes: value.pending_valid_minutes,
  weekendCloseMinutes: value.weekend_close_minutes,
  tradeSendEnabled: value.trade_send_enabled,
  accountKillSwitch: value.account_kill_switch,
  requireStopLoss: value.require_stop_loss,
  editableFields: value.editable_fields,
  revision: value.revision,
  updatedAt: value.updated_at,
}))

export const riskPolicyPatchBodySchema = z.object({
  max_risk_per_trade_percent: riskPolicyDecimalSchema.optional(),
  max_daily_loss_percent: riskPolicyDecimalSchema.optional(),
  max_drawdown_percent: riskPolicyDecimalSchema.optional(),
  max_open_positions: riskPolicyEditableInteger(0, 1000).optional(),
  max_pending_orders: riskPolicyEditableInteger(0, 1000).optional(),
  max_total_volume: riskPolicyDecimalSchema.optional(),
  max_spread_points: riskPolicyDecimalSchema.optional(),
  min_open_interval_seconds: riskPolicyEditableInteger(0, 86400).optional(),
  max_daily_open_count: riskPolicyEditableInteger(0, 10000).optional(),
  consecutive_loss_limit: riskPolicyEditableInteger(0, 1000).optional(),
  loss_cooldown_minutes: riskPolicyEditableInteger(0, 10080).optional(),
  pending_valid_minutes: riskPolicyEditableInteger(1, 10080).optional(),
  weekend_close_minutes: riskPolicyEditableInteger(0, 2880).optional(),
  trade_send_enabled: z.boolean().optional(),
  account_kill_switch: z.boolean().optional(),
  reason: z.string().trim().min(3).max(500),
}).strict()

// Alias retained for feature code that groups these contracts under AI Risk.
export const aiRiskPolicyPatchBodySchema = riskPolicyPatchBodySchema

export const riskPolicyResponseSchema = z.object({ data: riskPolicySchema, meta: responseMetaSchema }).strict()

export const riskSummarySchema = z.object({
  account_id: z.string().min(1),
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  equity: riskPolicyDecimalSchema,
  free_margin: riskPolicyDecimalSchema,
  margin_level_percent: riskPolicyDecimalSchema.nullable(),
  daily_loss_percent: riskPolicyDecimalSchema,
  drawdown_percent: riskPolicyDecimalSchema,
  open_positions: riskPolicyEditableInteger(0),
  pending_orders: riskPolicyEditableInteger(0),
  total_volume: riskPolicyDecimalSchema,
  daily_open_count: riskPolicyEditableInteger(0),
  consecutive_losses: riskPolicyEditableInteger(0),
  terminal_timezone_offset_minutes: z.number().int().min(-840).max(840).nullable(),
  clock_status: z.enum(['calibrated', 'observer_bootstrap', 'stale', 'unavailable']),
  last_successful_open_at: z.iso.datetime({ offset: true }).nullable(),
  cooldown_until: z.iso.datetime({ offset: true }).nullable(),
  data_complete: z.boolean(),
  incomplete_reasons: z.array(z.string().trim().max(128)).refine((values) => new Set(values).size === values.length),
  observed_at: z.iso.datetime({ offset: true }),
  revision: numericRevisionSchema,
}).strict().transform((value) => ({
  accountId: value.account_id,
  businessDate: value.business_date,
  equity: value.equity,
  freeMargin: value.free_margin,
  marginLevelPercent: value.margin_level_percent,
  dailyLossPercent: value.daily_loss_percent,
  drawdownPercent: value.drawdown_percent,
  openPositions: value.open_positions,
  pendingOrders: value.pending_orders,
  totalVolume: value.total_volume,
  dailyOpenCount: value.daily_open_count,
  consecutiveLosses: value.consecutive_losses,
  terminalTimezoneOffsetMinutes: value.terminal_timezone_offset_minutes,
  clockStatus: value.clock_status,
  lastSuccessfulOpenAt: value.last_successful_open_at,
  cooldownUntil: value.cooldown_until,
  dataComplete: value.data_complete,
  incompleteReasons: value.incomplete_reasons,
  observedAt: value.observed_at,
  revision: value.revision,
}))

export const riskSummaryResponseSchema = z.object({ data: riskSummarySchema, meta: responseMetaSchema }).strict()
export const accountRiskSummarySchema = riskSummarySchema
export const accountRiskSummaryResponseSchema = riskSummaryResponseSchema

export const manualReleaseRuleSchema = z.enum([
  'RISK_DAILY_LOSS_LIMIT', 'RISK_DRAWDOWN_LIMIT', 'RISK_DAILY_OPEN_LIMIT',
  'RISK_CONSECUTIVE_LOSS_LIMIT', 'RISK_COOLDOWN_ACTIVE',
])

export const manualRiskReleaseBaselineSchema = z.object({
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  daily_loss_percent: riskPolicyDecimalSchema,
  drawdown_percent: riskPolicyDecimalSchema,
  daily_open_count: riskPolicyEditableInteger(0),
  consecutive_losses: riskPolicyEditableInteger(0),
  cooldown_until: z.iso.datetime({ offset: true }).nullable(),
}).strict().transform((value) => ({
  businessDate: value.business_date,
  dailyLossPercent: value.daily_loss_percent,
  drawdownPercent: value.drawdown_percent,
  dailyOpenCount: value.daily_open_count,
  consecutiveLosses: value.consecutive_losses,
  cooldownUntil: value.cooldown_until,
}))

export const manualRiskReleaseSchema = z.object({
  manual_release_id: z.string().min(1),
  account_id: z.string().min(1),
  platform_policy_version_id: z.string().min(1),
  account_policy_version_id: z.string().min(1).nullable(),
  policy_set_revision: numericRevisionSchema,
  status: z.enum(['active', 'superseded', 'expired', 'revoked']),
  released_rules: z.array(manualReleaseRuleSchema).min(1).refine((values) => new Set(values).size === values.length),
  baseline: manualRiskReleaseBaselineSchema,
  risk_state_revision: numericRevisionSchema,
  reason: z.string().trim().min(3).max(500),
  expires_at: z.iso.datetime({ offset: true }),
  created_at: z.iso.datetime({ offset: true }),
  invalidated_at: z.iso.datetime({ offset: true }).nullable(),
  invalidation_reason: z.string().max(128).nullable(),
  revision: numericRevisionSchema,
}).strict().transform((value) => ({
  id: value.manual_release_id,
  accountId: value.account_id,
  platformPolicyVersionId: value.platform_policy_version_id,
  accountPolicyVersionId: value.account_policy_version_id,
  policySetRevision: value.policy_set_revision,
  status: value.status,
  releasedRules: value.released_rules,
  baseline: value.baseline,
  riskStateRevision: value.risk_state_revision,
  reason: value.reason,
  expiresAt: value.expires_at,
  createdAt: value.created_at,
  invalidatedAt: value.invalidated_at,
  invalidationReason: value.invalidation_reason,
  revision: value.revision,
}))

export const manualReleaseAvailabilitySchema = z.object({
  available: z.boolean(),
  code: z.string().trim().min(1).nullable(),
  rules: z.array(manualReleaseRuleSchema).refine((values) => new Set(values).size === values.length),
  expires_at: z.iso.datetime({ offset: true }).nullable(),
  policy_set_revision: numericRevisionSchema,
  risk_state_revision: numericRevisionSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.available && (value.code !== null || value.rules.length === 0 || value.expires_at === null || value.risk_state_revision === null)) {
    context.addIssue({ code: 'custom', message: '可解除状态必须包含规则、有效期和风险版本且不能包含拒绝代码', path: ['available'] })
  }
  if (!value.available && (value.code === null || value.rules.length > 0 || value.expires_at !== null)) {
    context.addIssue({ code: 'custom', message: '不可解除状态必须包含拒绝代码且不能包含可解除规则或有效期', path: ['code'] })
  }
}).transform((value) => ({
  available: value.available,
  code: value.code,
  rules: value.rules,
  expiresAt: value.expires_at,
  policySetRevision: value.policy_set_revision,
  riskStateRevision: value.risk_state_revision,
}))

export const manualReleaseStateSchema = z.object({
  release: manualRiskReleaseSchema.nullable(),
  availability: manualReleaseAvailabilitySchema,
}).strict()
export const manualRiskReleaseResponseSchema = z.object({ data: manualReleaseStateSchema, meta: responseMetaSchema }).strict()
export const manualRiskReleaseCreatedResponseSchema = z.object({ data: manualRiskReleaseSchema, meta: responseMetaSchema }).strict()
export const riskManualReleaseBodySchema = z.object({ acknowledge_risk: z.literal(true), reason: z.string().trim().min(3).max(500) }).strict()
export const aiRiskManualReleaseBodySchema = riskManualReleaseBodySchema

export const riskDecisionSummarySchema = z.object({
  risk_decision_id: z.string().min(1),
  trade_decision_id: z.string().min(1),
  account_id: z.string().min(1),
  status: z.enum(['approved', 'rejected']),
  reject_code: z.string().max(128).nullable(),
  platform_policy_version_id: z.string().min(1),
  account_policy_version_id: z.string().min(1).nullable(),
  account_risk_revision: numericRevisionSchema,
  manual_release_id: z.string().min(1).nullable(),
  created_at: z.iso.datetime({ offset: true }),
  revision: numericRevisionSchema,
}).strict().transform((value) => ({
  riskDecisionId: value.risk_decision_id,
  tradeDecisionId: value.trade_decision_id,
  accountId: value.account_id,
  status: value.status,
  rejectCode: value.reject_code,
  platformPolicyVersionId: value.platform_policy_version_id,
  accountPolicyVersionId: value.account_policy_version_id,
  accountRiskRevision: value.account_risk_revision,
  manualReleaseId: value.manual_release_id,
  createdAt: value.created_at,
  revision: value.revision,
}))

const riskDecisionRuleSchema = z.object({
  code: z.string().max(128),
  outcome: z.enum(['passed', 'rejected', 'not_applicable']),
  action_id: z.string().min(1).nullable(),
  details: z.record(z.string(), z.unknown()),
}).strict().transform((value) => ({ code: value.code, outcome: value.outcome, actionId: value.action_id, details: value.details }))

const riskApprovedActionSchema = z.object({
  action_id: z.string().min(1),
  kind: traderExecutableActionSchema,
  parameters: z.record(z.string(), z.unknown()),
  expected_state: z.record(z.string(), z.unknown()),
}).strict().transform((value) => ({ actionId: value.action_id, kind: value.kind, parameters: value.parameters, expectedState: value.expected_state }))

export const riskDecisionDetailSchema = z.object({
  summary: riskDecisionSummarySchema,
  rules: z.array(riskDecisionRuleSchema),
  approved_actions: z.array(riskApprovedActionSchema),
  evaluated_at: z.iso.datetime({ offset: true }),
  policy_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().transform((value) => ({
  summary: value.summary,
  rules: value.rules,
  approvedActions: value.approved_actions,
  evaluatedAt: value.evaluated_at,
  policyHash: value.policy_hash,
}))

export const riskDecisionListResponseSchema = z.object({
  data: z.object({ items: z.array(riskDecisionSummarySchema) }).strict(),
  meta: responseMetaSchema,
}).strict()
export const riskDecisionDetailResponseSchema = z.object({ data: riskDecisionDetailSchema, meta: responseMetaSchema }).strict()

/**
 * The browser execution boundary is intentionally narrower than the Bridge
 * command envelope.  The browser supplies a complete optimistic revision
 * vector; the server resolves it to the exact terminal state before creating
 * an execution intent.
 */
export const executionRevisionSchema = z.string().min(1).max(128).regex(/^\d+$/)
const executionSymbolSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/)
const executionTicketSchema = z.string().trim().min(1).max(64).regex(/^[0-9A-Za-z._:-]+$/)
const executionPositiveDecimalSchema = decimalSchema
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
  .refine((value) => Number(value) > 0, '交易价格和数量必须大于 0')
const executionUtcMscSchema = z.number().int().positive().safe()
const executionOrderTypeSchema = z.enum(['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'])
const executionSideSchema = z.enum(['buy', 'sell'])
export const executionExpectedStateSchema = z.object({
  account_revision: executionRevisionSchema,
  positions_revision: executionRevisionSchema,
  pending_orders_revision: executionRevisionSchema,
  quote_revision: executionRevisionSchema,
  contract_revision: executionRevisionSchema,
  risk_revision: executionRevisionSchema,
}).strict()

export const executionCommandContextSchema = z.object({
  account_id: z.string().min(1),
  symbol: executionSymbolSchema,
  ticket: executionTicketSchema.nullable(),
  read_only: z.boolean(),
  trade_permission: z.boolean(),
  expected_state: executionExpectedStateSchema,
  target_revision: executionRevisionSchema.regex(/^[1-9][0-9]*$/).nullable(),
  quote: z.object({
    bid: executionPositiveDecimalSchema,
    ask: executionPositiveDecimalSchema,
    observed_at: z.iso.datetime({ offset: true }),
  }).nullable(),
  instrument: z.object({
    point: executionPositiveDecimalSchema,
    tick_size: executionPositiveDecimalSchema,
    tick_value: executionPositiveDecimalSchema,
    volume_min: executionPositiveDecimalSchema,
    volume_max: executionPositiveDecimalSchema,
    volume_step: executionPositiveDecimalSchema,
    trade_enabled: z.boolean(),
  }).nullable(),
}).strict().transform((value) => ({
  accountId: value.account_id,
  symbol: value.symbol,
  ticket: value.ticket,
  readOnly: value.read_only,
  tradePermission: value.trade_permission,
  expectedState: value.expected_state,
  targetRevision: value.target_revision,
  quote: value.quote ? { bid: value.quote.bid, ask: value.quote.ask, observedAt: value.quote.observed_at } : null,
  instrument: value.instrument ? {
    point: value.instrument.point,
    tickSize: value.instrument.tick_size,
    tickValue: value.instrument.tick_value,
    volumeMin: value.instrument.volume_min,
    volumeMax: value.instrument.volume_max,
    volumeStep: value.instrument.volume_step,
    tradeEnabled: value.instrument.trade_enabled,
  } : null,
}))
export const executionCommandContextResponseSchema = z.object({ data: executionCommandContextSchema, meta: responseMetaSchema })
export const executionEntryExpectedStateSchema = executionExpectedStateSchema
export const executionResourceExpectedStateSchema = executionExpectedStateSchema.extend({
  resource_revision: executionRevisionSchema.regex(/^[1-9][0-9]*$/),
}).strict()

const executionEntryExpectedCommandFields = {
  expected_state: executionEntryExpectedStateSchema,
} as const
const executionResourceExpectedCommandFields = {
  expected_state: executionResourceExpectedStateSchema,
} as const

export const marketOrderCommandSchema = z.object({
  command_type: z.literal('market_order'),
  side: executionSideSchema,
  symbol: executionSymbolSchema,
  volume: executionPositiveDecimalSchema,
  stop_loss: executionPositiveDecimalSchema,
  reference_price: executionPositiveDecimalSchema,
  take_profit: executionPositiveDecimalSchema.optional(),
  ...executionEntryExpectedCommandFields,
}).strict()

export const pendingOrderCommandSchema = z.object({
  command_type: z.literal('pending_order'),
  order_type: executionOrderTypeSchema,
  symbol: executionSymbolSchema,
  volume: executionPositiveDecimalSchema,
  stop_loss: executionPositiveDecimalSchema,
  reference_price: executionPositiveDecimalSchema,
  price: executionPositiveDecimalSchema,
  stop_limit_price: executionPositiveDecimalSchema.optional(),
  take_profit: executionPositiveDecimalSchema.optional(),
  expiration_utc_msc: executionUtcMscSchema.optional(),
  ...executionEntryExpectedCommandFields,
}).strict()

const positionProtectionChanges = {
  stop_loss: executionPositiveDecimalSchema.optional(),
  remove_stop_loss: z.literal(true).optional(),
  take_profit: executionPositiveDecimalSchema.optional(),
  remove_take_profit: z.literal(true).optional(),
} as const

export const modifyPositionCommandSchema = z.object({
  command_type: z.literal('modify_position'),
  ticket: executionTicketSchema,
  ...positionProtectionChanges,
  ...executionResourceExpectedCommandFields,
}).strict().superRefine((value, context) => {
  const changes = ['stop_loss', 'remove_stop_loss', 'take_profit', 'remove_take_profit'] as const
  if (!changes.some((key) => value[key] !== undefined)) {
    context.addIssue({ code: 'custom', message: '至少指定一项止损或止盈变更', path: ['command_type'] })
  }
  if (value.stop_loss !== undefined && value.remove_stop_loss !== undefined) {
    context.addIssue({ code: 'custom', message: '止损值与 remove_stop_loss 不能同时提供', path: ['stop_loss'] })
  }
  if (value.take_profit !== undefined && value.remove_take_profit !== undefined) {
    context.addIssue({ code: 'custom', message: '止盈值与 remove_take_profit 不能同时提供', path: ['take_profit'] })
  }
})

export const closePositionCommandSchema = z.object({
  command_type: z.literal('close_position'),
  ticket: executionTicketSchema,
  volume: executionPositiveDecimalSchema.optional(),
  ...executionResourceExpectedCommandFields,
}).strict()

const pendingOrderChanges = {
  price: executionPositiveDecimalSchema.optional(),
  stop_limit_price: executionPositiveDecimalSchema.optional(),
  stop_loss: executionPositiveDecimalSchema.optional(),
  remove_stop_loss: z.literal(true).optional(),
  take_profit: executionPositiveDecimalSchema.optional(),
  remove_take_profit: z.literal(true).optional(),
  expiration_utc_msc: executionUtcMscSchema.optional(),
  remove_expiration: z.literal(true).optional(),
} as const

export const modifyOrderCommandSchema = z.object({
  command_type: z.literal('modify_order'),
  ticket: executionTicketSchema,
  ...pendingOrderChanges,
  ...executionResourceExpectedCommandFields,
}).strict().superRefine((value, context) => {
  const changes = ['price', 'stop_limit_price', 'stop_loss', 'remove_stop_loss', 'take_profit', 'remove_take_profit', 'expiration_utc_msc', 'remove_expiration'] as const
  if (!changes.some((key) => value[key] !== undefined)) {
    context.addIssue({ code: 'custom', message: '至少指定一项挂单变更', path: ['command_type'] })
  }
  if (value.stop_loss !== undefined && value.remove_stop_loss !== undefined) {
    context.addIssue({ code: 'custom', message: '止损值与 remove_stop_loss 不能同时提供', path: ['stop_loss'] })
  }
  if (value.take_profit !== undefined && value.remove_take_profit !== undefined) {
    context.addIssue({ code: 'custom', message: '止盈值与 remove_take_profit 不能同时提供', path: ['take_profit'] })
  }
  if (value.expiration_utc_msc !== undefined && value.remove_expiration !== undefined) {
    context.addIssue({ code: 'custom', message: '到期时间与 remove_expiration 不能同时提供', path: ['expiration_utc_msc'] })
  }
})

export const cancelOrderCommandSchema = z.object({
  command_type: z.literal('cancel_order'),
  ticket: executionTicketSchema,
  ...executionResourceExpectedCommandFields,
}).strict()

export const executionCommandSchema = z.discriminatedUnion('command_type', [
  marketOrderCommandSchema,
  pendingOrderCommandSchema,
  modifyPositionCommandSchema,
  closePositionCommandSchema,
  modifyOrderCommandSchema,
  cancelOrderCommandSchema,
])

const distributionMarketOrderCommandSchema = marketOrderCommandSchema.omit({ expected_state: true })
const distributionPendingOrderCommandSchema = pendingOrderCommandSchema.omit({ expected_state: true })
export const executionDistributionCommandSchema = z.discriminatedUnion('command_type', [
  distributionMarketOrderCommandSchema,
  distributionPendingOrderCommandSchema,
])

export const executionDistributionSchema = z.object({
  strategy_id: z.string().min(1).max(191),
  command: executionDistributionCommandSchema,
}).strict()

export const operationStatusSchema = z.enum(['accepted', 'queued', 'running', 'succeeded', 'partially_succeeded', 'rejected', 'failed', 'uncertain', 'cancelled', 'expired'])

export const distributionCloseCommandSchema = z.object({
  expected_revision: executionRevisionSchema,
  target_ids: z.array(z.string().min(1).max(191)).max(10000).refine((values) => new Set(values).size === values.length, 'target_ids 不能重复'),
}).strict()

export const executionDistributionPreviewSchema = z.object({
  strategy_id: z.string().min(1),
  strategy_version_id: z.string().min(1),
  strategy_revision: executionRevisionSchema,
  symbol: executionSymbolSchema,
  target_count: z.number().int().nonnegative(),
  targets: z.array(z.object({
    account_id: z.string().min(1),
    subscription_id: z.string().min(1),
    trade_permission: z.boolean(),
    ready: z.boolean(),
    missing_resources: z.array(z.enum(['account', 'positions', 'pending_orders', 'quote', 'contract', 'risk'])),
  }).strict()),
}).strict().transform((value) => ({
  strategyId: value.strategy_id,
  strategyVersionId: value.strategy_version_id,
  strategyRevision: value.strategy_revision,
  symbol: value.symbol,
  targetCount: value.target_count,
  targets: value.targets.map((target) => ({
    accountId: target.account_id,
    subscriptionId: target.subscription_id,
    tradePermission: target.trade_permission,
    ready: target.ready,
    missingResources: target.missing_resources,
  })),
}))
export const executionDistributionPreviewResponseSchema = z.object({ data: executionDistributionPreviewSchema, meta: responseMetaSchema })

const executionDistributionTargetSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  subscription_id: z.string().min(1),
  child_operation_id: z.string().min(1).nullable(),
  source_ticket: z.string().min(1).nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'rejected', 'failed', 'uncertain', 'cancelled', 'expired']),
  error_code: z.string().nullable(),
  revision: executionRevisionSchema,
}).strict().transform((value) => ({
  id: value.id,
  accountId: value.account_id,
  subscriptionId: value.subscription_id,
  childOperationId: value.child_operation_id,
  sourceTicket: value.source_ticket,
  status: value.status,
  errorCode: value.error_code,
  revision: value.revision,
}))

const executionDistributionDetailSchema = z.object({
  id: z.string().min(1),
  operation_id: z.string().min(1),
  strategy_id: z.string().min(1),
  strategy_version_id: z.string().min(1),
  kind: z.enum(['manual_order', 'close']),
  source_distribution_id: z.string().min(1).nullable(),
  command: z.record(z.string(), z.unknown()),
  status: operationStatusSchema,
  target_count: z.number().int().nonnegative(),
  result_summary: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  completed_at: z.iso.datetime({ offset: true }).nullable(),
  revision: executionRevisionSchema,
  targets: z.array(executionDistributionTargetSchema),
}).strict().transform((value) => ({
  id: value.id,
  operationId: value.operation_id,
  strategyId: value.strategy_id,
  strategyVersionId: value.strategy_version_id,
  kind: value.kind,
  sourceDistributionId: value.source_distribution_id,
  command: value.command,
  status: value.status,
  targetCount: value.target_count,
  resultSummary: value.result_summary,
  createdAt: value.created_at,
  updatedAt: value.updated_at,
  completedAt: value.completed_at,
  revision: value.revision,
  targets: value.targets,
}))
export const executionDistributionDetailResponseSchema = z.object({ data: executionDistributionDetailSchema, meta: responseMetaSchema })

export const operationSchema = z.object({
  operation_id: z.string().min(1),
  kind: z.string().min(1).max(128),
  status: operationStatusSchema,
  accepted_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  completed_at: z.iso.datetime({ offset: true }).nullable().optional(),
  resource_id: z.string().min(1).nullable().optional(),
  error_code: z.string().max(128).nullable().optional(),
  revision: executionRevisionSchema,
  parent_operation_id: z.string().min(1).nullable().optional(),
  distribution_id: z.string().min(1).nullable().optional(),
  result_summary: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict().transform((value) => ({
  operationId: value.operation_id,
  kind: value.kind,
  status: value.status,
  acceptedAt: value.accepted_at,
  updatedAt: value.updated_at,
  completedAt: value.completed_at ?? null,
  resourceId: value.resource_id ?? null,
  errorCode: value.error_code ?? null,
  revision: value.revision,
  parentOperationId: value.parent_operation_id ?? null,
  distributionId: value.distribution_id ?? null,
  resultSummary: value.result_summary ?? null,
}))
export const operationResponseSchema = z.object({ data: operationSchema, meta: responseMetaSchema })

export const tradingRealtimeEventSchema = z.object({
  v: z.literal(4), event_id: z.string(),
  type: z.enum(['runtime.bridge.changed', 'account.metrics.changed', 'market.quote.updated', 'market.candle.updated', 'market.candle.closed', 'positions.changed', 'pending_orders.changed']),
  occurred_at: z.iso.datetime({ offset: true }), sequence: z.number().int().positive(),
  scope: z.object({ user_id: z.string(), trading_account_id: z.string(), terminal_instance_id: z.string().nullable(), observer_channel_id: z.string().nullable() }),
  resource: z.object({ kind: z.string(), id: z.string() }), revision: z.string(), data: z.unknown(), correlation_id: z.string().nullable(),
})

export const inferenceRealtimeEventSchema = z.object({
  v: z.literal(4), event_id: z.string(),
  type: z.enum(['analysis.job.changed', 'market_analysis.created', 'trader.job.changed', 'trade_decision.created']),
  occurred_at: z.iso.datetime({ offset: true }), sequence: z.number().int().positive(),
  scope: z.object({ user_id: z.string(), trading_account_id: z.string().nullable(), terminal_instance_id: z.string().nullable(), observer_channel_id: z.string().nullable() }),
  resource: z.object({ kind: z.string(), id: z.string() }), revision: z.string(), data: z.unknown(), correlation_id: z.string().nullable(),
})

export const riskRealtimeEventSchema = z.object({
  v: z.literal(4), event_id: z.string(),
  type: z.enum(['risk.policy.changed', 'risk.summary.changed', 'risk.decision.created', 'risk.manual_release.changed']),
  occurred_at: z.iso.datetime({ offset: true }), sequence: z.number().int().positive(),
  scope: z.object({ user_id: z.string(), trading_account_id: z.string(), terminal_instance_id: z.string().nullable(), observer_channel_id: z.string().nullable() }),
  resource: z.object({ kind: z.string(), id: z.string() }), revision: z.string(), data: z.unknown(), correlation_id: z.string().nullable(),
})

export const operationRealtimeEventSchema = z.object({
  v: z.literal(4), event_id: z.string(), type: z.literal('operation.changed'),
  occurred_at: z.iso.datetime({ offset: true }), sequence: z.number().int().positive(),
  scope: z.object({ user_id: z.string(), trading_account_id: z.string().nullable(), terminal_instance_id: z.string().nullable(), observer_channel_id: z.string().nullable() }),
  resource: z.object({ kind: z.literal('operation'), id: z.string() }), revision: z.string(), data: z.unknown(), correlation_id: z.string().nullable(),
})

export const browserRealtimeEventSchema = z.union([
  tradingRealtimeEventSchema, inferenceRealtimeEventSchema, riskRealtimeEventSchema, operationRealtimeEventSchema,
])

export type ApiProblem = z.infer<typeof apiProblemSchema>
export type AppSurface = z.infer<typeof appSurfaceSchema>
export type AuthLoginRequest = z.infer<typeof authLoginRequestSchema>
export type AuthLoginResponse = z.infer<typeof authLoginResponseSchema>
export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>
export type SessionResponse = z.infer<typeof sessionResponseSchema>
export type SessionSummary = z.infer<typeof sessionSummarySchema>
export type TradingContext = z.infer<typeof tradingContextSchema>
export type ObserverChannel = z.infer<typeof observerChannelSchema>
export type TradingAccount = z.infer<typeof tradingAccountSchema>
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>
export type MarketQuote = z.infer<typeof marketQuoteSchema>
export type MarketCandle = z.infer<typeof marketCandleSchema>
export type OpenPosition = z.infer<typeof openPositionSchema>
export type PendingOrder = z.infer<typeof pendingOrderSchema>
export type Timeframe = z.infer<typeof timeframeSchema>
export type TradingRealtimeEvent = z.infer<typeof tradingRealtimeEventSchema>
export type StrategyKind = z.infer<typeof strategyKindSchema>
export type StrategySummary = z.infer<typeof strategySummarySchema>
export type AnalysisJobCreate = z.infer<typeof analysisJobCreateSchema>
export type AnalysisJob = z.infer<typeof analysisJobSchema>
export type MarketAnalysisSummary = z.infer<typeof marketAnalysisSummarySchema>
export type MarketAnalysisDetail = z.infer<typeof marketAnalysisDetailSchema>
export type TraderTaskMode = z.infer<typeof traderTaskModeSchema>
export type TraderRun = z.infer<typeof traderRunSchema>
export type TraderDecisionSummary = z.infer<typeof traderDecisionSummarySchema>
export type TraderDecisionDetail = z.infer<typeof traderDecisionDetailSchema>
export type RiskPolicy = z.infer<typeof riskPolicySchema>
export type RiskPolicyPatchBody = z.infer<typeof riskPolicyPatchBodySchema>
export type RiskSummary = z.infer<typeof riskSummarySchema>
export type AccountRiskSummary = RiskSummary
export type ManualReleaseRule = z.infer<typeof manualReleaseRuleSchema>
export type ManualRiskReleaseBaseline = z.infer<typeof manualRiskReleaseBaselineSchema>
export type ManualRiskRelease = z.infer<typeof manualRiskReleaseSchema>
export type ManualReleaseAvailability = z.infer<typeof manualReleaseAvailabilitySchema>
export type ManualReleaseState = z.infer<typeof manualReleaseStateSchema>
export type RiskManualReleaseBody = z.infer<typeof riskManualReleaseBodySchema>
export type RiskDecisionSummary = z.infer<typeof riskDecisionSummarySchema>
export type RiskDecisionDetail = z.infer<typeof riskDecisionDetailSchema>
export type ExecutionRevision = z.infer<typeof executionRevisionSchema>
export type ExecutionExpectedState = z.infer<typeof executionExpectedStateSchema>
export type ExecutionCommandContext = z.infer<typeof executionCommandContextSchema>
export type ExecutionEntryExpectedState = z.infer<typeof executionEntryExpectedStateSchema>
export type ExecutionResourceExpectedState = z.infer<typeof executionResourceExpectedStateSchema>
export type MarketOrderCommand = z.infer<typeof marketOrderCommandSchema>
export type PendingOrderCommand = z.infer<typeof pendingOrderCommandSchema>
export type ModifyPositionCommand = z.infer<typeof modifyPositionCommandSchema>
export type ClosePositionCommand = z.infer<typeof closePositionCommandSchema>
export type ModifyOrderCommand = z.infer<typeof modifyOrderCommandSchema>
export type CancelOrderCommand = z.infer<typeof cancelOrderCommandSchema>
export type ExecutionCommand = z.infer<typeof executionCommandSchema>
export type ExecutionDistributionCommand = z.infer<typeof executionDistributionCommandSchema>
export type ExecutionDistribution = z.infer<typeof executionDistributionSchema>
export type DistributionCloseCommand = z.infer<typeof distributionCloseCommandSchema>
export type ExecutionDistributionPreview = z.infer<typeof executionDistributionPreviewSchema>
export type ExecutionDistributionDetail = z.infer<typeof executionDistributionDetailSchema>
export type Operation = z.infer<typeof operationSchema>
export type InferenceRealtimeEvent = z.infer<typeof inferenceRealtimeEventSchema>
export type RiskRealtimeEvent = z.infer<typeof riskRealtimeEventSchema>
export type OperationRealtimeEvent = z.infer<typeof operationRealtimeEventSchema>
export type BrowserRealtimeEvent = z.infer<typeof browserRealtimeEventSchema>
