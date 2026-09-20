import { ExecutionError } from './execution.js'

/** Opening order identity only. A market result's bare ticket or position ID is never an order ID. */
export function openingOrderTicket(actionKind: string, result: Record<string, unknown> | null): string | null {
  if (!['market_order','pending_order'].includes(actionKind)) throw new ExecutionError('opening_order_origin_action_invalid',409)
  const keys = actionKind === 'market_order' ? ['order_ticket','order'] : ['pending_ticket','order_ticket','order','ticket']
  const found = new Set<string>()
  for (const key of keys) {
    const value = result?.[key]
    if (value === undefined || value === null) continue
    const ticket = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value
    if (typeof ticket !== 'string' || !/^[1-9]\d{0,19}$/.test(ticket) || BigInt(ticket) > 18446744073709551615n) {
      throw new ExecutionError('opening_order_origin_ticket_invalid',409)
    }
    found.add(ticket)
  }
  if (found.size > 1) throw new ExecutionError('opening_order_origin_ticket_ambiguous',409)
  return [...found][0] ?? null
}
