import type { TerminalDealFact } from './terminal-history-projection.js'

export interface OpenPositionLifecycleInput {
  positionIdentifier: string | null
  symbol: string
  side: 'buy' | 'sell'
  volume: string
  observedAtUtcMsc: number
  deals: readonly TerminalDealFact[]
}

export type OpenPositionLifecycleResult =
  | { status: 'unresolved'; reason: 'identifier_missing' | 'facts_invalid' | 'lifecycle_invalid' | 'snapshot_mismatch' }
  | { status: 'matches_snapshot'; positionIdentifier: string; side: 'buy' | 'sell'; volume: string;
      contributingOrderTickets: string[]; dealTickets: string[] }

/** Quantity reconciliation only. Matching a snapshot is NOT proof of history completeness or strategy ownership. */
export function reconcileOpenPositionLifecycle(input: OpenPositionLifecycleInput): OpenPositionLifecycleResult {
  const value = structuredClone(input)
  const unresolved = (reason: Extract<OpenPositionLifecycleResult, { status: 'unresolved' }>['reason']): OpenPositionLifecycleResult => ({ status: 'unresolved', reason })
  if (value.positionIdentifier === null) return unresolved('identifier_missing')
  const id = (text: unknown): text is string => typeof text === 'string' && /^[1-9]\d{0,19}$/.test(text) && BigInt(text) <= 18446744073709551615n
  const quantity = (text: unknown): bigint | null => {
    if (typeof text !== 'string' || !/^(?:0|[1-9]\d{0,23})(?:\.\d{1,8})?$/.test(text)) return null
    const [whole, fraction = ''] = text.split('.')
    const result = BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'))
    return result > 0n ? result : null
  }
  const expected = quantity(value.volume)
  if (!id(value.positionIdentifier) || !expected || !['buy', 'sell'].includes(value.side)
    || typeof value.symbol !== 'string' || !/^[A-Z0-9._-]{1,64}$/.test(value.symbol)
    || !Number.isSafeInteger(value.observedAtUtcMsc) || value.observedAtUtcMsc <= 0
    || !Array.isArray(value.deals) || value.deals.length === 0 || value.deals.length > 10000) return unresolved('facts_invalid')
  const seen = new Set<string>()
  for (const deal of value.deals) {
    if (!deal || !id(deal.ticket) || seen.has(deal.ticket) || deal.positionId !== value.positionIdentifier
      || !Number.isSafeInteger(deal.occurredAtUtcMsc) || deal.occurredAtUtcMsc <= 0 || deal.occurredAtUtcMsc > value.observedAtUtcMsc) return unresolved('facts_invalid')
    seen.add(deal.ticket)
  }
  const deals = [...value.deals].sort((a, b) => a.occurredAtUtcMsc - b.occurredAtUtcMsc
    || (BigInt(a.ticket) < BigInt(b.ticket) ? -1 : 1))
  let balance = 0n
  const orders = new Set<string>()
  for (const deal of deals) {
    // Explicit fees change money, not exposure. Unknown/correction facts cannot be silently ignored.
    if (deal.dealKind === 'fee' && deal.entryKind === 'none' && deal.side === 'none' && (deal.volume === null || /^0(?:\.0{1,8})?$/.test(deal.volume))) continue
    const amount = quantity(deal.volume)
    if (deal.dealKind !== 'trade' || deal.symbol !== value.symbol || !id(deal.orderTicket) || !amount
      || !['buy', 'sell'].includes(deal.side)) return unresolved('facts_invalid')
    const signed = deal.side === 'buy' ? amount : -amount
    const sameSide = (balance > 0n && signed > 0n) || (balance < 0n && signed < 0n)
    const remaining = balance < 0n ? -balance : balance
    if (deal.entryKind === 'in') {
      if (balance !== 0n && !sameSide) return unresolved('lifecycle_invalid')
      orders.add(deal.orderTicket)
    } else if (deal.entryKind === 'out' || deal.entryKind === 'out_by') {
      if (balance === 0n || sameSide || amount > remaining) return unresolved('lifecycle_invalid')
    } else if (deal.entryKind === 'inout') {
      if (balance === 0n || sameSide || amount <= remaining) return unresolved('lifecycle_invalid')
      orders.clear()
      orders.add(deal.orderTicket)
    } else return unresolved('lifecycle_invalid')
    balance += signed
    if (balance === 0n) orders.clear()
  }
  if (balance !== (value.side === 'buy' ? expected : -expected) || orders.size === 0) return unresolved('snapshot_mismatch')
  return { status: 'matches_snapshot', positionIdentifier: value.positionIdentifier, side: value.side, volume: value.volume,
    contributingOrderTickets: [...orders].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1), dealTickets: deals.map(deal => deal.ticket) }
}
