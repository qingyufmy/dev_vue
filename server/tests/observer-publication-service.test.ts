import { describe, expect, it, vi } from 'vitest'
import {
  ObserverPublicationService,
} from '../src/modules/trading/application/observer-publication-service.js'
import type { ObserverAccessReader, ObserverAuthorization } from '../src/modules/trading/application/observer-ports.js'
import type { TradingReadRepository } from '../src/modules/trading/application/trading-ports.js'
import type {
  AccountSnapshot, MarketCandle, MarketQuote, OpenPosition, PendingOrder, TradingAccountSummary,
} from '../src/modules/trading/domain/trading.js'

const startedAt = new Date('2026-09-05T08:00:00.000Z')

function authorization(overrides: Partial<ObserverAuthorization> = {}): ObserverAuthorization {
  return {
    userId: 9, channelId: '12', sourceId: '13', sourceRevision: '2', channelRevision: '3',
    accessRevision: '8', userTokenVersion: 1, accountId: '7', ownershipRevision: '4', operatorUserId: 42,
    displayName: '黄金观摩', expiresAtUtc: new Date(startedAt.getTime() + 30_000).toISOString(),
    ...overrides,
  }
}

function account(overrides: Record<string, unknown> = {}): TradingAccountSummary {
  return {
    id: '7', platform: 'mt5', login: 'private-login', server: 'private-server', currency: 'USD',
    terminalProfileId: 'private-profile', terminalInstanceId: 'private-instance', bridgeState: 'online',
    tradePermission: true, lastSeenAt: startedAt.toISOString(), ...overrides,
  } as TradingAccountSummary
}

function snapshot(overrides: Record<string, unknown> = {}): AccountSnapshot {
  return {
    ...account(), balance: '1000', equity: '1020', margin: '10', freeMargin: '1010', floatingProfit: '20',
    leverage: 100, timezoneOffsetMinutes: 180, clockStatus: 'calibrated', observedAt: startedAt.toISOString(),
    revision: 4, ...overrides,
  } as AccountSnapshot
}

function position(overrides: Record<string, unknown> = {}): OpenPosition {
  return {
    ticket: '123', accountId: '7', symbol: 'XAUUSD', side: 'buy', volume: '0.01', openPrice: '3500',
    currentPrice: '3510', stopLoss: null, takeProfit: null, floatingProfit: '10', openedAt: startedAt.toISOString(),
    source: 'signal', signalId: 'private-signal', revision: 4, ...overrides,
  } as OpenPosition
}

function pendingOrder(overrides: Record<string, unknown> = {}): PendingOrder {
  return {
    ticket: '456', accountId: '7', symbol: 'XAUUSD', type: 'buy_limit', volume: '0.01', price: '3490',
    stopLoss: null, takeProfit: null, createdAt: startedAt.toISOString(), expiresAt: null,
    source: 'signal', signalId: 'private-order-signal', revision: 4, ...overrides,
  } as PendingOrder
}

function quote(overrides: Record<string, unknown> = {}): MarketQuote {
  return {
    accountId: '7', symbol: 'XAUUSD', bid: '3500', ask: '3500.2', last: '3500.1', spread: '0.2',
    tradeMode: 'full', observedAt: startedAt.toISOString(), revision: 4, ...overrides,
  } as MarketQuote
}

function candle(overrides: Record<string, unknown> = {}): MarketCandle {
  return {
    accountId: '7', symbol: 'XAUUSD', timeframe: 'M5', openTime: startedAt.toISOString(), open: '3499',
    high: '3501', low: '3498', close: '3500', tickVolume: '12', closed: true, revision: 4, ...overrides,
  } as MarketCandle
}

function fixture(options: {
  currentAuthorization?: ObserverAuthorization | null
  sourceAccount?: TradingAccountSummary
  sourceSnapshot?: AccountSnapshot | null
  positions?: { revision: number; items: OpenPosition[] }
  pendingOrders?: { revision: number; items: PendingOrder[] }
  sourceQuote?: MarketQuote | null
  sourceCandles?: MarketCandle[]
  clock?: () => Date
} = {}) {
  let currentAuthorization: ObserverAuthorization | null = options.currentAuthorization === undefined ? authorization() : options.currentAuthorization
  const authorize = vi.fn(async () => currentAuthorization)
  const access: ObserverAccessReader = {
    authorize,
    list: async () => [],
  }
  const trading = {
    findOwnedAccount: vi.fn(async () => options.sourceAccount ?? account()),
    getAccountSnapshot: vi.fn(async () => options.sourceSnapshot === undefined ? snapshot() : options.sourceSnapshot),
    listSymbols: vi.fn(async () => ['XAUUSD']),
    listPositions: vi.fn(async () => options.positions ?? { revision: 4, items: [position()] }),
    listPendingOrders: vi.fn(async () => options.pendingOrders ?? { revision: 4, items: [pendingOrder()] }),
    getQuote: vi.fn(async () => options.sourceQuote === undefined ? quote() : options.sourceQuote),
    listCandles: vi.fn(async () => options.sourceCandles ?? [candle()]),
  } as unknown as TradingReadRepository
  const service = new ObserverPublicationService(access, trading, options.clock ?? (() => new Date(startedAt)))
  return {
    service, access, authorize, trading,
    setAuthorization(value: ObserverAuthorization | null) { currentAuthorization = value },
  }
}

