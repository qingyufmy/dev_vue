import { z } from 'zod'
export { bridgePairingRequestSchema, bridgePairingResponseSchema } from './bridge-pairing'

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
  currency: z.string().min(3), terminal_profile_id: z.string().min(1).nullable(), terminal_instance_id: z.string().min(1).nullable(),
  bridge_state: bridgeStateSchema, trade_permission: z.boolean(), last_seen_at: z.iso.datetime({ offset: true }).nullable(),
}).transform((value) => ({ id: value.id, platform: value.platform, login: value.login, server: value.server, currency: value.currency,
  terminalProfileId: value.terminal_profile_id, terminalInstanceId: value.terminal_instance_id, bridgeState: value.bridge_state,
  tradePermission: value.trade_permission, lastSeenAt: value.last_seen_at }))

export const accountSnapshotSchema = z.object({
  id: z.string().min(1), platform: tradingPlatformSchema, login: z.string().min(1), server: z.string().min(1), currency: z.string().min(3),
  terminal_profile_id: z.string().min(1).nullable(), terminal_instance_id: z.string().min(1).nullable(), bridge_state: bridgeStateSchema,
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

const macroUtcDatetimeSchema = z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z'), '宏观数据时间必须使用 UTC Z')
const macroBusinessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const macroSnapshotStatusSchema = z.enum(['fresh', 'stale', 'partial', 'unavailable'])
export const macroDirectionSchema = z.enum(['supportive', 'adverse', 'neutral', 'uncertain'])
export const macroFreshnessSchema = z.enum(['fresh', 'stale', 'missing', 'disabled', 'invalid'])
export const macroGoldRelationSchema = z.enum(['supportive', 'adverse', 'neutral', 'uncertain'])

export const macroFactorSchema = z.object({
  code: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(191),
  value: decimalSchema.nullable(),
  unit: z.string().trim().min(1).max(64).nullable(),
  observation_at: macroUtcDatetimeSchema,
  available_at: macroUtcDatetimeSchema,
  freshness: macroFreshnessSchema,
  gold_relation: macroGoldRelationSchema,
}).strict().transform((value) => ({
  code: value.code, label: value.label, value: value.value, unit: value.unit,
  observationAt: value.observation_at, availableAt: value.available_at,
  freshness: value.freshness, goldRelation: value.gold_relation,
}))

const macroSnapshotFields = {
  id: z.string().trim().min(1).max(191),
  schema_version: z.number().int().positive(),
  revision: numericRevisionSchema,
  business_date: macroBusinessDateSchema,
  horizon: z.literal('medium_term'),
  data_cutoff_at: macroUtcDatetimeSchema,
  published_at: macroUtcDatetimeSchema,
  valid_until: macroUtcDatetimeSchema,
  status: macroSnapshotStatusSchema,
  direction: macroDirectionSchema,
  summary: z.string().trim().min(1).max(5000),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
} as const

export const macroSnapshotSchema = z.object({
  ...macroSnapshotFields,
  factors: z.array(macroFactorSchema).max(128),
}).strict().transform((value) => ({
  id: value.id, schemaVersion: value.schema_version, revision: value.revision,
  businessDate: value.business_date, horizon: value.horizon, dataCutoffAt: value.data_cutoff_at,
  publishedAt: value.published_at, validUntil: value.valid_until, status: value.status,
  direction: value.direction, summary: value.summary, factors: value.factors,
  contentSha256: value.content_sha256,
}))
export const macroSnapshotDetailSchema = macroSnapshotSchema
export const macroSnapshotSummarySchema = z.object({
  ...macroSnapshotFields,
  factor_count: z.number().int().nonnegative().max(128),
}).strict().transform((value) => ({
  id: value.id, schemaVersion: value.schema_version, revision: value.revision,
  businessDate: value.business_date, horizon: value.horizon, dataCutoffAt: value.data_cutoff_at,
  publishedAt: value.published_at, validUntil: value.valid_until, status: value.status,
  direction: value.direction, summary: value.summary, factorCount: value.factor_count,
  contentSha256: value.content_sha256,
}))
export const macroSnapshotResponseSchema = z.object({ data: macroSnapshotSchema, meta: responseMetaSchema }).strict()
export const macroSnapshotDetailResponseSchema = z.object({ data: macroSnapshotDetailSchema, meta: responseMetaSchema }).strict()
export const macroSnapshotsResponseSchema = z.object({ data: z.object({
  items: z.array(macroSnapshotSummarySchema), next_cursor: z.string().min(1).nullable(), has_more: z.boolean(),
}).strict(), meta: responseMetaSchema }).strict()
export const macroSnapshotListResponseSchema = macroSnapshotsResponseSchema

export const macroSeriesPointSchema = z.object({
  code: z.string().trim().min(1).max(64),
  observation_at: macroUtcDatetimeSchema,
  available_at: macroUtcDatetimeSchema,
  value: decimalSchema.nullable(),
  unit: z.string().trim().min(1).max(64).nullable(),
  freshness: macroFreshnessSchema,
}).strict().transform((value) => ({
  code: value.code, observationAt: value.observation_at, availableAt: value.available_at,
  value: value.value, unit: value.unit, freshness: value.freshness,
}))
export const macroSeriesResponseSchema = z.object({ data: z.object({
  items: z.array(macroSeriesPointSchema), next_cursor: z.string().min(1).nullable(), has_more: z.boolean(),
}).strict(), meta: responseMetaSchema }).strict()

export const economicCalendarTimePrecisionSchema = z.enum(['exact', 'date_only', 'tentative'])
export const economicCalendarImportanceSchema = z.enum(['low', 'medium', 'high', 'unknown'])
export const economicCalendarStatusSchema = z.enum(['scheduled', 'released', 'revised', 'delayed', 'cancelled'])
export const economicCalendarEventSchema = z.object({
  id: z.string().trim().min(1).max(191),
  provider_event_id: z.string().trim().min(1).max(191).nullable(),
  country: z.string().trim().min(1).max(64),
  currency: z.string().trim().min(1).max(16).nullable(),
  title: z.string().trim().min(1).max(300),
  scheduled_at: macroUtcDatetimeSchema,
  time_precision: economicCalendarTimePrecisionSchema,
  importance: economicCalendarImportanceSchema,
  period: z.string().trim().min(1).max(128).nullable(),
  unit: z.string().trim().min(1).max(64).nullable(),
  previous: decimalSchema.nullable(),
  consensus: decimalSchema.nullable(),
  actual: decimalSchema.nullable(),
  revised_previous: decimalSchema.nullable(),
  status: economicCalendarStatusSchema,
  provider_updated_at: macroUtcDatetimeSchema.nullable(),
  revision: numericRevisionSchema,
}).strict().transform((value) => ({
  id: value.id, providerEventId: value.provider_event_id, country: value.country, currency: value.currency,
  title: value.title, scheduledAt: value.scheduled_at, timePrecision: value.time_precision,
  importance: value.importance, period: value.period, unit: value.unit, previous: value.previous,
  consensus: value.consensus, actual: value.actual, revisedPrevious: value.revised_previous,
  status: value.status, providerUpdatedAt: value.provider_updated_at, revision: value.revision,
}))
export const calendarEventSchema = economicCalendarEventSchema
export const economicCalendarEventsResponseSchema = z.object({ data: z.object({
  items: z.array(economicCalendarEventSchema), next_cursor: z.string().min(1).nullable(), has_more: z.boolean(),
}).strict(), meta: responseMetaSchema }).strict()
export const calendarEventsResponseSchema = economicCalendarEventsResponseSchema
export const economicCalendarEventResponseSchema = z.object({ data: economicCalendarEventSchema, meta: responseMetaSchema }).strict()
export const calendarEventResponseSchema = economicCalendarEventResponseSchema
export const macroMarketOverviewResponseSchema = z.object({ data: z.object({
  snapshot: macroSnapshotSummarySchema.nullable(),
  high_impact_events: z.array(economicCalendarEventSchema).max(20),
}).strict(), meta: responseMetaSchema }).strict()
export const macroOverviewResponseSchema = macroMarketOverviewResponseSchema

export const tradeHistorySideSchema = z.enum(['buy', 'sell'])
export const tradeHistorySourceSchema = z.enum(['system', 'manual', 'other_ea', 'mixed', 'unknown'])
export const tradeHistoryRecordSchema = z.object({
  account_currency: z.string().min(1).max(16).nullable(), currency_evidence: z.enum(['unknown', 'explicit_record']),
  id: z.string().min(1), account_id: z.string().min(1), platform: tradingPlatformSchema, primary_ticket: z.string().min(1),
  position_id: z.string().nullable(), symbol: z.string().min(1), side: tradeHistorySideSchema,
  status: z.enum(['open', 'closed', 'partial', 'unknown']), source: tradeHistorySourceSchema,
  attribution_status: z.enum(['exact', 'partial', 'conflicted', 'unresolved']), evidence_status: z.enum(['complete', 'partial', 'conflicted']),
  volume: decimalSchema, entry_price: decimalSchema, exit_price: decimalSchema.nullable(), stop_loss: decimalSchema.nullable(), take_profit: decimalSchema.nullable(),
  gross_profit: decimalSchema, commission: decimalSchema, swap: decimalSchema, fee: decimalSchema, net_profit: decimalSchema,
  opened_at: z.iso.datetime({ offset: true }), closed_at: z.iso.datetime({ offset: true }).nullable(),
  terminal_timezone_offset_minutes: z.number().int().min(-840).max(840), revision: numericRevisionSchema,
}).strict().transform((value) => ({
  accountCurrency: value.account_currency, currencyEvidence: value.currency_evidence, id: value.id, accountId: value.account_id, platform: value.platform, primaryTicket: value.primary_ticket, positionId: value.position_id,
  symbol: value.symbol, side: value.side, status: value.status, source: value.source, attributionStatus: value.attribution_status,
  evidenceStatus: value.evidence_status, volume: value.volume, entryPrice: value.entry_price, exitPrice: value.exit_price,
  stopLoss: value.stop_loss, takeProfit: value.take_profit, grossProfit: value.gross_profit, commission: value.commission,
  swap: value.swap, fee: value.fee, netProfit: value.net_profit, openedAt: value.opened_at, closedAt: value.closed_at,
  terminalTimezoneOffsetMinutes: value.terminal_timezone_offset_minutes, revision: value.revision,
}))
export const tradeHistorySummarySchema = z.object({
  account_currency: z.string().min(1).max(16).nullable(), money_status: z.enum(['comparable', 'unknown', 'mixed', 'empty']),
  trade_count: z.number().int().nonnegative(), winning_count: z.number().int().nonnegative(), losing_count: z.number().int().nonnegative(), breakeven_count: z.number().int().nonnegative(),
  win_rate_percent: decimalSchema.nullable(), gross_profit: decimalSchema.nullable(), commission: decimalSchema.nullable(), swap: decimalSchema.nullable(), fee: decimalSchema.nullable(),
  net_profit: decimalSchema.nullable(), profit_factor: decimalSchema.nullable(),
}).strict().refine(value => {
  const amounts = [value.gross_profit, value.commission, value.swap, value.fee, value.net_profit]
  return value.money_status === 'comparable'
    ? value.account_currency !== null && value.trade_count > 0 && amounts.every(amount => amount !== null)
    : value.account_currency === null && amounts.every(amount => amount === null) && value.profit_factor === null
      && (value.money_status === 'empty' ? value.trade_count === 0 : value.trade_count > 0)
}, 'trade_history_money_scope_invalid').transform((value) => ({ accountCurrency: value.account_currency, moneyStatus: value.money_status, tradeCount: value.trade_count, winningCount: value.winning_count, losingCount: value.losing_count,
  breakevenCount: value.breakeven_count, winRatePercent: value.win_rate_percent, grossProfit: value.gross_profit, commission: value.commission,
  swap: value.swap, fee: value.fee, netProfit: value.net_profit, profitFactor: value.profit_factor }))
export const tradeHistoryPageResponseSchema = z.object({ data: z.object({
  captured_end: z.iso.datetime({ offset: true }),
  freshness: z.object({ status: z.enum(['empty', 'syncing', 'ready', 'stale', 'failed']), history_revision: numericRevisionSchema,
    fresh_through: z.iso.datetime({ offset: true }).nullable(), last_success_at: z.iso.datetime({ offset: true }).nullable() }).strict(),
  items: z.array(tradeHistoryRecordSchema), next_cursor: z.string().min(1).nullable(), has_more: z.boolean(), summary: tradeHistorySummarySchema,
  daily: z.array(z.object({ business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), trade_count: z.number().int().nonnegative(), net_profit: decimalSchema.nullable(), cumulative_net_profit: decimalSchema.nullable() }).strict()
    .transform((value) => ({ businessDate: value.business_date, tradeCount: value.trade_count, netProfit: value.net_profit, cumulativeNetProfit: value.cumulative_net_profit }))),
}).strict().transform((value) => ({ capturedEnd: value.captured_end, freshness: { status: value.freshness.status, historyRevision: value.freshness.history_revision,
  freshThrough: value.freshness.fresh_through, lastSuccessAt: value.freshness.last_success_at }, items: value.items, nextCursor: value.next_cursor,
  hasMore: value.has_more, summary: value.summary, daily: value.daily })), meta: responseMetaSchema })
export const tradeRecordDealSchema = z.object({ account_currency: z.string().min(1).max(16).nullable(), currency_evidence: z.enum(['unknown', 'explicit_record']), id: z.string(), deal_ticket: z.string(), order_ticket: z.string().nullable(), role: z.enum(['entry', 'exit', 'fee', 'adjustment', 'unknown']),
  side: z.enum(['buy', 'sell', 'none', 'unknown']), entry_kind: z.enum(['in', 'out', 'inout', 'out_by', 'none', 'unknown']), volume: decimalSchema.nullable(), price: decimalSchema.nullable(),
  gross_profit: decimalSchema, commission: decimalSchema, swap: decimalSchema, fee: decimalSchema, occurred_at: z.iso.datetime({ offset: true }) }).strict()
  .transform((value) => ({ accountCurrency: value.account_currency, currencyEvidence: value.currency_evidence, id: value.id, dealTicket: value.deal_ticket, orderTicket: value.order_ticket, role: value.role, side: value.side,
    entryKind: value.entry_kind, volume: value.volume, price: value.price, grossProfit: value.gross_profit, commission: value.commission,
    swap: value.swap, fee: value.fee, occurredAt: value.occurred_at }))
export const tradeRecordAttributionSchema = z.object({ kind: z.enum(['market_analysis', 'trade_decision', 'risk_decision', 'execution_intent', 'execution_outcome', 'bridge_command', 'review_case']),
  source_id: z.string().min(1), relation: z.enum(['opened', 'modified', 'closed', 'cancelled', 'reviewed', 'related']), proof_kind: z.enum(['terminal_ticket', 'terminal_order', 'terminal_deal', 'distribution_target', 'legacy_mapping']) }).strict()
  .transform((value) => ({ kind: value.kind, sourceId: value.source_id, relation: value.relation, proofKind: value.proof_kind }))
export const tradeRecordDetailResponseSchema = z.object({ data: z.object({
  account_currency: z.string().min(1).max(16).nullable(), currency_evidence: z.enum(['unknown', 'explicit_record']),
  id: z.string().min(1), account_id: z.string().min(1), platform: tradingPlatformSchema, primary_ticket: z.string().min(1), position_id: z.string().nullable(), symbol: z.string().min(1),
  side: tradeHistorySideSchema, status: z.enum(['open', 'closed', 'partial', 'unknown']), source: tradeHistorySourceSchema,
  attribution_status: z.enum(['exact', 'partial', 'conflicted', 'unresolved']), evidence_status: z.enum(['complete', 'partial', 'conflicted']), volume: decimalSchema,
  entry_price: decimalSchema, exit_price: decimalSchema.nullable(), stop_loss: decimalSchema.nullable(), take_profit: decimalSchema.nullable(), gross_profit: decimalSchema,
  commission: decimalSchema, swap: decimalSchema, fee: decimalSchema, net_profit: decimalSchema, opened_at: z.iso.datetime({ offset: true }), closed_at: z.iso.datetime({ offset: true }).nullable(),
  terminal_timezone_offset_minutes: z.number().int().min(-840).max(840), revision: numericRevisionSchema, evidence_hash: z.string().regex(/^[a-f0-9]{64}$/),
  deals: z.array(tradeRecordDealSchema), attributions: z.array(tradeRecordAttributionSchema),
}).strict().transform((value) => ({ accountCurrency: value.account_currency, currencyEvidence: value.currency_evidence, id: value.id, accountId: value.account_id, platform: value.platform, primaryTicket: value.primary_ticket, positionId: value.position_id,
  symbol: value.symbol, side: value.side, status: value.status, source: value.source, attributionStatus: value.attribution_status, evidenceStatus: value.evidence_status,
  volume: value.volume, entryPrice: value.entry_price, exitPrice: value.exit_price, stopLoss: value.stop_loss, takeProfit: value.take_profit,
  grossProfit: value.gross_profit, commission: value.commission, swap: value.swap, fee: value.fee, netProfit: value.net_profit, openedAt: value.opened_at,
  closedAt: value.closed_at, terminalTimezoneOffsetMinutes: value.terminal_timezone_offset_minutes, revision: value.revision, evidenceHash: value.evidence_hash,
  deals: value.deals, attributions: value.attributions })), meta: responseMetaSchema })

export const auditSourceKindSchema = z.enum([
  'analysis_run', 'trader_run', 'risk_decision', 'operation', 'bridge_command',
  'risk_policy_change', 'risk_manual_release', 'terminal_trade',
])
export const auditCategorySchema = z.enum(['analysis', 'trading', 'risk', 'execution', 'terminal', 'configuration'])
export const auditActorSchema = z.enum(['ai', 'user', 'system', 'bridge'])
export const auditStatusSchema = z.enum(['queued', 'running', 'succeeded', 'rejected', 'failed', 'uncertain', 'cancelled', 'info'])
export const auditEventSchema = z.object({
  source_kind: auditSourceKindSchema, source_id: z.string().min(1), account_id: z.string().min(1).nullable(),
  category: auditCategorySchema, actor: auditActorSchema, action: z.string().min(1).max(128), status: auditStatusSchema,
  title: z.string().min(1).max(191), summary: z.string().min(1).max(2000), reason_code: z.string().max(128).nullable(),
  symbol: z.string().max(64).nullable(), occurred_at: z.iso.datetime({ offset: true }),
  terminal_timezone_offset_minutes: z.number().int().min(-840).max(840).nullable(), correlation_id: z.string().max(191).nullable(),
}).strict().transform((value) => ({
  sourceKind: value.source_kind, sourceId: value.source_id, accountId: value.account_id, category: value.category,
  actor: value.actor, action: value.action, status: value.status, title: value.title, summary: value.summary,
  reasonCode: value.reason_code, symbol: value.symbol, occurredAt: value.occurred_at,
  terminalTimezoneOffsetMinutes: value.terminal_timezone_offset_minutes, correlationId: value.correlation_id,
}))
export const auditSummarySchema = z.object({
  total: z.number().int().nonnegative(), succeeded: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(), uncertain: z.number().int().nonnegative(), active: z.number().int().nonnegative(),
}).strict()
export const auditTraceNodeSchema = z.object({
  stage: z.enum(['analysis', 'trader', 'risk', 'operation', 'intent', 'bridge', 'terminal']), status: auditStatusSchema,
  source_kind: z.string().min(1).max(64), source_id: z.string().min(1), title: z.string().min(1).max(191),
  detail: z.string().min(1).max(2000), reason_code: z.string().max(128).nullable(), occurred_at: z.iso.datetime({ offset: true }),
}).strict().transform((value) => ({ stage: value.stage, status: value.status, sourceKind: value.source_kind,
  sourceId: value.source_id, title: value.title, detail: value.detail, reasonCode: value.reason_code, occurredAt: value.occurred_at }))
export const auditEventPageResponseSchema = z.object({ data: z.object({
  captured_end: z.iso.datetime({ offset: true }), items: z.array(auditEventSchema), next_cursor: z.string().min(1).nullable(),
  has_more: z.boolean(), summary: auditSummarySchema,
}).strict().transform((value) => ({ capturedEnd: value.captured_end, items: value.items, nextCursor: value.next_cursor,
  hasMore: value.has_more, summary: value.summary })), meta: responseMetaSchema })
export const auditEventDetailResponseSchema = z.object({ data: z.object({
  event: auditEventSchema, trace: z.array(auditTraceNodeSchema),
  evidence: z.array(z.object({ label: z.string().min(1).max(64), value: z.string().min(1).max(2000) }).strict()),
  links: z.array(z.object({ kind: z.enum(['analysis', 'trader', 'risk', 'operation', 'trade']), id: z.string().min(1), label: z.string().min(1).max(64) }).strict()),
}).strict(), meta: responseMetaSchema })

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

export const strategyVersionSchema = z.object({
  id: z.string().min(1), strategy_id: z.string().min(1), kind: strategyKindSchema, version: z.number().int().positive(),
  prompt_text: z.string().min(1).max(100_000), prompt_hash: z.string().regex(/^[a-f0-9]{64}$/),
  config: z.record(z.string(), z.unknown()), input_contract_version: z.string().min(1).max(64),
  output_contract_version: z.string().min(1).max(64), created_by_user_id: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }),
}).strict().transform((value) => ({
  id: value.id, strategyId: value.strategy_id, kind: value.kind, version: value.version, promptText: value.prompt_text,
  promptHash: value.prompt_hash, config: value.config, inputContractVersion: value.input_contract_version,
  outputContractVersion: value.output_contract_version, createdByUserId: value.created_by_user_id, createdAt: value.created_at,
}))

