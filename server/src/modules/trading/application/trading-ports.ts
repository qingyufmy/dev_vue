import type {
  AccountSnapshot, MarketCandle, MarketQuote, OpenPosition, PendingOrder,
  ObserverChannelSummary, RealtimeResource, TerminalProfileSummary, Timeframe, TradingAccountSummary, TradingContext,
} from '../domain/trading.js'

export interface TradingReadRepository {
  getContext(userId: number): Promise<TradingContext | null>
  saveContext(context: Omit<TradingContext, 'revision'>, expectedRevision: number | null): Promise<TradingContext>
  listAccounts(userId: number): Promise<TradingAccountSummary[]>
  listTerminalProfiles(userId: number): Promise<TerminalProfileSummary[]>
  listObserverChannels(userId: number): Promise<ObserverChannelSummary[]>
  findAccount(accountId: string): Promise<TradingAccountSummary | null>
  findOwnedAccount(userId: number, accountId: string): Promise<TradingAccountSummary | null>
  getAccountSnapshot(accountId: string): Promise<AccountSnapshot | null>
  listSymbols(accountId: string): Promise<string[]>
  getQuote(accountId: string, symbol: string): Promise<MarketQuote | null>
  listCandles(accountId: string, symbol: string, timeframe: Timeframe, limit: number): Promise<MarketCandle[]>
  listPositions(accountId: string): Promise<{ revision: number; items: OpenPosition[] }>
  listPendingOrders(accountId: string): Promise<{ revision: number; items: PendingOrder[] }>
  latestRevision(accountId: string, resource: RealtimeResource, resourceId: string): Promise<number>
}

export interface ConnectionCapacityRepository {
  getPurchasedCapacity(userId: number): Promise<number>
}

export class ConnectionCapacityExceededError extends Error {
  constructor() { super('connection_capacity_exceeded'); this.name = 'ConnectionCapacityExceededError' }
}

export interface ConnectionLeaseStore {
  claim(input: {
    userId: number
    accountId: string
    terminalProfileId: string
    terminalInstanceId: string
    connectionEpoch: string
    capacity: number
    ttlSeconds: number
  }): Promise<{ active: number; replacedEpoch: string | null }>
  renew(userId: number, accountId: string, connectionEpoch: string, ttlSeconds: number): Promise<boolean>
  release(userId: number, accountId: string, connectionEpoch: string): Promise<void>
  count(userId: number): Promise<number>
}

export interface TradingProjectionRepository {
  applyProjection(input: TradingProjectionWrite): Promise<boolean>
}

export interface TrustedBridgeProjectionRoute {
  userId: number
  accountId: string
  terminalProfileId: string
  terminalInstanceId: string
  connectionEpoch: number
}

export interface BridgeExactTradeState {
  ticket: string
  symbol: string
  direction: 'buy' | 'sell'
  order_type: 'market' | 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop' | 'buy_stop_limit' | 'sell_stop_limit'
  magic: number
  volume: string
  open_price: string
  stop_limit_price: string | null
  stop_loss: string | null
  take_profit: string | null
  expiration_utc_msc: number | null
}

export type TrustedBridgeProjectionWrite =
  | { route: TrustedBridgeProjectionRoute; projection: Exclude<TradingProjectionWrite, { resource: 'positions' | 'pending_orders' }> }
  | { route: TrustedBridgeProjectionRoute; projection: Extract<TradingProjectionWrite, { resource: 'positions' }>; tradeStates: BridgeExactTradeState[]; observedAt: string }
  | { route: TrustedBridgeProjectionRoute; projection: Extract<TradingProjectionWrite, { resource: 'pending_orders' }>; tradeStates: BridgeExactTradeState[]; observedAt: string }

export interface TrustedBridgeProjectionRepository {
  applyTrustedProjection(input: TrustedBridgeProjectionWrite): Promise<{ applied: boolean; absorbedReservationIds: string[] }>
}

export type TradingProjectionWrite =
  | { accountId: string; resource: 'account.metrics'; resourceId: 'current'; revision: number; data: AccountSnapshot }
  | { accountId: string; resource: 'market.quote'; resourceId: string; revision: number; data: MarketQuote }
  | { accountId: string; resource: 'market.candle'; resourceId: string; revision: number; data: MarketCandle }
  | { accountId: string; resource: 'positions'; resourceId: 'open'; revision: number; data: OpenPosition[] }
  | { accountId: string; resource: 'pending_orders'; resourceId: 'open'; revision: number; data: PendingOrder[] }

export interface BrowserRealtimePublisher {
  publish(event: TradingRealtimeEvent): void
}

export type BrowserRealtimeEventType =
  | 'runtime.bridge.changed' | 'account.metrics.changed' | 'market.quote.updated' | 'market.candle.updated'
  | 'market.candle.closed' | 'positions.changed' | 'pending_orders.changed'
  | 'analysis.job.changed' | 'market_analysis.created' | 'trader.job.changed' | 'trade_decision.created'
  | 'risk.policy.changed' | 'risk.summary.changed' | 'risk.decision.created' | 'risk.manual_release.changed'
  | 'review.case.changed' | 'strategy.memory.changed'
  | 'trade.history.changed'
  | 'market.macro.changed' | 'market.calendar.changed' | 'market.source_health.changed'
  | 'operation.changed' | 'audit.changed'

export type BrowserRealtimeResource = RealtimeResource
  | 'analysis.job' | 'market_analysis' | 'trader.job' | 'trade_decision'
  | 'risk.policy' | 'risk.summary' | 'risk.decision' | 'risk.manual_release' | 'operation'
  | 'review_case' | 'strategy_memory'
  | 'trade_history' | 'audit' | 'macro_snapshot' | 'calendar_event' | 'macro_source_health'

export interface BrowserRealtimeEvent {
  eventId: string
  type: BrowserRealtimeEventType
  occurredAt: string
  userId: number | null
  accountId: string | null
  terminalInstanceId: string | null
  resource: BrowserRealtimeResource
  resourceId: string
  revision: number
  data: unknown
}

export type TradingRealtimeEvent = BrowserRealtimeEvent & {
  type: 'runtime.bridge.changed' | 'account.metrics.changed' | 'market.quote.updated' | 'market.candle.updated'
    | 'market.candle.closed' | 'positions.changed' | 'pending_orders.changed'
  accountId: string
  userId: number
  resource: RealtimeResource
}
