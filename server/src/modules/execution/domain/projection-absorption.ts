import type { BridgeExactTradeState } from '../../trading/application/trading-ports.js'

export function projectionProvesCommandResult(input: {
  action: string
  entityKind: 'position' | 'pending_order'
  params: Record<string, unknown>
  expectedState?: Pick<BridgeExactTradeState, 'volume'> | null
  result: Record<string, unknown> | null
  states: Map<string, BridgeExactTradeState>
}) {
  const { action, entityKind, params, expectedState, result, states } = input
  const target = typeof params.ticket === 'string' ? params.ticket : null
  if (action === 'order.place') return resultTickets(result).some(ticket => states.has(ticket))
  if (!target) return false
  if (action === 'position.close') {
    if (entityKind !== 'position') return false
    if (params.volume === undefined) return !states.has(target)
    const remaining = subtractDecimal(expectedState?.volume, params.volume)
    if (remaining === null) return false
    if (remaining.units === 0n) return !states.has(target)
    const state = states.get(target)
    return Boolean(state && decimalEquals(state.volume, remaining))
  }
  if (action === 'pending_order.cancel') return entityKind === 'pending_order' && !states.has(target)
  const state = states.get(target)
  if (!state) return false
  if (action === 'position.protection.set' && entityKind === 'position') return fieldsApplied(state, params, ['stop_loss', 'take_profit'])
  if (action === 'pending_order.modify' && entityKind === 'pending_order') {
    return fieldsApplied(state, params, ['open_price', 'stop_limit_price', 'stop_loss', 'take_profit', 'expiration_utc_msc'], { price: 'open_price' })
  }
  return false
}

function subtractDecimal(left: unknown, right: unknown) {
  const leftValue = decimalParts(left); const rightValue = decimalParts(right)
  if (!leftValue || !rightValue) return null
  const scale = Math.max(leftValue.scale, rightValue.scale)
  const leftUnits = leftValue.units * 10n ** BigInt(scale - leftValue.scale)
  const rightUnits = rightValue.units * 10n ** BigInt(scale - rightValue.scale)
  if (rightUnits > leftUnits) return null
  return { units: leftUnits - rightUnits, scale }
}

function decimalEquals(value: unknown, expected: { units: bigint; scale: number }) {
  const actual = decimalParts(value)
  if (!actual) return false
  const scale = Math.max(actual.scale, expected.scale)
  return actual.units * 10n ** BigInt(scale - actual.scale) === expected.units * 10n ** BigInt(scale - expected.scale)
}

function decimalParts(value: unknown) {
  if (typeof value !== 'string' || !/^(?:0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]+)?)$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length }
}

function fieldsApplied(state: BridgeExactTradeState, params: Record<string, unknown>, keys: string[], aliases: Record<string, string> = {}) {
  for (const key of keys) {
    const sourceKey = Object.entries(aliases).find(([, target]) => target === key)?.[0] ?? key
    const removeKey = key === 'expiration_utc_msc' ? 'remove_expiration' : `remove_${key}`
    if (params[removeKey] === true && state[key as keyof BridgeExactTradeState] !== null) return false
    if (params[sourceKey] !== undefined && String(state[key as keyof BridgeExactTradeState]) !== String(params[sourceKey])) return false
  }
  return true
}

function resultTickets(result: Record<string, unknown> | null) {
  if (!result) return []
  return ['position_ticket', 'position', 'order_ticket', 'order', 'pending_ticket', 'ticket']
    .map(key => result[key]).filter(value => (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) || (Number.isSafeInteger(value) && Number(value) > 0))
    .map(String)
}