export const strategyDetailSchema = z.object({
  id: z.string().min(1), kind: strategyKindSchema, scope: strategyScopeSchema, owner_user_id: z.string().min(1).nullable(),
  name: z.string().min(1).max(191), description: z.string().max(2000), status: strategyStatusSchema,
  active_version_id: z.string().min(1).nullable(), revision: numericRevisionSchema,
  versions: z.array(strategyVersionSchema),
}).strict().transform((value) => ({
  id: value.id, kind: value.kind, scope: value.scope, ownerUserId: value.owner_user_id, name: value.name,
  description: value.description, status: value.status, activeVersionId: value.active_version_id, revision: value.revision,
  versions: value.versions,
}))
export const strategyDetailResponseSchema = z.object({ data: strategyDetailSchema, meta: responseMetaSchema })

export const strategyCompileIssueSchema = z.object({
  level: z.enum(['error', 'warning']), code: z.string().min(1).max(128), message: z.string().min(1).max(2000), path: z.string().max(256).nullable(),
}).strict()
export const strategyCompileResultSchema = z.object({
  valid: z.boolean(), kind: strategyKindSchema, prompt_hash: z.string().regex(/^[a-f0-9]{64}$/),
  normalized_config: z.record(z.string(), z.unknown()), input_contract_version: z.string().min(1).max(64),
  output_contract_version: z.string().min(1).max(64), issues: z.array(strategyCompileIssueSchema),
}).strict().transform((value) => ({
  valid: value.valid, kind: value.kind, promptHash: value.prompt_hash, normalizedConfig: value.normalized_config,
  inputContractVersion: value.input_contract_version, outputContractVersion: value.output_contract_version, issues: value.issues,
}))
export const strategyCompileResponseSchema = z.object({ data: strategyCompileResultSchema, meta: responseMetaSchema })

