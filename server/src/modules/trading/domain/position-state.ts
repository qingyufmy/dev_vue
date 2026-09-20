import { sha256Canonical } from '../../../shared/canonical-json.js'

/** Display-only changes do not change the executable position state. Every other field is retained. */
export function samePositionState(before: unknown, after: unknown, accountId: string): boolean {
  const project = (value: unknown) => {
    if (!Array.isArray(value) || value.length > 1000) return null
    const tickets = new Set<string>()
    const items = []
    for (const raw of value) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const row = raw as Record<string, unknown>
      if (row.accountId !== accountId || typeof row.ticket !== 'string' || !row.ticket || tickets.has(row.ticket)
        || typeof row.symbol !== 'string' || typeof row.volume !== 'string' || !['buy', 'sell'].includes(String(row.side))) return null
      tickets.add(row.ticket)
      const { currentPrice: _price, floatingProfit: _profit, revision: _revision, ...state } = row
      items.push(state)
    }
    return items.sort((a,b) => String(a.ticket).localeCompare(String(b.ticket)))
  }
  const left = project(before), right = project(after)
  return left !== null && right !== null && sha256Canonical(left) === sha256Canonical(right)
}
