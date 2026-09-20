type ResourceKind = 'position' | 'pending_order' | 'deal' | 'none' | 'unknown'

/** Terminal identifiers name different resources; a position ID is not a pending order ID. */
export function executionOutcomeReference(
  actionKind: string,
  status: 'succeeded' | 'rejected' | 'failed' | 'uncertain',
  result: Record<string, unknown> | null,
): { resourceKind: ResourceKind; ticket: string | null } {
  if (status !== 'succeeded') return { resourceKind: status === 'uncertain' ? 'unknown' : 'none', ticket: null }
  if (actionKind === 'cancel_order') return { resourceKind: 'none', ticket: null }
  let resourceKind: ResourceKind
  let keys: string[]
  switch (actionKind) {
    case 'pending_order':
    case 'modify_order':
      resourceKind = 'pending_order'
      keys = ['pending_ticket', 'order_ticket', 'order', 'ticket']
      break
    case 'market_order':
    case 'modify_position':
      resourceKind = 'position'
      // A historical MT5 position_id names the stable identifier, not necessarily the live ticket.
      // The current worker's active_position query sets ticket from positions_get().ticket;
      // the same alias on history_order/history_deal has a different meaning.
      keys = ['position_ticket']
      if (result?.found === true && result.complete === true && result.kind === 'trade' && result.current_state === 'active_position') {
        keys.push('ticket')
      }
      break
    case 'close_position':
      resourceKind = 'deal'
      keys = ['deal_ticket', 'deal']
      break
    default:
      return { resourceKind: 'unknown', ticket: null }
  }
  for (const key of keys) {
    const value = result?.[key]
    const ticket = typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n ? value
      : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null
    if (ticket !== null) return { resourceKind, ticket }
  }
  return { resourceKind: 'unknown', ticket: null }
}