export const strategyCompileBodySchema = z.object({ kind: strategyKindSchema, prompt_text: z.string().trim().min(1).max(100_000), config: z.record(z.string(), z.unknown()) }).strict()
export const strategyCreateBodySchema = z.object({
  kind: strategyKindSchema, name: z.string().trim().min(1).max(191), description: z.string().trim().max(2000),
  prompt_text: z.string().trim().min(1).max(100_000), config: z.record(z.string(), z.unknown()),
}).strict()
export const strategyMetadataPatchBodySchema = z.object({ name: z.string().trim().min(1).max(191), description: z.string().trim().max(2000) }).strict()
export const strategyVersionCreateBodySchema = z.object({ prompt_text: z.string().trim().min(1).max(100_000), config: z.record(z.string(), z.unknown()) }).strict()

export const strategySubscriptionScheduleSchema = z.object({
  cadence_seconds: z.number().int().min(60), receive_timezone: z.string().regex(/^[A-Za-z0-9_+/:-]{1,64}$/),
  receive_window: z.record(z.string(), z.unknown()), next_due_at: z.iso.datetime({ offset: true }).nullable(), revision: numericRevisionSchema,
}).strict().transform((value) => ({
  cadenceSeconds: value.cadence_seconds, receiveTimezone: value.receive_timezone, receiveWindow: value.receive_window,
  nextDueAt: value.next_due_at, revision: value.revision,
}))
export const strategySubscriptionSchema = z.object({
  id: z.string().min(1), user_id: z.string().min(1), trading_account_id: z.string().min(1), symbol: z.string().min(1).max(64),
  analysis_strategy_id: z.string().min(1), analysis_strategy_version_id: z.string().min(1),
  trader_strategy_id: z.string().min(1).nullable(), trader_strategy_version_id: z.string().min(1).nullable(),
  analysis_enabled: z.boolean(), trader_enabled: z.boolean(), trade_send_enabled: z.boolean(),
  status: z.enum(['active', 'paused', 'ended']), revision: numericRevisionSchema,
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }), schedule: strategySubscriptionScheduleSchema,
}).strict().transform((value) => ({
  id: value.id, userId: value.user_id, tradingAccountId: value.trading_account_id, standardSymbol: value.symbol,
  analysisStrategyId: value.analysis_strategy_id, analysisStrategyVersionId: value.analysis_strategy_version_id,
  traderStrategyId: value.trader_strategy_id, traderStrategyVersionId: value.trader_strategy_version_id,
  analysisEnabled: value.analysis_enabled, traderEnabled: value.trader_enabled, tradeSendEnabled: value.trade_send_enabled,
  status: value.status, revision: value.revision, createdAt: value.created_at, updatedAt: value.updated_at, schedule: value.schedule,
}))
export const strategySubscriptionResponseSchema = z.object({ data: strategySubscriptionSchema, meta: responseMetaSchema })
export const strategySubscriptionsResponseSchema = z.object({ data: z.object({ items: z.array(strategySubscriptionSchema) }), meta: responseMetaSchema })
export const strategySubscriptionCreateBodySchema = z.object({
  trading_account_id: z.string().min(1).max(191), symbol: z.string().trim().min(1).max(64), analysis_strategy_id: z.string().min(1).max(191),
  trader_strategy_id: z.string().min(1).max(191).nullable().optional(), analysis_enabled: z.boolean().optional(), trader_enabled: z.boolean().optional(),
  trade_send_enabled: z.boolean().optional(), status: z.enum(['active', 'paused']).optional(),
}).strict()
export const strategySubscriptionPatchBodySchema = z.object({
  symbol: z.string().trim().min(1).max(64).optional(), analysis_strategy_id: z.string().min(1).max(191).optional(),
  trader_strategy_id: z.string().min(1).max(191).nullable().optional(), analysis_enabled: z.boolean().optional(),
  trader_enabled: z.boolean().optional(), trade_send_enabled: z.boolean().optional(), status: z.enum(['active', 'paused', 'ended']).optional(),
}).strict()

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

