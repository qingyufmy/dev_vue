import type { BridgeProjectionInput, BridgeExactTradeState } from '../../trading/index.js'
import { BridgeGatewayError, type BridgeGatewayRoute } from '../domain/bridge-gateway.js'
import type { BridgeProjectionDecoder, BridgeStreamEventEnvelope } from './bridge-stream-ingestor.js'

export class BridgeTradeProjectionDecoder implements BridgeProjectionDecoder {
  async decode(route: BridgeGatewayRoute, event: BridgeStreamEventEnvelope): Promise<BridgeProjectionInput | null> {
    if (event.payload.stream !== 'positions' && event.payload.stream !== 'pending_orders') return null
    if (!event.payload.full_snapshot || event.payload.deletes.length !== 0) throw new BridgeGatewayError('bridge_trade_snapshot_invalid', 400)
    const observedAt = utc(event.payload.observed_at_utc_msc)
    if (event.payload.stream === 'positions') {
      const decoded = event.payload.upserts.map(item => position(route.accountId, event.payload.revision, item))
      uniqueTickets(decoded.map(value => value.exact.ticket))
      return { resource: 'positions', resourceId: 'open', revision: event.payload.revision,
        data: decoded.map(value => value.public), tradeStates: decoded.map(value => value.exact), observedAt }
    }
    const decoded = event.payload.upserts.map(item => pendingOrder(route.accountId, event.payload.revision, item))
    uniqueTickets(decoded.map(value => value.exact.ticket))
    return { resource: 'pending_orders', resourceId: 'open', revision: event.payload.revision,
      data: decoded.map(value => value.public), tradeStates: decoded.map(value => value.exact), observedAt }
  }
}

function position(accountId: string, revision: number, item: Record<string, unknown>) {
  exactKeys(item, ['ticket', 'symbol', 'direction', 'order_type', 'magic', 'volume', 'open_price', 'current_price', 'stop_limit_price', 'stop_loss', 'take_profit', 'expiration_utc_msc', 'profit', 'opened_at_utc_msc'], ['source', 'signal_id'])
  const exact = exactState(item, true)
  const currentPrice = decimal(item.current_price, 'current_price')
  const profit = signedDecimal(item.profit, 'profit')
  const openedAt = utc(integer(item.opened_at_utc_msc, 'opened_at_utc_msc'))
  return { exact, public: {
    ticket: exact.ticket, accountId, symbol: exact.symbol, side: exact.direction, volume: exact.volume,
    openPrice: exact.open_price, currentPrice, stopLoss: exact.stop_loss, takeProfit: exact.take_profit,
    floatingProfit: profit, openedAt, source: source(item.source), signalId: optionalId(item.signal_id), revision,
  } }
}

function pendingOrder(accountId: string, revision: number, item: Record<string, unknown>) {
  exactKeys(item, ['ticket', 'symbol', 'direction', 'order_type', 'magic', 'volume', 'open_price', 'stop_limit_price', 'stop_loss', 'take_profit', 'expiration_utc_msc', 'created_at_utc_msc'], ['source', 'signal_id'])
  const exact = exactState(item, false)
  if (exact.order_type === 'market') invalid('order_type')
  const createdAt = utc(integer(item.created_at_utc_msc, 'created_at_utc_msc'))
  return { exact, public: {
    ticket: exact.ticket, accountId, symbol: exact.symbol, type: exact.order_type, volume: exact.volume,
    price: exact.open_price, stopLoss: exact.stop_loss, takeProfit: exact.take_profit, createdAt,
    expiresAt: exact.expiration_utc_msc === null ? null : utc(exact.expiration_utc_msc),
    source: source(item.source), signalId: optionalId(item.signal_id), revision,
  } }
}

function exactState(item: Record<string, unknown>, positionState: boolean): BridgeExactTradeState {
  const orderType = text(item.order_type, 'order_type') as BridgeExactTradeState['order_type']
  if (!['market', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'].includes(orderType)) invalid('order_type')
  if (positionState && orderType !== 'market') invalid('order_type')
  const direction = text(item.direction, 'direction')
  if (direction !== 'buy' && direction !== 'sell') invalid('direction')
  return {
    ticket: ticket(item.ticket), symbol: symbol(item.symbol), direction, order_type: orderType,
    magic: integer(item.magic, 'magic', true, 2_147_483_647), volume: decimal(item.volume, 'volume'), open_price: decimal(item.open_price, 'open_price'),
    stop_limit_price: nullableDecimal(item.stop_limit_price, 'stop_limit_price'), stop_loss: nullableDecimal(item.stop_loss, 'stop_loss'),
    take_profit: nullableDecimal(item.take_profit, 'take_profit'),
    expiration_utc_msc: item.expiration_utc_msc === null ? null : integer(item.expiration_utc_msc, 'expiration_utc_msc'),
  }
}

function ticket(value: unknown) { const result = text(value, 'ticket'); if (!/^[1-9][0-9]{0,19}$/.test(result)) invalid('ticket'); return result }
function symbol(value: unknown) { const result = text(value, 'symbol'); if (!/^[A-Za-z0-9._-]{1,64}$/.test(result)) invalid('symbol'); return result }
function decimal(value: unknown, field: string) { const result = text(value, field); if (!/^(?:0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]+)?)$/.test(result)) invalid(field); return result }
function signedDecimal(value: unknown, field: string) { const result = text(value, field); if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(result)) invalid(field); return result }
function nullableDecimal(value: unknown, field: string) { return value === null ? null : decimal(value, field) }
function integer(value: unknown, field: string, allowZero = false, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1) || Number(value) > maximum) invalid(field)
  return Number(value)
}
function text(value: unknown, field: string) { if (typeof value !== 'string' || value.length < 1 || value.length > 128) invalid(field); return value }
function optionalId(value: unknown) { if (value === undefined || value === null) return null; return text(value, 'signal_id') }
function source(value: unknown): 'manual' | 'signal' | 'unknown' { return value === 'manual' || value === 'signal' ? value : 'unknown' }
function utc(value: number) { const result = new Date(value); if (!Number.isFinite(result.getTime())) invalid('utc_msc'); return result.toISOString() }
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[]) {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid('fields')
}
function uniqueTickets(tickets: string[]) { if (new Set(tickets).size !== tickets.length) invalid('ticket_duplicate') }
function invalid(field: string): never { throw new BridgeGatewayError(`bridge_trade_snapshot_${field}_invalid`, 400) }
