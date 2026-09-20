import type { TerminalDealFact } from './terminal-history-projection.js'
import type { TradeAttributionResult } from './trade-history-attribution.js'

/** MT5 explicit order-origin reasons only. Fees/balance and magic/comments cannot prove manual origin. */
export function terminalManualAttribution(facts: TerminalDealFact[]): TradeAttributionResult {
  const unknown: TradeAttributionResult = { source: 'unknown', status: 'unresolved', provenSources: [] }
  if (!facts.length || new Set(facts.map(f => f.ticket)).size !== facts.length) return unknown
  const trades = facts.filter(f => f.dealKind === 'trade')
  if (!trades.length || !trades.some(f => f.entryKind === 'in') || !trades.some(f => ['out', 'out_by'].includes(f.entryKind))) return unknown
  const position = trades[0]!.positionId
  if (!position || facts.some(f => f.positionId !== position)) return unknown
  // A separate precise fee lineage is needed before a fee/correction can share attribution.
  if (facts.length !== trades.length) return unknown
  const manual = new Set(['0', '1', '2', 'client', 'mobile', 'web', 'deal_reason_client', 'deal_reason_mobile', 'deal_reason_web'])
  if (trades.some(f => !manual.has((f.terminalReason ?? '').toLowerCase())
    || !['in', 'out', 'out_by'].includes(f.entryKind))) return unknown
  return { source: 'manual', status: 'exact', provenSources: ['manual'] }
}