export const reviewKindSchema = z.enum(['daily', 'monthly', 'manual'])
export const reviewCaseStatusSchema = z.enum(['awaiting_evidence', 'queued', 'running', 'awaiting_confirmation', 'needs_changes', 'confirmed', 'failed'])
export const reviewEvidenceStatusSchema = z.enum(['pending', 'incomplete', 'complete', 'stale'])
export const reviewConclusionSchema = z.enum(['effective', 'mixed', 'ineffective', 'insufficient_evidence', 'manual_trade_reviewed'])
export const reviewAssessmentSchema = z.enum(['effective', 'mixed', 'problem', 'insufficient_evidence', 'not_applicable'])

export const reviewCaseSummarySchema = z.object({
  id: z.string().min(1), kind: reviewKindSchema, user_id: z.string().min(1), trading_account_id: z.string().min(1),
  account_label: z.string().min(1), symbol: z.string().min(1).nullable(), subscription_id: z.string().min(1).nullable(), subscription_revision: numericRevisionSchema.nullable(), analysis_strategy_id: z.string().min(1).nullable(),
  analysis_strategy_name: z.string().min(1).nullable(), trader_strategy_id: z.string().min(1).nullable(), trader_strategy_name: z.string().min(1).nullable(),
  terminal_period_start: z.iso.datetime({ offset: true }), terminal_period_end: z.iso.datetime({ offset: true }),
  terminal_timezone_offset_minutes: z.number().int().min(-840).max(840), status: reviewCaseStatusSchema,
  evidence_status: reviewEvidenceStatusSchema, evidence_revision: numericRevisionSchema, evidence_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), current_version_id: z.string().min(1).nullable(),
  confirmed_version_id: z.string().min(1).nullable(), updated_at: z.iso.datetime({ offset: true }), revision: numericRevisionSchema,
}).strict().transform((value) => ({
  id: value.id, kind: value.kind, userId: value.user_id, tradingAccountId: value.trading_account_id, accountLabel: value.account_label,
  symbol: value.symbol, subscriptionId: value.subscription_id, subscriptionRevision: value.subscription_revision, analysisStrategyId: value.analysis_strategy_id, analysisStrategyName: value.analysis_strategy_name,
  traderStrategyId: value.trader_strategy_id, traderStrategyName: value.trader_strategy_name, terminalPeriodStart: value.terminal_period_start,
  terminalPeriodEnd: value.terminal_period_end, terminalTimezoneOffsetMinutes: value.terminal_timezone_offset_minutes, status: value.status,
  evidenceStatus: value.evidence_status, evidenceRevision: value.evidence_revision, evidenceHash: value.evidence_hash, currentVersionId: value.current_version_id,
  confirmedVersionId: value.confirmed_version_id, updatedAt: value.updated_at, revision: value.revision,
}))

