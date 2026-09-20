import { decodeTerminalHistoryPage, projectMt4Trade, projectMt5Position, type AccountTradeProjection, type TerminalDealFact } from './terminal-history-projection.js'

export interface ReviewTradeProjection extends AccountTradeProjection { cashAdjustments: string }
const moneyUnits = (value: string) => {
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.')
  return BigInt(whole! + fraction.padEnd(8, '0')) * (negative ? -1n : 1n)
}
const moneyText = (value: bigint) => {
  const negative = value < 0n, digits = (negative ? -value : value).toString().padStart(9, '0')
  const fraction = digits.slice(-8).replace(/0+$/, '')
  return `${negative ? '-' : ''}${digits.slice(0, -8)}${fraction ? '.' + fraction : ''}`
}

const volumeUnits = (value: string | null): bigint | null => {
  if (value === null || !/^(?:0|[1-9]\d{0,19})(?:\.\d{1,8})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole! + fraction.padEnd(8, '0'))
}

/** Reconstruct closure from original facts; this does not prove that collection found every deal. */
export function reconstructReviewTrade(platform: 'mt4' | 'mt5', positionId: string | null,
  raw: Record<string, unknown>[]): ReviewTradeProjection | null {
  if (!raw.length || raw.length > 1000) return null
  let facts: TerminalDealFact[]
  try { facts = decodeTerminalHistoryPage(platform === 'mt4' ? 'mt4_closed_trades' : 'deals', raw) as TerminalDealFact[] } catch { return null }
  if (new Set(facts.map(fact => fact.ticket)).size !== facts.length) return null
  if (platform === 'mt4') {
    if (facts.length !== 1 || (volumeUnits(facts[0]!.mt4Trade?.volume ?? null) ?? 0n) <= 0n) return null
    const projection = projectMt4Trade(facts[0]!)
    return projection ? { ...projection, cashAdjustments: '0' } : null
  }
  if (!positionId || facts.some(fact => fact.positionId !== positionId || !/^[1-9]\d{0,19}$/.test(fact.ticket))) return null
  const trades = facts.filter(fact => fact.dealKind === 'trade'), adjustments = facts.filter(fact => fact.dealKind !== 'trade')
  if (!trades.length || adjustments.some(fact => !['fee', 'correction'].includes(fact.dealKind) || fact.side !== 'none'
    || (fact.volume !== null && volumeUnits(fact.volume) !== 0n)
    || (fact.symbol !== null && fact.symbol !== trades[0]!.symbol))) return null
  const ordered = [...trades].sort((a, b) => a.occurredAtUtcMsc - b.occurredAtUtcMsc || (BigInt(a.ticket) < BigInt(b.ticket) ? -1 : 1))
  const side = ordered[0]!.side
  if (side !== 'buy' && side !== 'sell') return null
  let balance = 0n
  for (const fact of ordered) {
    const amount = volumeUnits(fact.volume)
    if (amount === null || amount <= 0n) return null
    if (fact.entryKind === 'in' && fact.side === side) balance += amount
    else if ((fact.entryKind === 'out' || fact.entryKind === 'out_by') && fact.side !== side) balance -= amount
    else return null
    if (balance < 0n) return null
  }
  if (balance !== 0n) return null
  const projection = projectMt5Position(positionId, facts)
  if (!projection || adjustments.some(fact => fact.occurredAtUtcMsc < projection.openedAtUtcMsc)) return null
  const adjustment = adjustments.reduce((total, fact) => total + moneyUnits(fact.grossProfit), 0n)
  return { ...projection, cashAdjustments: moneyText(adjustment), netProfit: moneyText(moneyUnits(projection.netProfit) + adjustment) }
}
