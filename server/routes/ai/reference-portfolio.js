import { queryAll } from '../../db.js'
import { mt5Bridge } from './market-data.js'
import { stripBrokerSuffix } from './utils.js'

const SYSTEM_TRADE_MAGIC = 234000

function sameSymbol(value, expected) {
  return stripBrokerSuffix(String(value || '')).toUpperCase() === stripBrokerSuffix(String(expected || '')).toUpperCase()
}

function ticketKey(value) {
  return value == null ? '' : String(value).trim()
}

export async function loadPlatformReferencePortfolio({ strategyId, sourceUserId, symbol } = {}) {
  const [positionsResponse, pendingResponse, deliveries] = await Promise.all([
    mt5Bridge(sourceUserId, 'positions', { symbol }, { timeoutMs:5000, noFallback:true }),
    mt5Bridge(sourceUserId, 'pending_list', { symbol }, { timeoutMs:5000, noFallback:true }),
    queryAll(`SELECT deliveries.signal_id, deliveries.pending_ticket, deliveries.trade_ticket,
        signals.signal_type, signals.entry_method, signals.stop_loss_price,
        signals.take_profit_1_price, signals.created_at
      FROM auto_signal_deliveries deliveries
      JOIN ai_signals signals ON signals.id = deliveries.signal_id
      WHERE deliveries.user_id = ? AND deliveries.prompt_type_id = ?
      ORDER BY deliveries.id DESC LIMIT 200`, [Number(sourceUserId), Number(strategyId)]),
  ])
  if (positionsResponse?.status !== 'success' || !Array.isArray(positionsResponse.positions)) {
    throw new Error('reference_positions_unavailable')
  }
  const pendingOrders = pendingResponse?.orders ?? pendingResponse?.pending_list
  if (pendingResponse?.status !== 'success' || !Array.isArray(pendingOrders)) {
    throw new Error('reference_pending_unavailable')
  }

  const byTradeTicket = new Map()
  const byPendingTicket = new Map()
  for (const row of deliveries) {
    if (ticketKey(row.trade_ticket)) byTradeTicket.set(ticketKey(row.trade_ticket), row)
    if (ticketKey(row.pending_ticket)) byPendingTicket.set(ticketKey(row.pending_ticket), row)
  }
  const positions = positionsResponse.positions
    .filter(item => Number(item.magic || 0) === SYSTEM_TRADE_MAGIC && sameSymbol(item.symbol, symbol))
    .map(item => ({ item, delivery:byTradeTicket.get(ticketKey(item.ticket)) }))
    .filter(item => item.delivery)
    .map(({ item, delivery }) => ({
      reference_id:`signal:${Number(delivery.signal_id)}`,
      origin_signal_id:Number(delivery.signal_id),
      side:String(item.type || '').toLowerCase(),
      entry_price:Number(item.open_price ?? item.price_open ?? 0),
      current_price:Number(item.price_current || 0),
      stop_loss:Number(item.sl || delivery.stop_loss_price || 0) || null,
      take_profit:Number(item.tp || delivery.take_profit_1_price || 0) || null,
      opened_at:item.time || delivery.created_at || null,
    }))
  const pending = pendingOrders
    .filter(item => Number(item.magic || 0) === SYSTEM_TRADE_MAGIC && sameSymbol(item.symbol, symbol))
    .map(item => ({ item, delivery:byPendingTicket.get(ticketKey(item.ticket ?? item.mt5_ticket)) }))
    .filter(item => item.delivery)
    .map(({ item, delivery }) => ({
      reference_id:`signal:${Number(delivery.signal_id)}`,
      origin_signal_id:Number(delivery.signal_id),
      side:String(item.side || delivery.signal_type || '').toLowerCase().startsWith('buy') ? 'buy' : 'sell',
      pending_type:String(item.pending_type || delivery.signal_type || ''),
      trigger_price:Number(item.price || 0),
      stop_loss:Number(item.sl || delivery.stop_loss_price || 0) || null,
      take_profit:Number(item.tp || delivery.take_profit_1_price || 0) || null,
      valid_until:item.valid_until || null,
    }))
  return {
    role:'platform_strategy_reference_portfolio',
    strategy_id:Number(strategyId),
    symbol:stripBrokerSuffix(String(symbol || '')).toUpperCase(),
    positions,
    pending_orders:pending,
    position_count:positions.length,
    pending_count:pending.length,
    captured_at:new Date().toISOString(),
  }
}
