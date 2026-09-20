import { canonicalEvidence, decodeTerminalHistoryPage, type TerminalOrderFact } from './terminal-history-projection.js'

export type TerminalOrderCompletionState = 'filled' | 'cancelled' | 'rejected' | 'expired'
const terminalStates: Record<string, TerminalOrderCompletionState> = {
  filled: 'filled', cancelled: 'cancelled', rejected: 'rejected', expired: 'expired',
  '2': 'cancelled', '4': 'filled', '5': 'rejected', '6': 'expired',
}

/** Only a fact-level terminal claim, not route authorization or permission to release a command.
 * Legacy generic timestamps may have fallen back to setup time and cannot prove completion. */
export function terminalOrderCompletion(fact: TerminalOrderFact, platform: 'mt4' | 'mt5', observedAtUtcMsc: number): {
  state: TerminalOrderCompletionState; completedAtUtcMsc: number; factHash: string
} | null {
  if (!Number.isSafeInteger(observedAtUtcMsc) || observedAtUtcMsc <= 0) throw Error('trade_history_completion_evidence_invalid')
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fact.evidenceJson) as Record<string, unknown>
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw Error('shape')
    if (canonicalEvidence(raw).hash !== fact.evidenceHash
      || canonicalEvidence({ ...decodeTerminalHistoryPage('orders', [raw])[0]! }).hash !== canonicalEvidence({ ...fact }).hash) throw Error('fact')
  } catch { throw Error('trade_history_completion_evidence_invalid') }
  // Numeric enums here are MT5 enums; do not apply them to MT4 raw values.
  const state = (/^[0-9]+$/.test(fact.orderState) && platform !== 'mt5') || !Object.hasOwn(terminalStates, fact.orderState)
    ? undefined : terminalStates[fact.orderState]
  if (!state) return null
  const values = [raw.done_at_utc_msc, raw.done_time_utc_msc, raw.close_time_utc_msc].filter(value => value !== undefined && value !== null)
  if (values.length === 0) return null
  if (values.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    || values.some(value => value !== values[0])) throw Error('trade_history_completion_evidence_invalid')
  const completed = values[0] as number
  if (completed > observedAtUtcMsc || (fact.setupAtUtcMsc !== null && completed < fact.setupAtUtcMsc)) {
    throw Error('trade_history_completion_evidence_invalid')
  }
  return { state, completedAtUtcMsc: completed, factHash: fact.evidenceHash }
}
