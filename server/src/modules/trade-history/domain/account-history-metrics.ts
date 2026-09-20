import { projectMt5Position, type TerminalDealFact } from './terminal-history-projection.js'

export function riskAmount(value: string): bigint {
  if (!/^-?(0|[1-9]\d{0,15})(\.\d{1,18})?$/.test(value)) throw Error('risk_amount_invalid')
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  if (/[1-9]/.test(fraction.slice(8))) throw Error('risk_amount_precision')
  return (BigInt(whole!) * 100000000n + BigInt(fraction.slice(0, 8).padEnd(8, '0'))) * (negative ? -1n : 1n)
}
export function riskAmountText(value: bigint) {
  const absolute = value < 0n ? -value : value
  return `${value < 0n ? '-' : ''}${absolute / 100000000n}.${String(absolute % 100000000n).padStart(8, '0')}`
}

/** Cash reconciliation prevents a stale history tail from understating realized risk. */
export function accountHistoryMetrics(input: { facts: TerminalDealFact[]; balance: string; dayStart: number; observed: number;
  positions: ReadonlyArray<{ positionIdentifier: string | null; volume: string }>; lossLimit: number; cooldownMinutes: number }) {
  let cash = 0n, realized = 0n, capital = 0n
  const positions = new Map<string, TerminalDealFact[]>(), tickets = new Set<string>()
  for (const fact of input.facts) {
    if (tickets.has(fact.ticket) || fact.occurredAtUtcMsc > input.observed) throw Error('risk_history_fact_invalid')
    tickets.add(fact.ticket)
    if (!['trade', 'balance', 'fee'].includes(fact.dealKind)) throw Error('risk_history_kind_unresolved')
    const net = [fact.grossProfit, fact.commission, fact.swap, fact.fee].reduce((sum, value) => sum + riskAmount(value), 0n)
    cash += net
    if (fact.occurredAtUtcMsc >= input.dayStart) {
      if (fact.dealKind === 'balance') capital += net
      else realized += net
    }
    if (fact.dealKind === 'trade') {
      if (!fact.positionId || !['in', 'out', 'out_by'].includes(fact.entryKind) || !fact.volume) throw Error('risk_history_position_unresolved')
      positions.set(fact.positionId, [...positions.get(fact.positionId) ?? [], fact])
    } else if (fact.dealKind === 'fee' && fact.positionId) throw Error('risk_history_fee_unresolved')
  }
  if (cash !== riskAmount(input.balance)) throw Error('risk_history_balance_mismatch')
  const closed: Array<{ at: number; net: bigint }> = [], open = new Map<string, bigint>()
  let dailyOpenCount = 0, lastOpen: number | null = null
  for (const [id, facts] of positions) {
    const entries = facts.filter(fact => fact.entryKind === 'in')
    if (!entries.length) throw Error('risk_history_entry_missing')
    const first = Math.min(...entries.map(fact => fact.occurredAtUtcMsc))
    if (first >= input.dayStart) dailyOpenCount++
    lastOpen = Math.max(lastOpen ?? 0, ...entries.map(fact => fact.occurredAtUtcMsc))
    const remaining = facts.reduce((sum, fact) => sum + riskAmount(fact.volume!) * (fact.entryKind === 'in' ? 1n : -1n), 0n)
    if (remaining < 0n) throw Error('risk_history_volume_invalid')
    if (remaining > 0n) open.set(id, remaining)
    else {
      const trade = projectMt5Position(id, facts)
      if (!trade || trade.evidenceStatus === 'conflicted') throw Error('risk_history_close_unresolved')
      closed.push({ at: trade.closedAtUtcMsc, net: riskAmount(trade.netProfit) })
    }
  }
  if (open.size !== input.positions.length) throw Error('risk_history_inventory_mismatch')
  for (const position of input.positions) {
    if (!position.positionIdentifier || open.get(position.positionIdentifier) !== riskAmount(position.volume)) throw Error('risk_history_inventory_mismatch')
    open.delete(position.positionIdentifier)
  }
  closed.sort((a, b) => b.at - a.at)
  // Simultaneous mixed outcomes cannot establish an ordered loss streak.
  for (let i = 1; i < closed.length; i++) if (closed[i]!.at === closed[i - 1]!.at
    && (closed[i]!.net < 0n) !== (closed[i - 1]!.net < 0n)) throw Error('risk_history_loss_order_ambiguous')
  let consecutiveLosses = 0
  for (const trade of closed) { if (trade.net >= 0n) break; consecutiveLosses++ }
  const cooldown = consecutiveLosses >= input.lossLimit && closed.length ? closed[0]!.at + input.cooldownMinutes * 60000 : null
  return { realizedNet: riskAmountText(realized), netCapitalFlow: riskAmountText(capital), dailyOpenCount, consecutiveLosses,
    lastSuccessfulOpenAt: lastOpen === null ? null : new Date(lastOpen).toISOString(),
    cooldownUntil: cooldown !== null && cooldown > input.observed ? new Date(cooldown).toISOString() : null }
}