const reviewRoleResultSchema = z.object({ assessment: reviewAssessmentSchema, summary: z.string().max(5000), evidence_refs: z.array(z.string().min(1)).max(2000) }).strict().transform((value) => ({ assessment: value.assessment, summary: value.summary, evidenceRefs: value.evidence_refs }))
const reviewTradeEpisodeSchema = z.object({ source_id: z.string().min(1), symbol: z.string().min(1), side: z.enum(['buy', 'sell', 'none']), opened_at: z.iso.datetime({ offset: true }).nullable(), closed_at: z.iso.datetime({ offset: true }).nullable(), net_profit: decimalSchema.nullable(), outcome: z.enum(['win', 'loss', 'breakeven', 'not_executed', 'unknown']), summary: z.string().max(5000) }).strict().transform((value) => ({ sourceId: value.source_id, symbol: value.symbol, side: value.side, openedAt: value.opened_at, closedAt: value.closed_at, netProfit: value.net_profit, outcome: value.outcome, summary: value.summary }))
const reviewCounterexampleSchema = z.object({ kind: z.enum(['missed_opportunity', 'false_positive']), title: z.string().min(1).max(300), summary: z.string().max(5000), evidence_refs: z.array(z.string().min(1)).max(2000), status: z.enum(['candidate', 'supported', 'rejected']) }).strict().transform((value) => ({ kind: value.kind, title: value.title, summary: value.summary, evidenceRefs: value.evidence_refs, status: value.status }))
const reviewMemoryCandidateSchema = z.object({ strategy_id: z.string().min(1), memory_key: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,190}$/), update_kind: z.enum(['short_term', 'long_term_candidate', 'monthly_summary', 'platform_candidate']), title: z.string().min(1).max(300), content: z.string().min(1).max(20_000), evidence_refs: z.array(z.string().min(1)).max(2000) }).strict().transform((value) => ({ strategyId: value.strategy_id, memoryKey: value.memory_key, updateKind: value.update_kind, title: value.title, content: value.content, evidenceRefs: value.evidence_refs }))

const reviewContentWireSchema = z.object({
  schema_version: z.literal('review.v4.1'), conclusion: reviewConclusionSchema, headline: z.string().min(1).max(300), summary: z.string().min(1).max(5000),
  metrics: z.object({ net_profit: decimalSchema.nullable(), trade_count: z.number().int().nonnegative(), win_rate_percent: decimalSchema.nullable(), profit_factor: decimalSchema.nullable() }).strict(),
  trade_episodes: z.array(reviewTradeEpisodeSchema).max(500),
  roles: z.object({ analyst: reviewRoleResultSchema, trader: reviewRoleResultSchema, risk: reviewRoleResultSchema, execution: reviewRoleResultSchema }).strict(),
  counterexamples: z.array(reviewCounterexampleSchema).max(100), memory_candidates: z.array(reviewMemoryCandidateSchema).max(100),
  evidence_refs: z.array(z.string().min(1)).max(2000), full_analysis_text: z.string().max(500_000),
}).strict()

export const reviewContentSchema = reviewContentWireSchema.transform((value) => ({
  schemaVersion: value.schema_version, conclusion: value.conclusion, headline: value.headline, summary: value.summary,
  metrics: { netProfit: value.metrics.net_profit, tradeCount: value.metrics.trade_count, winRatePercent: value.metrics.win_rate_percent, profitFactor: value.metrics.profit_factor },
  tradeEpisodes: value.trade_episodes, roles: value.roles, counterexamples: value.counterexamples, memoryCandidates: value.memory_candidates,
  evidenceRefs: value.evidence_refs, fullAnalysisText: value.full_analysis_text,
}))

