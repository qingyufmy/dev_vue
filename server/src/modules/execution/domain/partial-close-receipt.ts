/** Explicit terminal order/deal identities only. A position ticket never substitutes for either. */
export interface CloseReceiptTickets { readonly orderTicket: string; readonly dealTickets: readonly string[] }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function ticket(value: unknown): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,19}$/.test(text) || BigInt(text) > 18446744073709551615n) throw Error('partial_close_result_ticket_invalid')
  return text
}
function aliases(value: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.flatMap(key => value[key] === undefined || value[key] === null ? [] : [ticket(value[key])])
}
function list(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 128) throw Error('partial_close_result_ticket_invalid')
  const values = value.map(ticket)
  if (new Set(values).size !== values.length) throw Error('partial_close_result_ticket_invalid')
  return values
}

export function closeReceiptTickets(result: unknown, positionTicket: string): CloseReceiptTickets | null {
  ticket(positionTicket)
  if (result === null) return null
  if (!object(result)) throw Error('partial_close_result_invalid')
  if (result.already_absent === true) return null
  if (result.raw_result !== undefined && result.raw_result !== null && !object(result.raw_result)) throw Error('partial_close_result_invalid')
  if (result.evidence !== undefined && result.evidence !== null && !object(result.evidence)) throw Error('partial_close_result_invalid')
  const raw = object(result.raw_result) ? result.raw_result : {}
  const evidence = object(result.evidence) ? result.evidence : {}
  if (raw.already_absent === true) return null
  const positions = [...aliases(result,['position_ticket','position']),...aliases(raw,['position_ticket','position']),...list(evidence.position_tickets)]
  if (positions.some(value => value !== positionTicket)) throw Error('partial_close_result_position_mismatch')
  const orders = new Set([...aliases(result,['order_ticket','order']),...aliases(raw,['order_ticket','order']),...list(evidence.order_tickets)])
  if (orders.size > 1) throw Error('partial_close_result_order_ambiguous')
  const explicitDeals = new Set([...aliases(result,['deal_ticket','deal']),...aliases(raw,['deal_ticket','deal'])])
  if (explicitDeals.size > 1) throw Error('partial_close_result_deal_ambiguous')
  const evidenceDeals = list(evidence.deal_tickets)
  if (evidenceDeals.length && [...explicitDeals].some(value => !evidenceDeals.includes(value))) throw Error('partial_close_result_deal_ambiguous')
  const deals = [...new Set([...explicitDeals,...evidenceDeals])]
  if (orders.size === 0 || deals.length === 0) return null
  return { orderTicket:[...orders][0]!,dealTickets:deals.sort((a,b)=>BigInt(a)<BigInt(b)?-1:1) }
}
