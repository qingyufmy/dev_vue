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

export const tradingRealtimeEventSchema = z.object({
  v: z.literal(4), event_id: z.string(),
  type: z.enum(['runtime.bridge.changed', 'account.metrics.changed', 'market.quote.updated', 'market.candle.updated', 'market.candle.closed', 'positions.changed', 'pending_orders.changed']),
  occurred_at: z.iso.datetime({ offset: true }), sequence: z.number().int().positive(),
  scope: z.object({ user_id: z.string(), trading_account_id: z.string(), terminal_instance_id: z.string().nullable(), observer_channel_id: z.string().nullable() }),
  resource: z.object({ kind: z.string(), id: z.string() }), revision: z.string(), data: z.unknown(), correlation_id: z.string().nullable(),
})

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