export const reviewVersionSchema = z.object({ id: z.string().min(1), review_case_id: z.string().min(1), version: z.number().int().positive(), author_kind: z.enum(['ai', 'user']), conclusion: reviewConclusionSchema, content: reviewContentSchema, created_at: z.iso.datetime({ offset: true }) }).strict().transform((value) => ({ id: value.id, caseId: value.review_case_id, versionNumber: value.version, authorKind: value.author_kind, conclusion: value.conclusion, content: value.content, createdAt: value.created_at }))
const reviewSourceSchema = z.object({ kind: z.enum(['market_analysis', 'trade_decision', 'risk_decision', 'execution_outcome', 'terminal_trade', 'period_review']), source_id: z.string().min(1), relation: z.enum(['direct', 'counterexample', 'missed_opportunity', 'false_positive']), evidence_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().transform((value) => ({ kind: value.kind, sourceId: value.source_id, relation: value.relation, evidenceHash: value.evidence_hash }))
const reviewJobSummarySchema = z.object({ id: z.string().min(1), generation: z.number().int().positive(), mode: z.enum(['initial', 'retry', 'refresh_evidence']), status: z.enum(['queued', 'preparing_evidence', 'waiting_model', 'validating', 'succeeded', 'retry_wait', 'failed', 'cancelled', 'completed_stale']), progress_percent: z.number().int().min(0).max(100), current_stage: z.string().min(1), last_error_code: z.string().nullable(), updated_at: z.iso.datetime({ offset: true }) }).strict().transform((value) => ({ id: value.id, generation: value.generation, mode: value.mode, status: value.status, progressPercent: value.progress_percent, currentStage: value.current_stage, lastErrorCode: value.last_error_code, updatedAt: value.updated_at }))
export const reviewCaseDetailSchema = z.object({ summary: reviewCaseSummarySchema, current_version: reviewVersionSchema.nullable(), sources: z.array(reviewSourceSchema), current_job: reviewJobSummarySchema.nullable(), return_reason: z.string().nullable() }).strict().transform((value) => ({ summary: value.summary, currentVersion: value.current_version, sources: value.sources, currentJob: value.current_job, returnReason: value.return_reason }))
export const reviewCasesResponseSchema = z.object({ data: z.object({ items: z.array(reviewCaseSummarySchema) }).strict(), meta: responseMetaSchema }).strict()
export const reviewCaseDetailResponseSchema = z.object({ data: reviewCaseDetailSchema, meta: responseMetaSchema }).strict()

export const manualReviewCandidateSchema = z.object({ id: z.string().min(1), trading_account_id: z.string().min(1), account_label: z.string().min(1), ticket: z.string().min(1), position_id: z.string().min(1).nullable(), symbol: z.string().min(1), side: z.enum(['buy', 'sell']), volume: decimalSchema, opened_at: z.iso.datetime({ offset: true }), closed_at: z.iso.datetime({ offset: true }), net_profit: decimalSchema, terminal_timezone_offset_minutes: z.number().int().min(-840).max(840), source_classification: z.enum(['manual', 'system', 'other_ea', 'unknown']), eligibility_status: z.enum(['eligible', 'incomplete', 'already_reviewed']), selection_token: z.string().min(24), selection_expires_at: z.iso.datetime({ offset: true }), revision: numericRevisionSchema }).strict().transform((value) => ({ id: value.id, tradingAccountId: value.trading_account_id, accountLabel: value.account_label, ticket: value.ticket, positionId: value.position_id, symbol: value.symbol, side: value.side, volume: value.volume, openedAt: value.opened_at, closedAt: value.closed_at, netProfit: value.net_profit, terminalTimezoneOffsetMinutes: value.terminal_timezone_offset_minutes, sourceClassification: value.source_classification, eligibilityStatus: value.eligibility_status, selectionToken: value.selection_token, selectionExpiresAt: value.selection_expires_at, revision: value.revision }))
export const manualReviewCandidatesResponseSchema = z.object({ data: z.object({ items: z.array(manualReviewCandidateSchema) }).strict(), meta: responseMetaSchema }).strict()
export const manualReviewCaseCreateBodySchema = z.object({ candidate_ids: z.array(z.string().min(1)).min(1).max(20), selection_tokens: z.array(z.string().min(24)).min(1).max(20), strategy_id: z.string().min(1), user_thesis: z.string().trim().max(2000).nullable().optional() }).strict()
export const reviewGenerationBodySchema = z.object({ mode: z.enum(['retry', 'refresh_evidence']) }).strict()
export const reviewVersionCreateBodySchema = z.object({ content: reviewContentWireSchema }).strict()
export const reviewConfirmBodySchema = z.object({ version_id: z.string().min(1) }).strict()
export const reviewReturnBodySchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict()

export const strategyMemorySummarySchema = z.object({ id: z.string().min(1), strategy_id: z.string().min(1), strategy_name: z.string().min(1), strategy_kind: strategyKindSchema, owner_user_id: z.string().min(1).nullable(), mode: z.enum(['off', 'shadow', 'active']), status: z.enum(['active', 'revalidating', 'retired']), current_version: z.number().int().nonnegative(), pending_count: z.number().int().nonnegative(), updated_at: z.iso.datetime({ offset: true }), revision: numericRevisionSchema }).strict().transform((value) => ({ id: value.id, strategyId: value.strategy_id, strategyName: value.strategy_name, strategyKind: value.strategy_kind, ownerUserId: value.owner_user_id, mode: value.mode, status: value.status, currentVersionNumber: value.current_version, pendingCount: value.pending_count, updatedAt: value.updated_at, revision: value.revision }))
export const strategyMemoryDetailSchema = z.object({ id: z.string().min(1), strategy_id: z.string().min(1), strategy_name: z.string().min(1), strategy_kind: strategyKindSchema, owner_user_id: z.string().min(1).nullable(), mode: z.enum(['off', 'shadow', 'active']), status: z.enum(['active', 'revalidating', 'retired']), current_version: z.number().int().nonnegative(), pending_count: z.number().int().nonnegative(), updated_at: z.iso.datetime({ offset: true }), revision: numericRevisionSchema, current_revision_id: z.string().min(1).nullable(), content_text: z.string(), content_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), max_context_tokens: z.number().int().positive() }).strict().transform((value) => ({ id: value.id, strategyId: value.strategy_id, strategyName: value.strategy_name, strategyKind: value.strategy_kind, ownerUserId: value.owner_user_id, mode: value.mode, status: value.status, currentVersionNumber: value.current_version, pendingCount: value.pending_count, updatedAt: value.updated_at, revision: value.revision, currentRevisionId: value.current_revision_id, contentText: value.content_text, contentHash: value.content_hash, maxContextTokens: value.max_context_tokens }))
const strategyMemoryProposalSchema = z.object({ memory_key: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,190}$/), title: z.string().min(1).max(300), content: z.string().min(1).max(20_000), evidence_refs: z.array(z.string().min(1)).max(2000) }).strict().transform((value) => ({ memoryKey: value.memory_key, title: value.title, content: value.content, evidenceRefs: value.evidence_refs }))
const strategyMemoryConflictSchema = z.object({ type: z.literal('same_key_content_changed'), prior_update_id: z.string().min(1), memory_key: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,190}$/) }).strict().transform((value) => ({ type: value.type, priorUpdateId: value.prior_update_id, memoryKey: value.memory_key }))
export const strategyMemoryUpdateSchema = z.object({ id: z.string().min(1), library_id: z.string().min(1), source_review_case_id: z.string().min(1), source_review_version_id: z.string().min(1), update_kind: z.enum(['short_term', 'long_term_candidate', 'monthly_summary', 'platform_candidate']), status: z.enum(['collecting_evidence', 'awaiting_confirmation', 'accepted', 'rejected', 'merged', 'superseded']), expected_library_revision: numericRevisionSchema, proposal: strategyMemoryProposalSchema, diff_preview_text: z.string(), conflicts: z.array(strategyMemoryConflictSchema), created_at: z.iso.datetime({ offset: true }), revision: numericRevisionSchema }).strict().transform((value) => ({ id: value.id, libraryId: value.library_id, sourceReviewCaseId: value.source_review_case_id, sourceReviewVersionId: value.source_review_version_id, updateKind: value.update_kind, status: value.status, expectedLibraryRevision: value.expected_library_revision, proposal: value.proposal, diffPreviewText: value.diff_preview_text, conflicts: value.conflicts, createdAt: value.created_at, revision: value.revision }))
export const strategyMemoriesResponseSchema = z.object({ data: z.object({ items: z.array(strategyMemorySummarySchema) }).strict(), meta: responseMetaSchema }).strict()
export const strategyMemoryDetailResponseSchema = z.object({ data: strategyMemoryDetailSchema, meta: responseMetaSchema }).strict()
export const strategyMemoryUpdatesResponseSchema = z.object({ data: z.object({ items: z.array(strategyMemoryUpdateSchema) }).strict(), meta: responseMetaSchema }).strict()
export const strategyMemoryUpdateResponseSchema = z.object({ data: strategyMemoryUpdateSchema, meta: responseMetaSchema }).strict()
export const strategyMemoryDecisionBodySchema = z.object({ decision: z.enum(['accept', 'reject', 'revoke']) }).strict()

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

