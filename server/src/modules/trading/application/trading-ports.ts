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

export type TradingProjectionWrite =
  | { accountId: string; resource: 'account.metrics'; resourceId: 'current'; revision: number; data: AccountSnapshot }
  | { accountId: string; resource: 'market.quote'; resourceId: string; revision: number; data: MarketQuote }
  | { accountId: string; resource: 'market.candle'; resourceId: string; revision: number; data: MarketCandle }
  | { accountId: string; resource: 'positions'; resourceId: 'open'; revision: number; data: OpenPosition[] }
  | { accountId: string; resource: 'pending_orders'; resourceId: 'open'; revision: number; data: PendingOrder[] }

export interface BrowserRealtimePublisher {
  publish(event: TradingRealtimeEvent): void
}

export interface TradingRealtimeEvent {
  eventId: string
  type: 'runtime.bridge.changed' | 'account.metrics.changed' | 'market.quote.updated' | 'market.candle.updated' | 'market.candle.closed' | 'positions.changed' | 'pending_orders.changed'
  occurredAt: string
  userId: number
  accountId: string
  terminalInstanceId: string | null
  resource: RealtimeResource
  resourceId: string
  revision: number
  data: unknown
}
