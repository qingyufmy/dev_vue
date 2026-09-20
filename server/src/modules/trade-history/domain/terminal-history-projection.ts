import { createHash } from 'node:crypto'
import { combineMoneyCurrencies, recordMoneyCurrency, type TradeMoneyCurrency } from './trade-money-currency.js'

export interface TerminalHistoryContext {
  accountId: string
  userId: number
  platform: 'mt4' | 'mt5'
  timezoneOffsetMinutes: number
  observedAtUtcMsc: number
  sourceRevision: string
}

export interface TerminalOrderFact {
  kind: 'order'
  ticket: string
  positionId: string | null
  symbol: string | null
  side: 'buy' | 'sell' | 'none' | 'unknown'
  orderKind: string
  orderState: string
  volumeInitial: string | null
  volumeRemaining: string | null
  priceOpen: string | null
  stopLoss: string | null
  takeProfit: string | null
  magic: string | null
  terminalReason: string | null
  terminalComment: string | null
  setupAtUtcMsc: number | null
  doneAtUtcMsc: number | null
  evidenceHash: string
  evidenceJson: string
}

export interface TerminalDealFact extends TradeMoneyCurrency {
  kind: 'deal'
  ticket: string
  orderTicket: string | null
  positionId: string | null
  symbol: string | null
  dealKind: 'trade' | 'balance' | 'credit' | 'fee' | 'correction' | 'other' | 'unknown'
  entryKind: 'in' | 'out' | 'inout' | 'out_by' | 'none' | 'unknown'
  side: 'buy' | 'sell' | 'none' | 'unknown'
  volume: string | null
  price: string | null
  grossProfit: string
  commission: string
  swap: string
  fee: string
  magic: string | null
  terminalReason: string | null
  terminalComment: string | null
  occurredAtUtcMsc: number
  evidenceHash: string
  evidenceJson: string
  mt4Trade?: Mt4ClosedTrade
}

export interface Mt4ClosedTrade {
  stableKey: string
  primaryTicket: string
  positionId: string | null
  symbol: string
  side: 'buy' | 'sell'
  volume: string
  entryPrice: string
  exitPrice: string
  stopLoss: string | null
  takeProfit: string | null
  grossProfit: string
  commission: string
  swap: string
  fee: string
  openedAtUtcMsc: number
  closedAtUtcMsc: number
}

export type TerminalHistoryFact = TerminalOrderFact | TerminalDealFact

export interface AccountTradeProjection extends TradeMoneyCurrency {
  stableKey: string
  primaryTicket: string
  positionId: string | null
  symbol: string
  side: 'buy' | 'sell'
  volumeOpened: string
  volumeClosed: string
  entryPrice: string
  exitPrice: string
  stopLoss: string | null
  takeProfit: string | null
  grossProfit: string
  commission: string
  swap: string
  fee: string
  netProfit: string
  openedAtUtcMsc: number
  closedAtUtcMsc: number
  evidenceHash: string
  evidenceStatus: 'complete' | 'partial' | 'conflicted'
  dealTickets: Array<{ ticket: string; role: 'entry' | 'exit' | 'fee' | 'adjustment' | 'unknown' }>
}

export type TerminalHistoryPageKind = 'orders' | 'mt4_closed_trades' | 'deals'

export function decodeTerminalHistoryPage(kind: TerminalHistoryPageKind, items: Record<string, unknown>[]): TerminalHistoryFact[] {
  const facts = items.map(item => kind === 'orders' ? order(item) : kind === 'mt4_closed_trades' ? mt4Trade(item) : deal(item))
  const hashes = new Map<string, string>()
  for (const fact of facts) {
    const key = `${fact.kind}:${fact.ticket}`
    const known = hashes.get(key)
    if (known && known !== fact.evidenceHash) throw new Error('trade_history_fact_conflict')
    hashes.set(key, fact.evidenceHash)
  }
  return facts
}

export function canonicalEvidence(value: Record<string, unknown>) {
  const json = JSON.stringify(canonical(value))
  return { json, hash: createHash('sha256').update(json).digest('hex') }
}

