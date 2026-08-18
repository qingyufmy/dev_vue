import { stripBrokerSuffix } from './utils.js'

export const SYSTEM_ORDER_MAGIC = 234000
export const DEFAULT_DEDUP_PRICE_ATR = 0.05

function text(value) {
  return String(value ?? '').trim()
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function normalizeLivePendingSymbol(value) {
  return stripBrokerSuffix(text(value)).toUpperCase()
}

export function normalizeLivePendingDirection(value) {
  const raw = text(value).toLowerCase()
  if (raw.startsWith('buy')) return 'buy'
  if (raw.startsWith('sell')) return 'sell'
  return ''
}

export function normalizeLivePendingType(value = {}, fallback = null) {
  const item = value && typeof value === 'object' ? value : {}
  const direct = text(item.pending_type || item.order_type || item.type || item.side).toLowerCase()
  if (direct.startsWith('buy_') || direct.startsWith('sell_')) return direct
  const direction = normalizeLivePendingDirection(item.order_type || item.side || fallback)
  const entryMethod = text(item.entry_method || item.pending_method).toLowerCase()
  if (direction && ['limit', 'stop', 'stop_limit'].includes(entryMethod)) {
    return `${direction}_${entryMethod}`
  }
  if (direct === 'limit' || direct === 'stop' || direct === 'stop_limit') {
    return direction ? `${direction}_${direct}` : direct
  }
  return direct
}

export function livePendingPrice(item = {}) {
  const values = [
    item.price,
    item.price_open,
    item.limit_price,
    item.trigger_price,
    item.stoplimit_price,
    item.stop_limit_price,
  ]
  for (const value of values) {
    const number = finite(value)
    if (number !== null && number > 0) return number
  }
  return null
}

export function livePendingPriceTolerance({ atrAnchor = null, dedupPriceAtr = DEFAULT_DEDUP_PRICE_ATR,
  tickSize = null, point = null } = {}) {
  const atr = finite(atrAnchor)
  const atrMultiplier = finite(dedupPriceAtr)
  const tick = Math.max(finite(tickSize) || 0, finite(point) || 0)
  const atrDistance = atr !== null && atr > 0 && atrMultiplier !== null && atrMultiplier > 0
    ? atr * atrMultiplier : 0
  // A missing ATR must still retain a broker price-step floor.  Do not use a
  // fixed symbol-specific number: the instrument metadata is terminal-owned.
  return Math.max(atrDistance, tick, Number.EPSILON)
}

function normalizedTicket(value) {
  const ticket = text(value)
  return ticket || null
}

function deliveryOwnsPending(delivery, ticket, { userId = null, tradingAccountId = null,
  strategyId = null } = {}) {
  if (!delivery) return false
  const lineageTickets = [delivery.pending_ticket, delivery.trade_ticket,
    delivery.outcome_pending_ticket, delivery.outcome_trade_ticket]
    .map(normalizedTicket).filter(Boolean)
  if (!lineageTickets.includes(ticket)) return false
  const userIds = [delivery.delivery_user_id, delivery.user_id,
    delivery.intent_user_id, delivery.outcome_user_id]
    .map(Number).filter(id => Number.isInteger(id) && id > 0)
  if (Number(userId) <= 0 || !userIds.length || userIds.some(id => id !== Number(userId))) return false
  const strategyIds = [delivery.prompt_type_id, delivery.outcome_strategy_id]
    .map(Number).filter(id => Number.isInteger(id) && id > 0)
  if (Number(strategyId) <= 0 || !strategyIds.length
    || strategyIds.some(id => id !== Number(strategyId))) return false
  const accountIds = [delivery.intent_trading_account_id, delivery.outcome_trading_account_id,
    delivery.delivery_trading_account_id].map(Number).filter(id => Number.isInteger(id) && id > 0)
  if (Number(tradingAccountId) <= 0 || !accountIds.length
    || accountIds.some(id => id !== Number(tradingAccountId))) return false
  return true
}

export function findDuplicateLivePending({ pendingOrders = [], request = {}, strategyDeliveries = [],
  userId = null, tradingAccountId = null, strategyId = null, instrument = null,
  dedupPriceAtr = DEFAULT_DEDUP_PRICE_ATR, excludedTickets = [] } = {}) {
  const expectedSymbol = normalizeLivePendingSymbol(request.symbol)
  const expectedDirection = normalizeLivePendingDirection(request.order_type || request.signal_type)
  const expectedType = normalizeLivePendingType(request)
  const expectedPrice = finite(request.limit_price || request.price || request.entry_price)
  if (!expectedSymbol || !expectedDirection || !expectedType || expectedPrice === null) return null
  const excluded = new Set((Array.isArray(excludedTickets) ? excludedTickets : [...(excludedTickets || [])])
    .map(normalizedTicket).filter(Boolean))
  const tolerance = livePendingPriceTolerance({
    atrAnchor:request.atr_anchor,
    dedupPriceAtr,
    tickSize:instrument?.tick_size ?? instrument?.tick_size_raw_marketinfo,
    point:instrument?.point,
  })
  const deliveries = Array.isArray(strategyDeliveries) ? strategyDeliveries : []
  for (const pending of Array.isArray(pendingOrders) ? pendingOrders : []) {
    const ticket = normalizedTicket(pending.ticket ?? pending.mt5_ticket ?? pending.order_ticket)
    if (!ticket || excluded.has(ticket)) continue
    if (Number(pending.magic || 0) !== SYSTEM_ORDER_MAGIC) continue
    if (normalizeLivePendingSymbol(pending.symbol) !== expectedSymbol) continue
    if (normalizeLivePendingDirection(pending.side || pending.pending_type || pending.order_type || pending.type)
      !== expectedDirection) continue
    if (normalizeLivePendingType(pending) !== expectedType) continue
    const currentPrice = livePendingPrice(pending)
    if (currentPrice === null || Math.abs(currentPrice - expectedPrice) > tolerance) continue
    const owner = deliveries.find(delivery => deliveryOwnsPending(delivery, ticket, {
      userId, tradingAccountId, strategyId,
    }))
    if (!owner) continue
    return {
      ticket,
      symbol:normalizeLivePendingSymbol(pending.symbol),
      direction:expectedDirection,
      pending_type:expectedType,
      existing_price:currentPrice,
      requested_price:expectedPrice,
      price_distance:Math.abs(currentPrice - expectedPrice),
      price_tolerance:tolerance,
      // Keep the compact, safe execution-detail keys so the conflict survives
      // buildSafeExecutionOutcome/audit sanitization as an actionable record.
      current:currentPrice,
      limit:tolerance,
      trigger_price:expectedPrice,
      magic:SYSTEM_ORDER_MAGIC,
      owner_delivery_id:owner.delivery_id || owner.id || null,
      owner_signal_id:owner.signal_id || null,
      strategy_id:Number(strategyId) || null,
      trading_account_id:Number(tradingAccountId) || null,
    }
  }
  return null
}

export class DuplicateLivePendingError extends Error {
  constructor(details = {}) {
    super('duplicate_live_pending')
    this.name = 'DuplicateLivePendingError'
    this.reason = 'duplicate_live_pending'
    this.code = 'duplicate_live_pending'
    this.classification = 'risk_rejection'
    this.details = details
  }
}
