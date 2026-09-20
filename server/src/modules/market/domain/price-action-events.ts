import { sha256Canonical } from '../../../shared/canonical-json.js'

export interface EventBar { openTime: string; open: string; high: string; low: string; close: string; closed: boolean }
export interface PriceActionEvent {
  id: string
  kind: 'two_closed_bar_breakout' | 'reclaim'
  direction: 'up' | 'down'
  firstBarTime: string
  confirmationBarTime: string
  confirmedAt: string
  referencePrice: string
  confirmationType: 'retest' | 'continuation' | 'hold'
  stillValid: boolean
  invalidationBarTime: string | null
  parentEventId: string | null
  reclaimCloseBeyondBreakoutBars?: boolean
  confirmationCloseBeyondReclaimExtreme?: boolean
}
export interface PriceActionEventScope { sourceAccountId: string; symbol: string; timeframe: string; timeframeMs: number }

/** Versioned objective definitions: 20 reference bars, latest 8 confirmation candidates.
 * Caller validates clock, prices, complete bars and continuity. No strategy admission is implied. */
export function calculatePriceActionEvents(bars: readonly EventBar[], scope: PriceActionEventScope): PriceActionEvent[] {
  const events: PriceActionEvent[] = [], found = new Set<string>()
  const identity = (kind: PriceActionEvent['kind'], direction: PriceActionEvent['direction'], first: EventBar, confirmation: EventBar,
    parentEventId: string | null) => `event:${sha256Canonical({ version: 1, sourceAccountId: scope.sourceAccountId,
      symbol: scope.symbol, timeframe: scope.timeframe, kind, direction, firstBarTime: first.openTime,
      confirmationBarTime: confirmation.openTime, parentEventId })}`
  for (let secondIndex = bars.length - 1; secondIndex >= Math.max(21, bars.length - 8); secondIndex--) {
    const firstIndex = secondIndex - 1, first = bars[firstIndex]!, second = bars[secondIndex]!
    const reference = bars.slice(firstIndex - 20, firstIndex)
    for (const direction of ['up', 'down'] as const) {
      if (found.has(direction)) continue
      const price = direction === 'up' ? Math.max(...reference.map(bar => Number(bar.high))) : Math.min(...reference.map(bar => Number(bar.low)))
      const original = (bar: EventBar) => direction === 'up' ? Number(bar.close) > price : Number(bar.close) < price
      if (!original(first) || !original(second)) continue
      found.add(direction)
      const invalidation = bars.slice(secondIndex + 1).find(bar => !original(bar))
      const event: PriceActionEvent = { id: identity('two_closed_bar_breakout', direction, first, second, null),
        kind: 'two_closed_bar_breakout', direction, firstBarTime: first.openTime, confirmationBarTime: second.openTime,
        confirmedAt: new Date(Date.parse(second.openTime) + scope.timeframeMs).toISOString(), referencePrice: String(price),
        confirmationType: (direction === 'up' ? Number(second.low) <= price : Number(second.high) >= price) ? 'retest' : 'continuation',
        stillValid: !invalidation, invalidationBarTime: invalidation?.openTime ?? null, parentEventId: null }
      events.push(event)
      const reclaimIndex = bars.findIndex((bar, index) => index > secondIndex && !original(bar))
      if (reclaimIndex < 0) continue
      const confirmationIndex = bars.findIndex((bar, index) => index > reclaimIndex && !original(bar))
      if (confirmationIndex < 0) continue
      const reclaim = bars[reclaimIndex]!, confirmation = bars[confirmationIndex]!
      const recoveryDirection = direction === 'up' ? 'down' : 'up'
      const recoveryInvalidation = bars.slice(reclaimIndex + 1).find(original)
      events.push({ id: identity('reclaim', recoveryDirection, reclaim, confirmation, event.id), kind: 'reclaim', direction: recoveryDirection,
        firstBarTime: reclaim.openTime, confirmationBarTime: confirmation.openTime,
        confirmedAt: new Date(Date.parse(confirmation.openTime) + scope.timeframeMs).toISOString(), referencePrice: String(price),
        confirmationType: (direction === 'up' ? Number(confirmation.high) >= price : Number(confirmation.low) <= price) ? 'retest' : 'hold',
        stillValid: !recoveryInvalidation, invalidationBarTime: recoveryInvalidation?.openTime ?? null, parentEventId: event.id,
        reclaimCloseBeyondBreakoutBars: direction === 'up' ? Number(reclaim.close) < Math.min(Number(first.low), Number(second.low))
          : Number(reclaim.close) > Math.max(Number(first.high), Number(second.high)),
        confirmationCloseBeyondReclaimExtreme: direction === 'up' ? Number(confirmation.close) < Number(reclaim.low)
          : Number(confirmation.close) > Number(reclaim.high) })
    }
  }
  return events.sort((a, b) => a.id.localeCompare(b.id))
}
