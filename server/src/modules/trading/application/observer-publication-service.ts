import {
  assertOpaqueId, assertSymbol, TradingAccessError,
  type AccountSnapshot, type MarketCandle, type MarketQuote, type OpenPosition, type PendingOrder,
  type Timeframe, type TradingAccountSummary,
} from '../domain/trading.js'
import type { TradingReadRepository } from './trading-ports.js'
import {
  sameObserverAuthorization, type ObserverAccessReader, type ObserverAuthorization,
} from './observer-ports.js'

const TIMEFRAMES = new Set<Timeframe>(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'])

export class ObserverPublicationService {
  constructor(
    private readonly access: ObserverAccessReader,
    private readonly trading: TradingReadRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async workspace(userId: number, accountId: string, channelId: string) {
    const startedAt = this.requestNow()
    const authorization = await this.authorize(userId, accountId, channelId, startedAt)
    const account = await this.trading.findOwnedAccount(authorization.operatorUserId, authorization.accountId)
    if (!account) throw forbidden()
    const [snapshot, symbols, positions, pendingOrders] = await Promise.all([
      this.trading.getAccountSnapshot(authorization.accountId, authorization.operatorUserId),
      this.trading.listSymbols(authorization.accountId),
      this.trading.listPositions(authorization.accountId, authorization.operatorUserId),
      this.trading.listPendingOrders(authorization.accountId, authorization.operatorUserId),
    ])
    const publishedAccount = this.publicAccount(account, authorization)
    const publishedSnapshot = snapshot === null ? null : this.publicSnapshot(snapshot, authorization)
    const publishedPositions = this.publicPositions(positions, authorization)
    const publishedOrders = this.publicOrders(pendingOrders, authorization)
    await this.reauthorize(authorization, startedAt)
    return {
      account: publishedAccount,
      snapshot: publishedSnapshot,
      symbols: [...symbols],
      positions: publishedPositions,
      pendingOrders: publishedOrders,
    }
  }

  async quote(userId: number, accountId: string, symbol: string, channelId: string): Promise<MarketQuote | null> {
    const startedAt = this.requestNow()
    const authorization = await this.authorize(userId, accountId, channelId, startedAt)
    const quote = await this.trading.getQuote(authorization.accountId, assertSymbol(symbol))
    const published = quote === null ? null : this.publicQuote(quote, authorization)
    await this.reauthorize(authorization, startedAt)
    return published
  }

  async candles(userId: number, accountId: string, symbol: string, timeframe: Timeframe, limit: number, channelId: string): Promise<MarketCandle[]> {
    const startedAt = this.requestNow()
    const authorization = await this.authorize(userId, accountId, channelId, startedAt)
    if (!TIMEFRAMES.has(timeframe)) throw invalid()
    if (!Number.isFinite(limit)) throw invalid()
    const rows = await this.trading.listCandles(authorization.accountId, assertSymbol(symbol), timeframe, Math.max(1, Math.min(500, Math.trunc(limit))))
    const published = rows.map(row => this.publicCandle(row, authorization))
    await this.reauthorize(authorization, startedAt)
    return published
  }

  async account(userId: number, accountId: string, channelId: string): Promise<TradingAccountSummary> {
    const startedAt = this.requestNow()
    const authorization = await this.authorize(userId, accountId, channelId, startedAt)
    const sourceAccount = await this.trading.findOwnedAccount(authorization.operatorUserId, authorization.accountId)
    if (!sourceAccount) throw forbidden()
    const published = this.publicAccount(sourceAccount, authorization)
    await this.reauthorize(authorization, startedAt)
    return published
  }

  private requestNow() {
    const value = this.now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw forbidden()
    return value
  }

  private async authorize(userId: number, accountId: string, channelId: string, startedAt: Date): Promise<ObserverAuthorization> {
    const normalizedAccountId = assertOpaqueId(accountId, 'account_id')
    const normalizedChannelId = assertOpaqueId(channelId, 'observer_channel_id')
    const authorization = await this.access.authorize(userId, normalizedChannelId, normalizedAccountId)
    const checkedAt = this.requestNow()
    if (!authorization || authorization.userId !== userId || !sameId(authorization.accountId, normalizedAccountId)
      || !sameId(authorization.channelId, normalizedChannelId) || !isExpiryAfter(authorization.expiresAtUtc, startedAt)
      || !isExpiryAfter(authorization.expiresAtUtc, checkedAt)) throw forbidden()
    return authorization
  }

  private async reauthorize(initial: ObserverAuthorization, startedAt: Date) {
    const before = this.requestNow()
    if (!isExpiryAfter(initial.expiresAtUtc, before)) throw forbidden()
    const current = await this.access.authorize(initial.userId, initial.channelId, initial.accountId)
    const finishedAt = this.requestNow()
    if (!current || current.userId !== initial.userId || !sameObserverAuthorization(initial, current)
      || !isExpiryAfter(initial.expiresAtUtc, finishedAt) || !isExpiryAfter(current.expiresAtUtc, startedAt)
      || !isExpiryAfter(current.expiresAtUtc, finishedAt)) throw forbidden()
  }

  private publicAccount(value: TradingAccountSummary, authorization: ObserverAuthorization): TradingAccountSummary {
    if (value.id !== authorization.accountId) throw forbidden()
    return {
      id: authorization.accountId,
      platform: value.platform,
      login: '观摩账户',
      server: '已隐藏',
      currency: value.currency,
      terminalProfileId: null,
      terminalInstanceId: null,
      bridgeState: 'offline',
      tradePermission: false,
      lastSeenAt: null,
    }
  }

  private publicSnapshot(value: AccountSnapshot, authorization: ObserverAuthorization): AccountSnapshot {
    if (value.id !== authorization.accountId) throw forbidden()
    return {
      id: authorization.accountId,
      platform: value.platform,
      login: '观摩账户',
      server: '已隐藏',
      currency: value.currency,
      terminalProfileId: null,
      terminalInstanceId: null,
      bridgeState: 'offline',
      tradePermission: false,
      lastSeenAt: null,
      balance: value.balance,
      equity: value.equity,
      margin: value.margin,
      freeMargin: value.freeMargin,
      floatingProfit: value.floatingProfit,
      leverage: value.leverage,
      timezoneOffsetMinutes: value.timezoneOffsetMinutes,
      clockStatus: value.clockStatus,
      observedAt: value.observedAt,
      revision: value.revision,
    }
  }

  private publicQuote(value: MarketQuote, authorization: ObserverAuthorization): MarketQuote {
    if (value.accountId !== authorization.accountId) throw forbidden()
    return {
      accountId: authorization.accountId,
      symbol: value.symbol,
      bid: value.bid,
      ask: value.ask,
      last: value.last,
      spread: value.spread,
      tradeMode: value.tradeMode,
      observedAt: value.observedAt,
      revision: value.revision,
    }
  }

  private publicCandle(value: MarketCandle, authorization: ObserverAuthorization): MarketCandle {
    if (value.accountId !== authorization.accountId) throw forbidden()
    return {
      accountId: authorization.accountId,
      symbol: value.symbol,
      timeframe: value.timeframe,
      openTime: value.openTime,
      open: value.open,
      high: value.high,
      low: value.low,
      close: value.close,
      tickVolume: value.tickVolume,
      closed: value.closed,
      revision: value.revision,
    }
  }

  private publicPositions(value: { revision: number; items: OpenPosition[] }, authorization: ObserverAuthorization) {
    return {
      revision: value.revision,
      items: value.items.map(item => {
        if (item.accountId !== authorization.accountId) throw forbidden()
        return {
          ticket: item.ticket,
          accountId: authorization.accountId,
          symbol: item.symbol,
          side: item.side,
          volume: item.volume,
          openPrice: item.openPrice,
          currentPrice: item.currentPrice,
          stopLoss: item.stopLoss,
          takeProfit: item.takeProfit,
          floatingProfit: item.floatingProfit,
          openedAt: item.openedAt,
          source: 'unknown' as const,
          signalId: null,
          revision: item.revision,
        }
      }),
    }
  }

  private publicOrders(value: { revision: number; items: PendingOrder[] }, authorization: ObserverAuthorization) {
    return {
      revision: value.revision,
      items: value.items.map(item => {
        if (item.accountId !== authorization.accountId) throw forbidden()
        return {
          ticket: item.ticket,
          accountId: authorization.accountId,
          symbol: item.symbol,
          type: item.type,
          volume: item.volume,
          price: item.price,
          stopLoss: item.stopLoss,
          takeProfit: item.takeProfit,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
          source: 'unknown' as const,
          signalId: null,
          revision: item.revision,
        }
      }),
    }
  }
}

function isExpiryAfter(value: string, reference: Date) {
  const expiry = Date.parse(value)
  return Number.isFinite(expiry) && expiry > reference.getTime()
}

function sameId(left: string, right: string) { return left === right }
function forbidden() { return new TradingAccessError('trading_account_forbidden', 403) }
function invalid() { return new TradingAccessError('trading_context_invalid', 400) }