function clock(values: Date[]) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]!
}

describe('ObserverPublicationService', () => {
  it('constructs a strict publication whitelist and drops arbitrary source fields', async () => {
    const f = fixture({
      sourceAccount: account({ privateCredential: 'secret-account' }),
      sourceSnapshot: snapshot({ privateCredential: 'secret-snapshot' }),
      positions: { revision: 4, items: [position({ privateCredential: 'secret-position' })] },
      pendingOrders: { revision: 4, items: [pendingOrder({ privateCredential: 'secret-order' })] },
    })

    const result = await f.service.workspace(9, '7', '12')
    expect(result.account).toEqual({
      id: '7', platform: 'mt5', login: '观摩账户', server: '已隐藏', currency: 'USD',
      terminalProfileId: null, terminalInstanceId: null, bridgeState: 'offline', tradePermission: false, lastSeenAt: null,
    })
    expect(result.snapshot).toEqual({
      id: '7', platform: 'mt5', login: '观摩账户', server: '已隐藏', currency: 'USD',
      terminalProfileId: null, terminalInstanceId: null, bridgeState: 'offline', tradePermission: false, lastSeenAt: null,
      balance: '1000', equity: '1020', margin: '10', freeMargin: '1010', floatingProfit: '20', leverage: 100,
      timezoneOffsetMinutes: 180, clockStatus: 'calibrated', observedAt: startedAt.toISOString(), revision: 4,
    })
    expect(result.positions.items[0]).toEqual({
      ticket: '123', accountId: '7', symbol: 'XAUUSD', side: 'buy', volume: '0.01', openPrice: '3500',
      currentPrice: '3510', stopLoss: null, takeProfit: null, floatingProfit: '10', openedAt: startedAt.toISOString(),
      source: 'unknown', signalId: null, revision: 4,
    })
    expect(result.pendingOrders.items[0]).toEqual({
      ticket: '456', accountId: '7', symbol: 'XAUUSD', type: 'buy_limit', volume: '0.01', price: '3490',
      stopLoss: null, takeProfit: null, createdAt: startedAt.toISOString(), expiresAt: null,
      source: 'unknown', signalId: null, revision: 4,
    })
    expect(JSON.stringify(result)).not.toContain('secret-')
  })

  it('rejects a private collection item carrying another account id', async () => {
    const f = fixture({ positions: { revision: 4, items: [position({ accountId: '8' })] } })
    await expect(f.service.workspace(9, '7', '12')).rejects.toMatchObject({ code: 'trading_account_forbidden' })
  })

  it('rejects when the initial authorization read crosses its expiry', async () => {
    const f = fixture({ clock: clock([startedAt, new Date(startedAt.getTime() + 30_001)]) })
    await expect(f.service.account(9, '7', '12')).rejects.toMatchObject({ code: 'trading_account_forbidden' })
    expect(f.trading.findOwnedAccount).not.toHaveBeenCalled()
  })

  it('rejects when the final authorization recheck crosses the initial expiry', async () => {
    const f = fixture({ clock: clock([
      startedAt, startedAt, startedAt, new Date(startedAt.getTime() + 30_001),
    ]) })
    await expect(f.service.account(9, '7', '12')).rejects.toMatchObject({ code: 'trading_account_forbidden' })
    expect(f.authorize).toHaveBeenCalledTimes(2)
  })

  it('rejects a grant revoked during publication', async () => {
    const f = fixture()
    f.authorize.mockResolvedValueOnce(authorization()).mockResolvedValueOnce(null)
    await expect(f.service.account(9, '7', '12')).rejects.toMatchObject({ code: 'trading_account_forbidden' })
  })

  it('rejects an ownership revision change during publication', async () => {
    const f = fixture()
    f.authorize.mockResolvedValueOnce(authorization()).mockResolvedValueOnce(authorization({ ownershipRevision: '5' }))
    await expect(f.service.account(9, '7', '12')).rejects.toMatchObject({ code: 'trading_account_forbidden' })
  })

  it('also whitelists market publication rows', async () => {
    const f = fixture({
      sourceQuote: quote({ privateCredential: 'secret-quote' }),
      sourceCandles: [candle({ privateCredential: 'secret-candle' })],
    })
    await expect(f.service.quote(9, '7', 'XAUUSD', '12')).resolves.toEqual({
      accountId: '7', symbol: 'XAUUSD', bid: '3500', ask: '3500.2', last: '3500.1', spread: '0.2',
      tradeMode: 'full', observedAt: startedAt.toISOString(), revision: 4,
    })
    await expect(f.service.candles(9, '7', 'XAUUSD', 'M5', 20, '12')).resolves.toEqual([{
      accountId: '7', symbol: 'XAUUSD', timeframe: 'M5', openTime: startedAt.toISOString(), open: '3499', high: '3501',
      low: '3498', close: '3500', tickVolume: '12', closed: true, revision: 4,
    }])
  })
})