export function projectMt5Position(positionId: string, facts: TerminalDealFact[]): AccountTradeProjection | null {
  const trades = facts.filter(fact => fact.dealKind === 'trade' && fact.positionId === positionId)
    .sort((left, right) => left.occurredAtUtcMsc - right.occurredAtUtcMsc || left.ticket.localeCompare(right.ticket))
  if (!trades.length || trades.some(fact => ['inout', 'none', 'unknown'].includes(fact.entryKind))) return null
  const entries = trades.filter(fact => fact.entryKind === 'in')
  const exits = trades.filter(fact => fact.entryKind === 'out' || fact.entryKind === 'out_by')
  if (!entries.length || !exits.length || entries.some(essentialMissing) || exits.some(essentialMissing)) return null
  const symbols = new Set(trades.map(fact => fact.symbol)); const sides = new Set(entries.map(fact => fact.side))
  if (symbols.size !== 1 || sides.size !== 1) return null
  const symbol = entries[0]!.symbol!; const tradeSide = entries[0]!.side
  if (tradeSide !== 'buy' && tradeSide !== 'sell') return null
  const opened = sum(entries.map(fact => fact.volume!)); const closed = sum(exits.map(fact => fact.volume!))
  if (compare(closed, opened) !== 0) return null
  const grossProfit = sum(trades.map(fact => fact.grossProfit)); const commission = sum(facts.map(fact => fact.commission))
  const swap = sum(facts.map(fact => fact.swap)); const fee = sum(facts.map(fact => fact.fee))
  const currency = combineMoneyCurrencies(facts)
  return {
    accountCurrency: currency.accountCurrency, currencyEvidence: currency.currencyEvidence,
    stableKey: `mt5:position:${positionId}`, primaryTicket: positionId, positionId, symbol, side: tradeSide,
    volumeOpened: opened, volumeClosed: closed, entryPrice: weighted(entries), exitPrice: weighted(exits), stopLoss: null, takeProfit: null,
    grossProfit, commission, swap, fee, netProfit: sum([grossProfit, commission, swap, fee]),
    openedAtUtcMsc: entries[0]!.occurredAtUtcMsc, closedAtUtcMsc: exits.at(-1)!.occurredAtUtcMsc,
    evidenceHash: createHash('sha256').update(facts.map(fact => fact.evidenceHash).sort().join('|')).digest('hex'), evidenceStatus: currency.conflicting ? 'conflicted' : 'complete',
    dealTickets: facts.map(fact => ({ ticket: fact.ticket, role: fact.dealKind === 'trade' ? (fact.entryKind === 'in' ? 'entry' : 'exit') : 'fee' })),
  }
}

export function projectMt4Trade(fact: TerminalDealFact): AccountTradeProjection | null {
  const trade = fact.mt4Trade
  if (!trade) return null
  return { ...trade, volumeOpened: trade.volume, volumeClosed: trade.volume,
    accountCurrency: fact.accountCurrency, currencyEvidence: fact.currencyEvidence,
    netProfit: sum([trade.grossProfit, trade.commission, trade.swap, trade.fee]), evidenceHash: fact.evidenceHash,
    evidenceStatus: 'complete', dealTickets: [{ ticket: fact.ticket, role: 'exit' }] }
}

function order(value: Record<string, unknown>): TerminalOrderFact {
  const evidence = canonicalEvidence(value)
  return {
    kind: 'order', ticket: id(value, ['order_ticket', 'ticket']), positionId: nullableId(value, ['position_id', 'position_ticket']),
    symbol: text(value.symbol, 64), side: side(value.side ?? value.direction ?? value.type),
    orderKind: token(value.order_kind ?? value.order_type ?? value.type, 'unknown'),
    orderState: token(value.order_state ?? value.state, 'unknown'),
    volumeInitial: decimal(value.volume_initial ?? value.volume ?? value.lots),
    volumeRemaining: decimal(value.volume_remaining ?? value.volume_current), priceOpen: decimal(value.price_open ?? value.open_price ?? value.price),
    stopLoss: decimal(value.stop_loss ?? value.sl), takeProfit: decimal(value.take_profit ?? value.tp), magic: integerText(value.magic),
    terminalReason: boundedText(value.reason, 32), terminalComment: boundedText(value.comment, 512),
    setupAtUtcMsc: time(value.setup_at_utc_msc ?? value.setup_time_utc_msc ?? value.open_time_utc_msc, true),
    doneAtUtcMsc: time(value.done_at_utc_msc ?? value.done_time_utc_msc ?? value.close_time_utc_msc ?? value.time_utc_msc, true),
    evidenceHash: evidence.hash, evidenceJson: evidence.json,
  }
}

