import type { BridgeCommand } from './bridge-command.js'

function ticket(value: unknown): string | null {
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) return value
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null
}

/** A lookup hint for the original target, never evidence of successful execution. */
export function bridgeReconciliationTicket(command: BridgeCommand, result: Record<string, unknown> | null): string | null {
  const params = command.request.payload.params
  if (command.action !== 'order.place') return ticket(params.ticket)
  const keys = params.order_type === 'market'
    ? ['position_ticket', 'position_id', 'position']
    : ['pending_ticket', 'order_ticket', 'order']
  const values = keys.map(key => ticket(result?.[key])).filter((value): value is string => value !== null)
  const unique = new Set(values)
  // Conflicting resource aliases cannot be resolved by their field order.
  if (unique.size > 1) return null
  if (unique.size === 1) return values[0]!
  return ticket(result?.ticket)
}
