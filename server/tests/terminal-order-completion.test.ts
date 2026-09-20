import { expect, it } from 'vitest'
import { terminalOrderCompletion } from '../src/modules/trade-history/domain/terminal-order-completion.js'
import { decodeTerminalHistoryPage, type TerminalOrderFact } from '../src/modules/trade-history/domain/terminal-history-projection.js'
const now = Date.UTC(2026, 8, 9)
function fact(patch: Record<string, unknown> = {}) {
  return decodeTerminalHistoryPage('orders', [{ ticket: '99', symbol: 'XAUUSD.a', type: 'buy_limit', state: 'cancelled',
    setup_at_utc_msc: now - 2000, done_at_utc_msc: now - 1000, ...patch }])[0] as TerminalOrderFact
}
it.each(['filled', 'cancelled', 'rejected', 'expired'])('accepts explicit completion for %s', state => {
  expect(terminalOrderCompletion(fact({ state }), 'mt5', now)).toMatchObject({ state, completedAtUtcMsc: now - 1000 })
})
it.each(['unknown', 'partial', 'partially_filled', 'placed', 'started', 'constructor', '0', '1', '3'])('does not release nonterminal %s', state => {
  expect(terminalOrderCompletion(fact({ state }), 'mt5', now)).toBeNull()
})
it('does not use generic legacy time as proof of completion', () => {
  expect(terminalOrderCompletion(fact({ done_at_utc_msc: undefined, time_utc_msc: now - 1000 }), 'mt5', now)).toBeNull()
})
it('keeps MT5 numeric enums scoped to MT5', () => {
  expect(terminalOrderCompletion(fact({ state: 2 }), 'mt5', now)?.state).toBe('cancelled')
  expect(terminalOrderCompletion(fact({ state: 2 }), 'mt4', now)).toBeNull()
})
it.each([{ done_time_utc_msc: now - 500 }, { done_at_utc_msc: now + 1 }, { done_at_utc_msc: now - 3000 }])('rejects contradictory times %j', patch => {
  expect(() => terminalOrderCompletion(fact(patch), 'mt5', now)).toThrow('trade_history_completion_evidence_invalid')
})
it('rejects changed stored projections and raw evidence', () => {
  expect(() => terminalOrderCompletion({ ...fact(), orderState: 'filled' }, 'mt5', now)).toThrow('trade_history_completion_evidence_invalid')
  expect(() => terminalOrderCompletion({ ...fact(), evidenceHash: '0'.repeat(64) }, 'mt5', now)).toThrow('trade_history_completion_evidence_invalid')
})