function deal(value: Record<string, unknown>): TerminalDealFact {
  const evidence = canonicalEvidence(value)
  const dealType = value.deal_kind ?? value.type
  return {
    kind: 'deal', ...recordMoneyCurrency(value), ticket: id(value, ['deal_ticket', 'ticket']), orderTicket: nullableId(value, ['order_ticket', 'order']),
    positionId: nullableId(value, ['position_id', 'position_ticket']), symbol: text(value.symbol, 64),
    dealKind: dealKind(dealType), entryKind: entry(value.entry_kind ?? value.entry), side: side(value.side ?? value.direction ?? dealType),
    volume: decimal(value.volume ?? value.lots), price: decimal(value.price ?? value.deal_price),
    grossProfit: decimal(value.profit) ?? '0', commission: decimal(value.commission) ?? '0', swap: decimal(value.swap) ?? '0', fee: decimal(value.fee) ?? '0',
    magic: integerText(value.magic), terminalReason: boundedText(value.reason, 32), terminalComment: boundedText(value.comment, 512),
    occurredAtUtcMsc: requiredTime(value.time_utc_msc ?? value.time_msc), evidenceHash: evidence.hash, evidenceJson: evidence.json,
  }
}

function mt4Trade(value: Record<string, unknown>): TerminalDealFact {
  const evidence = canonicalEvidence(value)
  const ticket = id(value, ['ticket', 'order_ticket', 'order'])
  const closeTicket = nullableId(value, ['close_deal_ticket', 'deal_ticket']) ?? ticket
  const closedAt = requiredTime(value.close_time_utc_msc ?? value.time_utc_msc ?? value.time_msc)
  const openedAt = requiredTime(value.open_time_utc_msc ?? value.setup_time_utc_msc)
  const tradeSide = side(value.side ?? value.direction ?? value.type)
  const symbol = requiredText(value.symbol, 64, 'trade_history_symbol_invalid')
  const volume = requiredDecimal(value.volume ?? value.lots, 'trade_history_volume_invalid')
  const entryPrice = requiredDecimal(value.open_price ?? value.price_open, 'trade_history_entry_price_invalid')
  const exitPrice = requiredDecimal(value.close_price ?? value.price_close ?? value.price, 'trade_history_exit_price_invalid')
  if (tradeSide !== 'buy' && tradeSide !== 'sell') throw new Error('trade_history_side_invalid')
  if (closedAt < openedAt) throw new Error('trade_history_time_order_invalid')
  const grossProfit = decimal(value.profit) ?? '0'; const commission = decimal(value.commission) ?? '0'
  const swap = decimal(value.swap) ?? '0'; const fee = decimal(value.fee) ?? '0'
  return {
    kind: 'deal', ...recordMoneyCurrency(value), ticket: closeTicket, orderTicket: ticket, positionId: nullableId(value, ['position_id', 'position_ticket']) ?? ticket,
    symbol, dealKind: 'trade', entryKind: 'out', side: tradeSide === 'buy' ? 'sell' : 'buy', volume, price: exitPrice,
    grossProfit, commission, swap, fee, magic: integerText(value.magic), terminalReason: boundedText(value.reason, 32), terminalComment: boundedText(value.comment, 512),
    occurredAtUtcMsc: closedAt, evidenceHash: evidence.hash, evidenceJson: evidence.json,
    mt4Trade: { stableKey: `mt4:ticket:${ticket}`, primaryTicket: ticket, positionId: nullableId(value, ['position_id', 'position_ticket']), symbol,
      side: tradeSide, volume, entryPrice, exitPrice, stopLoss: decimal(value.stop_loss ?? value.sl), takeProfit: decimal(value.take_profit ?? value.tp),
      grossProfit, commission, swap, fee, openedAtUtcMsc: openedAt, closedAtUtcMsc: closedAt },
  }
}