export const accountMetricsUpdateSchema = z.object({
  balance: decimalSchema, equity: decimalSchema, margin: decimalSchema,
  free_margin: decimalSchema, floating_profit: decimalSchema,
  currency: z.string().min(3).max(12), observed_at: z.iso.datetime({ offset: true }),
  timezone_offset_minutes: z.number().int().min(-840).max(840).nullable().optional(),
  clock_status: z.enum(['calibrated', 'observer_bootstrap', 'stale', 'unavailable']).optional(),
}).strict().refine(value => (value.timezone_offset_minutes !== undefined) === (value.clock_status !== undefined), {
  message: 'timezone offset and clock status must be supplied together',
})
export type AccountMetricsUpdate = z.infer<typeof accountMetricsUpdateSchema>

export const tradingRealtimeEventSchema = z.object({
  v: z.literal(4), event_id: z.string(),
  type: z.enum(['runtime.bridge.changed', 'account.metrics.changed', 'market.quote.updated', 'market.candle.updated', 'market.candle.closed', 'positions.changed', 'pending_orders.changed', 'trade.history.changed']),
  occurred_at: z.iso.datetime({ offset: true }), sequence: z.number().int().positive(),
  scope: z.object({ user_id: z.string(), trading_account_id: z.string(), terminal_instance_id: z.string().nullable(), observer_channel_id: z.string().nullable() }),
  resource: z.object({ kind: z.string(), id: z.string() }), revision: z.string(), data: z.unknown(), correlation_id: z.string().nullable(),
}).refine(value => value.resource.kind !== 'observer_publication', {
  path: ['resource', 'kind'], message: 'observer publications use their dedicated event type',
})

export const observerPublicationResourceSchema = z.enum(['account.metrics', 'market.quote', 'market.candle', 'positions', 'pending_orders'])
export const observerPublicationChangedDataSchema = z.object({
  channel_id: z.string().min(1).max(191),
  source_revision: z.string().min(1).max(128),
  resource: observerPublicationResourceSchema,
  resource_id: z.string().min(1).max(191),
}).strict()
export const observerPublicationChangedRealtimeEventSchema = z.object({
  v: z.literal(4), event_id: z.string().min(1).max(191), type: z.literal('observer.publication.changed'),
  occurred_at: z.iso.datetime({ offset: true }), sequence: z.number().int().positive(),
  scope: z.object({
    user_id: z.string().min(1).max(191), trading_account_id: z.string().min(1).max(191),
    terminal_instance_id: z.null(), observer_channel_id: z.string().min(1).max(191),
  }).strict(),
  resource: z.object({ kind: z.literal('observer_publication'), id: z.string().min(1).max(191) }).strict(),
  revision: z.string().min(1).max(128),
  data: observerPublicationChangedDataSchema,
  correlation_id: z.string().min(1).max(191).nullable(),
}).strict().superRefine((value, context) => {
  if (value.scope.observer_channel_id !== value.resource.id || value.scope.observer_channel_id !== value.data.channel_id) {
    context.addIssue({ code: 'custom', path: ['scope', 'observer_channel_id'], message: 'observer channel identity mismatch' })
  }
})
export const observerPublicationChangedEventSchema = observerPublicationChangedRealtimeEventSchema

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

export const auditRealtimeEventSchema = z.object({
  v: z.literal(4), event_id: z.string(), type: z.literal('audit.changed'),
  occurred_at: z.iso.datetime({ offset: true }), sequence: z.number().int().positive(),
  scope: z.object({ user_id: z.string(), trading_account_id: z.string().nullable(), terminal_instance_id: z.string().nullable(), observer_channel_id: z.null() }),
  resource: z.object({ kind: z.literal('audit'), id: z.string() }), revision: z.string(),
  data: z.object({ source_type: z.string().min(1), source_id: z.string().min(1) }).strict(), correlation_id: z.string().nullable(),
})

const reviewRealtimeBaseSchema = z.object({
  v: z.literal(4), event_id: z.string(),
  occurred_at: z.iso.datetime({ offset: true }), sequence: z.number().int().positive(),
  scope: z.object({ user_id: z.string(), trading_account_id: z.string().nullable(), terminal_instance_id: z.string().nullable(), observer_channel_id: z.string().nullable() }),
  revision: z.string(),
  correlation_id: z.string().nullable(),
})
export const reviewRealtimeEventSchema = z.union([
  reviewRealtimeBaseSchema.extend({
    type: z.literal('review.case.changed'), resource: z.object({ kind: z.literal('review_case'), id: z.string() }),
    data: z.object({ review_case_id: z.string(), status: reviewCaseStatusSchema, current_version_id: z.string().nullable().optional(), revision: z.string() }).strict(),
  }),
  reviewRealtimeBaseSchema.extend({
    type: z.literal('strategy.memory.changed'), resource: z.object({ kind: z.literal('strategy_memory'), id: z.string() }),
    data: z.object({ strategy_memory_id: z.string(), status: z.enum(['active', 'revalidating', 'retired']), pending_count: z.number().int().nonnegative(), revision: z.string() }).strict(),
  }),
])

export const macroRealtimeChangeSchema = z.enum(['created', 'updated', 'superseded', 'invalidated'])
export const macroSourceHealthSchema = z.string().trim().min(1).max(64)

const platformMacroRealtimeEnvelopeSchema = z.object({
  v: z.literal(4), event_id: z.string().min(1).max(191),
  occurred_at: macroUtcDatetimeSchema, sequence: z.number().int().positive(),
  scope: z.object({
    user_id: z.string().min(1).max(191), trading_account_id: z.null(),
    terminal_instance_id: z.null(), observer_channel_id: z.null(),
  }).strict(),
  revision: z.string().min(1).max(128), correlation_id: z.string().min(1).max(191).nullable(),
}).strict()

export const marketMacroChangedRealtimeEventSchema = platformMacroRealtimeEnvelopeSchema.extend({
  type: z.literal('market.macro.changed'),
  resource: z.object({ kind: z.literal('macro_snapshot'), id: z.string().min(1).max(191) }).strict(),
  data: z.object({
    change: macroRealtimeChangeSchema,
    published_at: macroUtcDatetimeSchema,
    status: macroSnapshotStatusSchema,
  }).strict(),
}).strict()

export const marketCalendarChangedRealtimeEventSchema = platformMacroRealtimeEnvelopeSchema.extend({
  type: z.literal('market.calendar.changed'),
  resource: z.object({ kind: z.literal('calendar_event'), id: z.string().min(1).max(191) }).strict(),
  data: z.object({
    change: macroRealtimeChangeSchema,
    scheduled_at: macroUtcDatetimeSchema,
    importance: economicCalendarImportanceSchema,
    status: economicCalendarStatusSchema,
  }).strict(),
}).strict()

