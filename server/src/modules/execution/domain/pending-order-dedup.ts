import { ExecutionError } from './execution.js'

type PendingType = 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop' | 'buy_stop_limit' | 'sell_stop_limit'
interface StrategyScope { userId: number; accountId: string; strategyId: string }
export interface PendingDedupRequest {
  scope: StrategyScope
  instrumentId: string
  type: PendingType
  price: string
  atrAnchor: string | null
  atrMultiplier: string
  tickSize: string
  point: string
}
export interface PendingDedupOrder {
  ticket: string
  instrumentId: string
  type: PendingType
  price: string
  /** Supplied only after delivery/intent ownership lineage is verified. Magic alone is not ownership. */
  verifiedOrigin: StrategyScope | null
}

const unit = 10n ** 18n
const pendingTypes = new Set(['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'])
function decimal(value: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(value)) throw new ExecutionError('execution_dedup_decimal_invalid', 409)
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole!) * unit + BigInt(fraction.padEnd(18, '0'))
}
function validScope(scope: StrategyScope) {
  return Number.isSafeInteger(scope.userId) && scope.userId > 0 && typeof scope.accountId === 'string' && scope.accountId.length > 0
    && typeof scope.strategyId === 'string' && scope.strategyId.length > 0
}

/** Pure comparison over a complete, current account snapshot. No time-window expiry of live orders. */
export function findDuplicatePendingOrder(request: PendingDedupRequest, orders: readonly PendingDedupOrder[]): string | null {
  if (!validScope(request.scope) || !request.instrumentId) throw new ExecutionError('execution_dedup_scope_invalid', 409)
  if (!pendingTypes.has(request.type)) throw new ExecutionError('execution_dedup_parameters_invalid', 409)
  const price = decimal(request.price), tick = decimal(request.tickSize), point = decimal(request.point)
  const multiplier = decimal(request.atrMultiplier)
  if (price <= 0n || (tick <= 0n && point <= 0n) || multiplier > 5n * unit) throw new ExecutionError('execution_dedup_parameters_invalid', 409)
  const atr = request.atrAnchor === null ? 0n : decimal(request.atrAnchor)
  // Compare at scale 36 so ATR multiplication never loses precision through rounding.
  const atrDistance = atr * multiplier
  const tickDistance = (tick > point ? tick : point) * unit
  const tolerance = atrDistance > tickDistance ? atrDistance : tickDistance
  for (const order of orders) {
    const origin = order.verifiedOrigin
    if (!origin || !validScope(origin) || origin.userId !== request.scope.userId || origin.accountId !== request.scope.accountId
      || origin.strategyId !== request.scope.strategyId || order.instrumentId !== request.instrumentId || order.type !== request.type) continue
    if (!order.ticket) throw new ExecutionError('execution_dedup_ticket_invalid', 409)
    const current = decimal(order.price)
    if (current <= 0n) throw new ExecutionError('execution_dedup_parameters_invalid', 409)
    const distance = (current > price ? current - price : price - current) * unit
    if (distance <= tolerance) return order.ticket
  }
  return null
}