function dealKind(value: unknown): TerminalDealFact['dealKind'] {
  const normalized = String(value ?? '').toLowerCase()
  if (['0', '1', 'buy', 'sell', 'trade'].includes(normalized)) return 'trade'
  if (['2', 'balance'].includes(normalized)) return 'balance'
  if (['3', 'credit'].includes(normalized)) return 'credit'
  if (['4', 'charge', 'fee', '7', '8', '9', '10', '11'].includes(normalized)) return 'fee'
  if (['5', 'correction'].includes(normalized)) return 'correction'
  if (normalized) return 'other'
  return 'unknown'
}
function entry(value: unknown): TerminalDealFact['entryKind'] {
  const normalized = String(value ?? '').toLowerCase()
  return ({ '0': 'in', '1': 'out', '2': 'inout', '3': 'out_by', in: 'in', out: 'out', inout: 'inout', out_by: 'out_by' } as Record<string, TerminalDealFact['entryKind']>)[normalized] ?? (normalized ? 'unknown' : 'none')
}
function side(value: unknown): TerminalDealFact['side'] {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized === '0' || normalized === 'buy') return 'buy'
  if (normalized === '1' || normalized === 'sell') return 'sell'
  if (['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'balance', 'credit', 'fee', 'none'].includes(normalized)) return 'none'
  return 'unknown'
}
function id(value: Record<string, unknown>, fields: string[]) { const result = nullableId(value, fields); if (!result) throw new Error('trade_history_ticket_invalid'); return result }
function nullableId(value: Record<string, unknown>, fields: string[]) { for (const field of fields) { const current = value[field]; if (current !== null && current !== undefined && String(current).trim()) { const result = String(current).trim(); if (!/^[A-Za-z0-9._:-]{1,64}$/.test(result)) throw new Error('trade_history_ticket_invalid'); return result } } return null }
function decimal(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  let result: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('trade_history_decimal_invalid')
    result = value.toFixed(8).replace(/(?:\.0+|(?<=[0-9])0+)$/, '').replace(/\.$/, '')
    if (result === '-0') result = '0'
  } else result = String(value)
  if (!/^-?\d{1,24}(?:\.\d{1,8})?$/.test(result)) throw new Error('trade_history_decimal_invalid')
  return result
}
function requiredDecimal(value: unknown, code: string) { try { const result = decimal(value); if (!result) throw new Error(code); return result } catch { throw new Error(code) } }
function integerText(value: unknown) { if (value === null || value === undefined || value === '') return null; const result = String(value); if (!/^-?\d{1,19}$/.test(result)) throw new Error('trade_history_integer_invalid'); return result }
function text(value: unknown, maximum: number) { if (value === null || value === undefined || value === '') return null; const result = String(value); if (result.length > maximum) throw new Error('trade_history_text_invalid'); return result }
function boundedText(value: unknown, maximum: number) { if (value === null || value === undefined || value === '') return null; return String(value).slice(0, maximum) }
function requiredText(value: unknown, maximum: number, code: string) { const result = text(value, maximum); if (!result) throw new Error(code); return result }
function token(value: unknown, fallback: string) { const result = String(value ?? '').trim().toLowerCase(); if (!result) return fallback; return /^[a-z0-9._-]{1,32}$/.test(result) ? result : fallback }
function time(value: unknown, optional: boolean) { if (value === null || value === undefined || value === '') { if (optional) return null; throw new Error('trade_history_time_invalid') } const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error('trade_history_time_invalid'); return number }
function requiredTime(value: unknown) { return time(value, false)! }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])); return value }

function essentialMissing(fact: TerminalDealFact) { return !fact.symbol || !fact.volume || !fact.price || (fact.side !== 'buy' && fact.side !== 'sell') }
function scaled(value: string) { const [whole, fraction = ''] = value.split('.'); const sign = whole!.startsWith('-') ? -1n : 1n; return sign * BigInt(whole!.replace('-', '') + fraction.padEnd(8, '0')) }
function formatted(value: bigint) { const sign = value < 0 ? '-' : ''; const digits = (value < 0 ? -value : value).toString().padStart(9, '0'); const fraction = digits.slice(-8).replace(/0+$/, ''); return `${sign}${digits.slice(0, -8)}${fraction ? `.${fraction}` : ''}` }
function sum(values: string[]) { return formatted(values.reduce((total, value) => total + scaled(value), 0n)) }
function compare(left: string, right: string) { const delta = scaled(left) - scaled(right); return delta < 0 ? -1 : delta > 0 ? 1 : 0 }
function weighted(facts: TerminalDealFact[]) { const numerator = facts.reduce((total, fact) => total + scaled(fact.price!) * scaled(fact.volume!), 0n); const volume = facts.reduce((total, fact) => total + scaled(fact.volume!), 0n); if (volume <= 0n) throw new Error('trade_history_volume_invalid'); return formatted(numerator / volume) }