export const marketSourceHealthChangedRealtimeEventSchema = platformMacroRealtimeEnvelopeSchema.extend({
  type: z.literal('market.source_health.changed'),
  resource: z.object({ kind: z.literal('macro_source_health'), id: z.string().min(1).max(191) }).strict(),
  data: z.object({
    source_id: z.string().min(1).max(191),
    health: macroSourceHealthSchema,
    observed_at: macroUtcDatetimeSchema,
  }).strict(),
}).strict()

export const marketMacroRealtimeEventSchema = z.union([
  marketMacroChangedRealtimeEventSchema,
  marketCalendarChangedRealtimeEventSchema,
  marketSourceHealthChangedRealtimeEventSchema,
])
export const macroRealtimeEventSchema = marketMacroRealtimeEventSchema
export const marketMacroChangedEventSchema = marketMacroChangedRealtimeEventSchema
export const marketCalendarChangedEventSchema = marketCalendarChangedRealtimeEventSchema
export const marketSourceHealthChangedEventSchema = marketSourceHealthChangedRealtimeEventSchema

export const browserRealtimeEventSchema = z.union([
  tradingRealtimeEventSchema, observerPublicationChangedRealtimeEventSchema, inferenceRealtimeEventSchema, riskRealtimeEventSchema, operationRealtimeEventSchema, reviewRealtimeEventSchema,
  auditRealtimeEventSchema, marketMacroRealtimeEventSchema,
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
export type MacroFactor = z.infer<typeof macroFactorSchema>
export type MacroSnapshot = z.infer<typeof macroSnapshotSchema>
export type MacroSnapshotDetail = z.infer<typeof macroSnapshotDetailSchema>
export type MacroSnapshotSummary = z.infer<typeof macroSnapshotSummarySchema>
export type MacroSeriesPoint = z.infer<typeof macroSeriesPointSchema>
export type EconomicCalendarEvent = z.infer<typeof economicCalendarEventSchema>
export type CalendarEvent = z.infer<typeof calendarEventSchema>
export type MacroMarketOverview = z.infer<typeof macroMarketOverviewResponseSchema>['data']
export type TradeHistorySide = z.infer<typeof tradeHistorySideSchema>
export type TradeHistorySource = z.infer<typeof tradeHistorySourceSchema>
export type TradeHistoryRecord = z.infer<typeof tradeHistoryRecordSchema>
export type TradeHistorySummary = z.infer<typeof tradeHistorySummarySchema>
export type TradeHistoryPageResponse = z.infer<typeof tradeHistoryPageResponseSchema>
export type TradeRecordDetail = z.infer<typeof tradeRecordDetailResponseSchema>['data']
export type AuditSourceKind = z.infer<typeof auditSourceKindSchema>
export type AuditCategory = z.infer<typeof auditCategorySchema>
export type AuditActor = z.infer<typeof auditActorSchema>
export type AuditStatus = z.infer<typeof auditStatusSchema>
export type AuditEvent = z.infer<typeof auditEventSchema>
export type AuditSummary = z.infer<typeof auditSummarySchema>
export type AuditTraceNode = z.infer<typeof auditTraceNodeSchema>
export type AuditEventPageResponse = z.infer<typeof auditEventPageResponseSchema>
export type AuditEventDetail = z.infer<typeof auditEventDetailResponseSchema>['data']
export type OpenPosition = z.infer<typeof openPositionSchema>
export type PendingOrder = z.infer<typeof pendingOrderSchema>
export type Timeframe = z.infer<typeof timeframeSchema>
export type TradingRealtimeEvent = z.infer<typeof tradingRealtimeEventSchema>
export type ObserverPublicationResource = z.infer<typeof observerPublicationResourceSchema>
export type ObserverPublicationChangedData = z.infer<typeof observerPublicationChangedDataSchema>
export type ObserverPublicationChangedRealtimeEvent = z.infer<typeof observerPublicationChangedRealtimeEventSchema>
export type ObserverPublicationChangedEvent = z.infer<typeof observerPublicationChangedEventSchema>
export type StrategyKind = z.infer<typeof strategyKindSchema>
export type StrategySummary = z.infer<typeof strategySummarySchema>
export type StrategyVersion = z.infer<typeof strategyVersionSchema>
export type StrategyDetail = z.infer<typeof strategyDetailSchema>
export type StrategyCompileIssue = z.infer<typeof strategyCompileIssueSchema>
export type StrategyCompileResult = z.infer<typeof strategyCompileResultSchema>
export type StrategyCompileBody = z.infer<typeof strategyCompileBodySchema>
export type StrategyCreateBody = z.infer<typeof strategyCreateBodySchema>
export type StrategyMetadataPatchBody = z.infer<typeof strategyMetadataPatchBodySchema>
export type StrategyVersionCreateBody = z.infer<typeof strategyVersionCreateBodySchema>
export type StrategySubscriptionSchedule = z.infer<typeof strategySubscriptionScheduleSchema>
export type StrategySubscription = z.infer<typeof strategySubscriptionSchema>
export type StrategySubscriptionCreateBody = z.infer<typeof strategySubscriptionCreateBodySchema>
export type StrategySubscriptionPatchBody = z.infer<typeof strategySubscriptionPatchBodySchema>
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
export type ReviewKind = z.infer<typeof reviewKindSchema>
export type ReviewCaseSummary = z.infer<typeof reviewCaseSummarySchema>
export type ReviewContent = z.infer<typeof reviewContentSchema>
export type ReviewVersion = z.infer<typeof reviewVersionSchema>
export type ReviewCaseDetail = z.infer<typeof reviewCaseDetailSchema>
export type ManualReviewCandidate = z.infer<typeof manualReviewCandidateSchema>
export type ManualReviewCaseCreateBody = z.infer<typeof manualReviewCaseCreateBodySchema>
export type StrategyMemorySummary = z.infer<typeof strategyMemorySummarySchema>
export type StrategyMemoryDetail = z.infer<typeof strategyMemoryDetailSchema>
export type StrategyMemoryUpdate = z.infer<typeof strategyMemoryUpdateSchema>
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
export type AuditRealtimeEvent = z.infer<typeof auditRealtimeEventSchema>
export type ReviewRealtimeEvent = z.infer<typeof reviewRealtimeEventSchema>
export type MarketMacroChangedRealtimeEvent = z.infer<typeof marketMacroChangedRealtimeEventSchema>
export type MarketCalendarChangedRealtimeEvent = z.infer<typeof marketCalendarChangedRealtimeEventSchema>
export type MarketSourceHealthChangedRealtimeEvent = z.infer<typeof marketSourceHealthChangedRealtimeEventSchema>
export type MarketMacroRealtimeEvent = z.infer<typeof marketMacroRealtimeEventSchema>
export type MacroRealtimeEvent = z.infer<typeof macroRealtimeEventSchema>
export type BrowserRealtimeEvent = z.infer<typeof browserRealtimeEventSchema>
