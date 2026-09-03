export type TradingPlatform = 'mt4' | 'mt5'
export type TradingMode = 'full' | 'observer' | 'blocked'
export type Timeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1'

export interface TradingContext {
  userId: number
  mode: TradingMode
  accountId: string | null
  observerChannelId: string | null
  readOnly: boolean
  revision: number
}

export interface TradingAccountSummary {
  id: string
  platform: TradingPlatform
  login: string
  server: string
  currency: string
  terminalProfileId: string
  terminalInstanceId: string | null
  bridgeState: 'online' | 'offline' | 'paused' | 'replaced' | 'unauthorized'
  tradePermission: boolean
  lastSeenAt: string | null
}

export interface TerminalProfileSummary {
  id: string
  displayName: string
  platform: TradingPlatform
  installationId: string
  accountId: string | null
  connectionState: 'online' | 'offline' | 'paused'
  lastSeenAt: string | null
}

export interface ObserverChannelSummary {
  id: string
  displayName: string
  sourceAccountId: string
  active: boolean
}

export interface AccountSnapshot extends TradingAccountSummary {
  balance: string
  equity: string
  margin: string
  freeMargin: string
  floatingProfit: string
  leverage: number | null
  timezoneOffsetMinutes: number | null
  clockStatus: 'calibrated' | 'observer_bootstrap' | 'stale' | 'unavailable'
  observedAt: string
  revision: number
}

export interface MarketQuote {
  accountId: string
  symbol: string
  bid: string
  ask: string
  last: string | null
  spread: string
  tradeMode: 'full' | 'long_only' | 'short_only' | 'close_only' | 'disabled' | 'unknown'
  observedAt: string
  revision: number
}

export interface MarketCandle {
  accountId: string
  symbol: string
  timeframe: Timeframe
  openTime: string
  open: string
  high: string
  low: string
  close: string
  tickVolume: string
  closed: boolean
  revision: number
}

export interface OpenPosition {
  ticket: string
  accountId: string
  symbol: string
  side: 'buy' | 'sell'
  volume: string
  openPrice: string
  currentPrice: string
  stopLoss: string | null
  takeProfit: string | null
  floatingProfit: string
  openedAt: string
  source: 'manual' | 'signal' | 'unknown'
  signalId: string | null
  revision: number
}

export interface PendingOrder {
  ticket: string
  accountId: string
  symbol: string
  type: 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop' | 'buy_stop_limit' | 'sell_stop_limit'
  volume: string
  price: string
  stopLoss: string | null
  takeProfit: string | null
  createdAt: string
  expiresAt: string | null
  source: 'manual' | 'signal' | 'unknown'
  signalId: string | null
  revision: number
}

export type RealtimeResource = 'runtime.bridge' | 'account.metrics' | 'market.quote' | 'market.candle' | 'positions' | 'pending_orders'

export class TradingAccessError extends Error {
  constructor(
    readonly code: 'trading_account_not_found' | 'trading_account_forbidden' | 'trading_context_invalid' | 'bridge_capacity_exceeded' | 'revision_conflict',
    readonly status: number,
  ) {
    super(code)
    this.name = 'TradingAccessError'
  }
}

export function assertOpaqueId(value: string, field = 'id') {
  const normalized = String(value ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(normalized)) {
    throw new TradingAccessError('trading_context_invalid', 400)
  }
  return normalized
}

export function assertSymbol(value: string) {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9._-]{1,64}$/.test(normalized)) throw new TradingAccessError('trading_context_invalid', 400)
  return normalized
}
