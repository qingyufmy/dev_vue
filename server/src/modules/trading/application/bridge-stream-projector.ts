import { randomUUID } from 'node:crypto'
import type { BridgeExactTradeState, BrowserRealtimePublisher, TradingProjectionWrite, TradingRealtimeEvent, TrustedBridgeProjectionRepository, TrustedBridgeProjectionRoute } from './trading-ports.js'
import { TradingAccessError, type RealtimeResource } from '../domain/trading.js'

type WithoutAccount<T> = T extends unknown ? Omit<T, 'accountId'> : never
type ProjectionPayload = WithoutAccount<TradingProjectionWrite>
export type BridgeProjectionInput =
  | Exclude<ProjectionPayload, { resource: 'positions' | 'pending_orders' }>
  | (Extract<ProjectionPayload, { resource: 'positions' | 'pending_orders' }> & { tradeStates: BridgeExactTradeState[]; observedAt: string })

export class BridgeStreamProjector {
  constructor(
    private readonly repository: TrustedBridgeProjectionRepository,
    private readonly publisher: BrowserRealtimePublisher,
    private readonly now = () => new Date(),
  ) {}

  async ingest(route: TrustedBridgeProjectionRoute, input: BridgeProjectionInput) {
    const { userId, accountId, terminalInstanceId } = route
    if (!Number.isSafeInteger(input.revision) || input.revision <= 0 || !belongsToAccount(accountId, input)) {
      throw new TradingAccessError('trading_context_invalid', 400)
    }
    if ((input.resource === 'positions' || input.resource === 'pending_orders')
      && (!Number.isFinite(Date.parse(input.observedAt)) || !tradeStatesMatch(input.data, input.tradeStates))) {
      throw new TradingAccessError('trading_context_invalid', 400)
    }
    const projection = { ...input, accountId } as TradingProjectionWrite
    const write = input.resource === 'positions' || input.resource === 'pending_orders'
      ? { route, projection, tradeStates: input.tradeStates, observedAt: input.observedAt }
      : { route, projection }
    const applied = await this.repository.applyTrustedProjection(write as import('./trading-ports.js').TrustedBridgeProjectionWrite)
    if (!applied.applied) return false
    const event: TradingRealtimeEvent = {
      eventId: randomUUID(), type: eventType(input.resource, input), occurredAt: this.now().toISOString(),
      userId, accountId, terminalInstanceId, resource: input.resource, resourceId: input.resourceId,
      revision: input.revision, data: realtimeData(input),
    }
    this.publisher.publish(event)
    return true
  }
}

function tradeStatesMatch(items: Array<{ ticket: string }>, states: BridgeExactTradeState[]) {
  if (items.length !== states.length) return false
  const tickets = new Set(items.map(item => item.ticket))
  return states.every(state => tickets.has(state.ticket) && validTradeState(state))
}

function validTradeState(state: BridgeExactTradeState) {
  const decimal = (value: unknown) => typeof value === 'string' && /^(?:0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]+)?)$/.test(value)
  const nullableDecimal = (value: unknown) => value === null || decimal(value)
  return /^[1-9][0-9]{0,19}$/.test(state.ticket)
    && /^[A-Za-z0-9._-]{1,64}$/.test(state.symbol)
    && (state.direction === 'buy' || state.direction === 'sell')
    && ['market', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'].includes(state.order_type)
    && Number.isSafeInteger(state.magic) && state.magic >= 0 && state.magic <= 2_147_483_647
    && decimal(state.volume) && decimal(state.open_price) && nullableDecimal(state.stop_limit_price)
    && nullableDecimal(state.stop_loss) && nullableDecimal(state.take_profit)
    && (state.expiration_utc_msc === null || Number.isSafeInteger(state.expiration_utc_msc) && state.expiration_utc_msc > 0)
}

function belongsToAccount(accountId: string, input: BridgeProjectionInput) {
  switch (input.resource) {
    case 'account.metrics': return input.data.id === accountId
    case 'market.quote': return input.data.accountId === accountId && input.resourceId === input.data.symbol
    case 'market.candle': return input.data.accountId === accountId && input.resourceId === `${input.data.symbol}:${input.data.timeframe}`
    case 'positions': return input.data.every((value) => value.accountId === accountId)
    case 'pending_orders': return input.data.every((value) => value.accountId === accountId)
  }
}

function realtimeData(input: BridgeProjectionInput): unknown {
  switch (input.resource) {
    case 'account.metrics': return { balance: input.data.balance, equity: input.data.equity, margin: input.data.margin, free_margin: input.data.freeMargin, floating_profit: input.data.floatingProfit, currency: input.data.currency, observed_at: input.data.observedAt }
    case 'market.quote': return { symbol: input.data.symbol, bid: input.data.bid, ask: input.data.ask, last: input.data.last, spread: input.data.spread, observed_at: input.data.observedAt }
    case 'market.candle': return { symbol: input.data.symbol, timeframe: input.data.timeframe, open_time: input.data.openTime, open: input.data.open, high: input.data.high, low: input.data.low, close: input.data.close, tick_volume: input.data.tickVolume, closed: input.data.closed }
    case 'positions': return { items: input.data.map((value) => ({ ticket: value.ticket, account_id: value.accountId, symbol: value.symbol, side: value.side, volume: value.volume, open_price: value.openPrice, current_price: value.currentPrice, stop_loss: value.stopLoss, take_profit: value.takeProfit, floating_profit: value.floatingProfit, opened_at: value.openedAt, source: value.source, signal_id: value.signalId, revision: String(value.revision) })) }
    case 'pending_orders': return { items: input.data.map((value) => ({ ticket: value.ticket, account_id: value.accountId, symbol: value.symbol, type: value.type, volume: value.volume, price: value.price, stop_loss: value.stopLoss, take_profit: value.takeProfit, created_at: value.createdAt, expires_at: value.expiresAt, source: value.source, signal_id: value.signalId, revision: String(value.revision) })) }
  }
}

function eventType(resource: RealtimeResource, input: BridgeProjectionInput): TradingRealtimeEvent['type'] {
  if (resource === 'market.candle') return input.resource === 'market.candle' && input.data.closed ? 'market.candle.closed' : 'market.candle.updated'
  return ({
    'account.metrics': 'account.metrics.changed', 'market.quote': 'market.quote.updated',
    positions: 'positions.changed', pending_orders: 'pending_orders.changed',
    'runtime.bridge': 'runtime.bridge.changed',
  } as const)[resource]
}
